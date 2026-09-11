import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getHttpNotificationCatalog,
  listHttpNotificationPins,
  presentHttpNotificationResult,
  selectHttpNotificationPin,
} from "./core-http-notification-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
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

const CONNECTION_ID = "77777777-7777-4777-8777-777777777777";
const VERSION_ID = "88888888-8888-4888-8888-888888888888";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

function withSession() {
  setActiveSession({
    issuer: "https://flowforge.local",
    subject: "operator-chloe",
    displayName: "Chloe",
    sessionId: "sess-1",
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    csrfToken: "csrf-ok",
  });
}

describe("core HTTP/notification client", () => {
  it("reads GET /http/catalog first", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          isolation: { tlsVerificationRequired: true, ssrfDenied: true },
          integrationGate: { enabled: true, nodes: ["http.request"] },
          nodes: [
            {
              type: "http.request",
              title: "HTTP request",
              requiredWith: ["connectionId"],
              enabled: true,
              allowedWith: [{ name: "connectionId", kind: "uuid", required: true }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await getHttpNotificationCatalog(identity);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.catalog.source, "http-catalog");
      assert.equal(result.catalog.nodes[0]?.title, "HTTP request");
    }
    assert.equal(seen[0], "/api/v1/http/catalog");
  });

  it("falls back to GET /ops-config/catalog httpNotificationEngine", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      const url = String(input);
      if (url.includes("/http/catalog")) {
        return new Response("missing", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          kinds: [{ kind: "connection", collection: "connections" }],
          httpNotificationEngine: {
            nodes: [
              {
                type: "http.request",
                title: "Call API",
                requiredWith: ["connectionId"],
                allowedWith: [{ name: "connectionId", kind: "uuid", required: true }],
              },
            ],
            integrationGate: { enabled: true },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await getHttpNotificationCatalog(identity);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.catalog.source, "ops-config-catalog");
      assert.equal(result.catalog.nodes[0]?.title, "Call API");
    }
    assert.equal(seen[0], "/api/v1/http/catalog");
    assert.equal(seen[1], "/api/v1/ops-config/catalog");
  });

  it("fails closed when catalogs are empty — no invented HTTP nodes", async () => {
    withSession();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (
        url.includes("/http/catalog") ||
        url.includes("/ops-config/catalog") ||
        url.includes("/workflows/catalog")
      ) {
        return new Response(JSON.stringify({ kinds: [], nodes: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await getHttpNotificationCatalog(identity);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.catalog.source, "unavailable");
      assert.match(result.catalog.notes ?? "", /fails closed/i);
      assert.deepEqual(result.catalog.nodes, []);
    }
  });

  it("lists published connections and fail-closes 403", async () => {
    withSession();
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "not authorized",
          instance: "/connections",
          code: "forbidden",
          request_id: "r-403",
        }),
        { status: 403, headers: { "Content-Type": "application/problem+json" } },
      );
    }) as typeof fetch;

    const result = await listHttpNotificationPins(identity, "connection");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
    }
  });

  it("POSTs select with CSRF and never keeps leaked secrets", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          kind: "connection",
          resourceId: CONNECTION_ID,
          versionId: VERSION_ID,
          versionNumber: 2,
          digest: "sha256:pin",
          name: "status-api",
          secret: "should-not-exist",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await selectHttpNotificationPin(
      identity,
      "connection",
      CONNECTION_ID,
      VERSION_ID,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.pin.resourceId, CONNECTION_ID);
      assert.equal(result.pin.versionId, VERSION_ID);
      assert.equal("secret" in result.pin, false);
    }
    assert.equal(seen.url, `/api/v1/connections/${CONNECTION_ID}/select`);
    assert.equal(seen.init?.method, "POST");
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.equal(body.versionId, VERSION_ID);
    assert.equal("secret" in body, false);
  });

  it("presents redacted delivery results", () => {
    const shown = presentHttpNotificationResult({
      status: 204,
      authorization: "Bearer leaked",
      "set-cookie": "sid=1",
      ok: true,
    }) as Record<string, unknown>;
    assert.equal(shown.status, 204);
    assert.equal(shown.ok, true);
    assert.equal("authorization" in shown, false);
    assert.equal("set-cookie" in shown, false);
  });
});
