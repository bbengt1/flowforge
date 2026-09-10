import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EMBED_ASSERTION_MESSAGE_TYPE } from "./embed-contract.ts";
import {
  deliverPortalAssertion,
  emptyPortalAssertionHolder,
  fetchPortalAdapter,
  mintPortalAssertion,
} from "./portal-embed-client.ts";
import { portalEntryRbac } from "./portal-adapter-contract.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;
const SAMPLE_JWS = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("portal-embed-client", () => {
  it("refuses to mint when Portal entry RBAC is denied", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await mintPortalAssertion(portalEntryRbac("denied"), {
      portalRoles: ["portal.viewer"],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.match(result.problem.detail, /Portal entry is denied/);
    }
    assert.equal(called, false);
  });

  it("POSTs {portalRoles} to /portal/adapter/assertions", async () => {
    const seen: { url?: string; body?: string; csrf?: string | null } = {};
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: "2026-09-09T21:00:00.000Z",
      absoluteExpiresAt: "2026-09-10T07:00:00.000Z",
      csrfToken: "csrf-portal",
    });
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      const headers = new Headers(init?.headers);
      seen.csrf = headers.get(CSRF_HEADER);
      return new Response(
        JSON.stringify({
          sdk: "embed.v1",
          tokenId: "jti-9",
          assertion: SAMPLE_JWS,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await mintPortalAssertion(portalEntryRbac("granted"), {
      portalRoles: ["portal.viewer"],
      tenantId: "ten-1",
      workbenchKey: "ops",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.assertion, SAMPLE_JWS);
      assert.equal(result.tokenId, "jti-9");
    }
    assert.equal(seen.url, "/api/v1/portal/adapter/assertions");
    const body = JSON.parse(seen.body ?? "{}");
    assert.deepEqual(body.portalRoles, ["portal.viewer"]);
    assert.equal(body.tenantId, "ten-1");
    assert.equal("capabilities" in body, false);
    assert.equal(seen.csrf, "csrf-portal");
  });

  it("GETs the published adapter catalog", async () => {
    let url = "";
    globalThis.fetch = (async (input) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          adapter: "portal.v1",
          capabilityMap: { "portal.viewer": ["workflow.view"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await fetchPortalAdapter();
    assert.equal(result.ok, true);
    assert.equal(url, "/api/v1/portal/adapter");
  });

  it("postMessages the assertion then forgets it", () => {
    const posted: Array<{ data: unknown; origin: string }> = [];
    const target = {
      postMessage(data: unknown, origin: string) {
        posted.push({ data, origin });
      },
    };
    const holder = emptyPortalAssertionHolder();
    holder.assertion = SAMPLE_JWS;
    const result = deliverPortalAssertion(
      target as unknown as Window,
      holder,
      "http://localhost:3000",
      ["http://localhost:3000"],
    );
    assert.equal(result.delivered, true);
    assert.equal(holder.assertion, "");
    assert.deepEqual(posted[0]?.data, {
      type: EMBED_ASSERTION_MESSAGE_TYPE,
      version: 1,
      assertion: SAMPLE_JWS,
    });
  });

  it("refuses postMessage when the target origin is not on the shared list", () => {
    const posted: unknown[] = [];
    const target = {
      postMessage(data: unknown) {
        posted.push(data);
      },
    };
    const holder = emptyPortalAssertionHolder();
    holder.assertion = SAMPLE_JWS;
    const denied = deliverPortalAssertion(
      target as unknown as Window,
      holder,
      "https://evil.example",
      ["https://portal.example"],
    );
    assert.equal(denied.delivered, false);
    assert.equal(holder.assertion, "");
    assert.deepEqual(posted, []);

    const empty = emptyPortalAssertionHolder();
    empty.assertion = SAMPLE_JWS;
    const emptyDenied = deliverPortalAssertion(
      target as unknown as Window,
      empty,
      "http://localhost:3000",
      [],
    );
    assert.equal(emptyDenied.delivered, false);
  });
});
