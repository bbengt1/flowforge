import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import {
  endSession,
  establishSession,
  loadCurrentSession,
  refreshSession,
} from "./session-client.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, getSessionSnapshot, setActiveSession } from "./session-store.ts";
import type { BrowserSession } from "./session.ts";

const originalFetch = globalThis.fetch;

const active: BrowserSession = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  sessionId: "sess-1",
  idleExpiresAt: "2026-09-08T21:00:00.000Z",
  absoluteExpiresAt: "2026-09-09T07:00:00.000Z",
  csrfToken: "csrf-ok",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("session-client", () => {
  it("POSTs issuer/external_subject to /api/v1/session and stores the snapshot", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-1",
            idle_expires_at: "2026-09-08T21:00:00.000Z",
            absolute_expires_at: "2026-09-09T07:00:00.000Z",
          },
          principal: {
            issuer: "https://flowforge.local",
            external_subject: "operator-chloe",
            display_name: "Chloe (dev)",
          },
          csrf_token: "csrf-login",
        }),
        {
          status: 201,
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
    assert.equal(seen.url, "/api/v1/session");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.credentials, "include");
    assert.match(String(seen.init?.body), /external_subject/);
    assert.doesNotMatch(String(seen.init?.body), /"subject":/);
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.session.subject, "operator-chloe");
    assert.equal(snapshot.session.idleExpiresAt, "2026-09-08T21:00:00.000Z");
    assert.equal(snapshot.session.csrfToken, "csrf-header");
    assert.equal(snapshot.embedChrome, null);
    assert.equal(JSON.stringify(seen.init?.body).includes("Bearer"), false);
  });

  it("GET /session stores embed chrome from session.embed only", async () => {
    globalThis.fetch = (async (input) => {
      assert.equal(String(input), "/api/v1/session");
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-embed",
            idle_expires_at: "2026-09-08T21:00:00.000Z",
            absolute_expires_at: "2026-09-09T07:00:00.000Z",
            embed: {
              mode: "embed",
              sdk: "embed.v1",
              tenantId: "ten-1",
              tenantSlug: "acme",
              tenantName: "Acme",
              workbenchKey: "ops",
              workspaceId: "ws-1",
              workspaceName: "Ops",
              capabilities: ["workflow.view"],
            },
          },
          principal: {
            issuer: "https://idp.example",
            external_subject: "ada",
            display_name: "Ada",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await loadCurrentSession();
    assert.equal(result.ok, true);
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.embedChrome?.source, "get-session");
    assert.equal(snapshot.embedChrome?.mode, "embed");
    assert.equal(snapshot.embedChrome?.tenantId, "ten-1");
    assert.equal(snapshot.embedChrome?.tenantSlug, "acme");
    assert.equal(snapshot.embedChrome?.tenantName, "Acme");
    assert.equal(snapshot.embedChrome?.workbenchKey, "ops");
    assert.equal(snapshot.embedChrome?.workspaceName, "Ops");
    assert.equal(snapshot.embedChrome?.displayName, "Ada");
    assert.deepEqual(snapshot.embedChrome?.capabilities, ["workflow.view"]);
  });

  it("GET /session marks a previously active session stale on 401", async () => {
    setActiveSession(active, {
      source: "get-session",
      mode: "embed",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      tenantName: "Acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view"],
      displayName: "Chloe",
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

    const result = await loadCurrentSession();
    assert.equal(result.ok, false);
    assert.equal(getSessionSnapshot().stale, true);
    assert.equal(getSessionSnapshot().active, false);
    assert.equal(getSessionSnapshot().embedChrome, null);
  });

  it("POST /session/refresh and /session/logout send CSRF", async () => {
    setActiveSession(active);
    const seen: { url?: string; headers?: Headers; method?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.headers = new Headers(init?.headers);
      seen.method = init?.method;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const logout = await endSession();
    assert.equal(logout.ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/v1/session/logout");
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.equal(getSessionSnapshot().active, false);

    setActiveSession(active);
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.headers = new Headers(init?.headers);
      seen.method = init?.method;
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-1",
            idle_expires_at: "2026-09-08T21:30:00.000Z",
            absolute_expires_at: "2026-09-09T07:00:00.000Z",
          },
          principal: {
            issuer: "https://flowforge.local",
            external_subject: "operator-chloe",
          },
          csrf_token: "csrf-rotated",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const refreshed = await refreshSession();
    assert.equal(refreshed.ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/v1/session/refresh");
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.equal(getSessionSnapshot().session.idleExpiresAt, "2026-09-08T21:30:00.000Z");
    assert.equal(getSessionSnapshot().session.csrfToken, "csrf-rotated");
  });
});
