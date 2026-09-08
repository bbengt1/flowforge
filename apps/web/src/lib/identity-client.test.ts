import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { callIdentityProxy } from "./identity-client.ts";
import {
  FLOWFORGE_ISSUER_HEADER,
  FLOWFORGE_SUBJECT_HEADER,
  FLOWFORGE_TENANT_SLUG_HEADER,
  FLOWFORGE_WORKBENCH_KEY_HEADER,
  type DevIdentity,
} from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import { setHeaderFallback } from "./header-fallback.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
  setHeaderFallback(false);
});

describe("callIdentityProxy session alignment", () => {
  it("uses credentials include on the same-origin proxy and omits subject headers when a session is active", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: "2026-09-08T21:00:00.000Z",
      absoluteExpiresAt: "2026-09-09T07:00:00.000Z",
      csrfToken: "csrf-from-memory",
    });
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await callIdentityProxy("/workspaces", identity);
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/workspaces");
    assert.equal(seen.init?.credentials, "include");
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(FLOWFORGE_ISSUER_HEADER), null);
    assert.equal(headers.get(FLOWFORGE_SUBJECT_HEADER), null);
    assert.equal(headers.get(FLOWFORGE_TENANT_SLUG_HEADER), "acme");
    assert.equal(headers.get(FLOWFORGE_WORKBENCH_KEY_HEADER), "ops");
    assert.equal(headers.get("Authorization"), null);
  });

  it("attaches CSRF on mutations and fail-closes locally when the session has no token", async () => {
    let fetched = false;
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "",
    });
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const missing = await callIdentityProxy("/tenants", identity, {
      method: "POST",
      body: { slug: "acme", name: "Acme" },
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.problem.code, "csrf-required");
      assert.equal(missing.statusCode, 403);
    }
    assert.equal(fetched, false);

    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "csrf-ok",
    });
    const seen: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      seen.headers = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const sent = await callIdentityProxy("/tenants", identity, {
      method: "POST",
      body: { slug: "acme", name: "Acme" },
    });
    assert.equal(sent.ok, true);
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
  });

  it("maps 401 unauthenticated to a stale session and never uses localStorage", async () => {
    const writes: string[] = [];
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          return null;
        },
        setItem(key: string) {
          writes.push(key);
        },
        removeItem() {},
      },
    });

    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: "2026-09-08T21:00:00.000Z",
      absoluteExpiresAt: "2026-09-09T07:00:00.000Z",
      csrfToken: "csrf-ok",
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:unauthenticated",
          title: "Unauthenticated",
          status: 401,
          detail: "Authentication is required.",
          instance: "/api/v1/workspaces",
          code: "unauthenticated",
          request_id: "stale-request-16x",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "stale-request-16x",
          },
        },
      )) as typeof fetch;

    const result = await callIdentityProxy("/workspaces", identity);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "unauthenticated");
      assert.equal(result.problem.request_id, "stale-request-16x");
    }
    const { getSessionSnapshot } = await import("./session-store.ts");
    assert.equal(getSessionSnapshot().stale, true);
    assert.equal(getSessionSnapshot().active, false);
    assert.deepEqual(writes, []);

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  });

  it("rejects absolute API URLs so credentialed CORS is not used", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const result = await callIdentityProxy(
      "https://api.example.test/api/v1/session",
      identity,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "invalid-request");
    }
    assert.equal(fetched, false);
  });
});
