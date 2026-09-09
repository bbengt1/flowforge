import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import {
  createWebhookTrigger,
  listWebhookTriggers,
  rotateWebhookTrigger,
} from "./webhook-trigger-client.ts";
import { emptyWebhookTriggerDraft } from "./webhook-trigger-contract.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";

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

describe("webhook trigger client", () => {
  it("lists through the fallback collection and treats 404 as empty map-pending", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: "missing",
          instance: "/triggers",
          code: "not-found",
          request_id: "r-404",
        }),
        { status: 404, headers: { "Content-Type": "application/problem+json" } },
      );
    }) as typeof fetch;

    const result = await listWebhookTriggers(identity, WORKFLOW_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.items, []);
      assert.equal(result.usedFallback, true);
    }
    assert.equal(seen.url, `/api/v1/workflows/${WORKFLOW_ID}/triggers?type=webhook`);
    assert.equal(seen.init?.method ?? "GET", "GET");
  });

  it("creates with CSRF, never sends host identity, and strips the one-time secret", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          id: TRIGGER_ID,
          workflowId: WORKFLOW_ID,
          opaqueId: "wh_opaque_1",
          status: "active",
          secret: "whsec_once",
          fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await createWebhookTrigger(
      identity,
      WORKFLOW_ID,
      emptyWebhookTriggerDraft({ fieldMappingText: "alert.id: payload.id" }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.reveal.secret, "whsec_once");
      assert.equal(result.trigger?.opaqueId, "wh_opaque_1");
      assert.equal(result.trigger && "secret" in result.trigger, false);
      assert.match(result.message, /one-time secret/);
    }
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.init?.method, "POST");
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.equal(body.contentType, "application/json");
    assert.equal("id" in body, false);
    assert.equal("workspaceId" in body, false);
    assert.equal("secret" in body, false);
    assert.equal(seen.url, `/api/v1/workflows/${WORKFLOW_ID}/triggers`);
  });

  it("rotates with CSRF and fail-closes 403 without treating the secret as rotated", async () => {
    withSession();
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "nope",
          instance: "/rotate",
          code: "forbidden",
          request_id: "r-403",
        }),
        { status: 403, headers: { "Content-Type": "application/problem+json" } },
      );
    }) as typeof fetch;

    const result = await rotateWebhookTrigger(identity, WORKFLOW_ID, TRIGGER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.forbidden, true);
      assert.equal(result.statusCode, 403);
      assert.equal("reveal" in result, false);
    }
  });
});
