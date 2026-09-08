import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import {
  endSession,
  establishSession,
  refreshSession,
} from "./session-client.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, getSessionSnapshot, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("session-client", () => {
  it("POSTs bootstrap identity to the same-origin session proxy and stores the snapshot in memory", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          issuer: "https://flowforge.local",
          subject: "operator-chloe",
          display_name: "Chloe (dev)",
          expires_at: "2026-09-08T21:00:00.000Z",
          csrf_token: "csrf-login",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            [CSRF_HEADER]: "csrf-header",
          },
        },
      );
    }) as typeof fetch;

    const result = await establishSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe (dev)",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/control-plane/session");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.credentials, "include");
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.session.subject, "operator-chloe");
    assert.equal(snapshot.session.csrfToken, "csrf-header");
    assert.equal(JSON.stringify(seen.init?.body).includes("Bearer"), false);
  });

  it("GET refresh marks a previously active session stale on 401", async () => {
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      expiresAt: "2026-09-08T21:00:00.000Z",
      csrfToken: "csrf-ok",
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:unauthenticated",
          title: "Unauthenticated",
          status: 401,
          detail: "Authentication is required.",
          instance: "/api/v1/session",
          code: "unauthenticated",
          request_id: "refresh-request16",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "refresh-request16",
          },
        },
      )) as typeof fetch;

    const result = await refreshSession();
    assert.equal(result.ok, false);
    assert.equal(getSessionSnapshot().stale, true);
    assert.equal(getSessionSnapshot().active, false);
  });

  it("DELETE logout sends CSRF and clears memory state", async () => {
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      expiresAt: null,
      csrfToken: "csrf-ok",
    });
    const seen: { headers?: Headers; method?: string } = {};
    globalThis.fetch = (async (_input, init) => {
      seen.headers = new Headers(init?.headers);
      seen.method = init?.method;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await endSession();
    assert.equal(result.ok, true);
    assert.equal(seen.method, "DELETE");
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.equal(getSessionSnapshot().active, false);
    assert.equal(getSessionSnapshot().session.csrfToken, "");
  });
});
