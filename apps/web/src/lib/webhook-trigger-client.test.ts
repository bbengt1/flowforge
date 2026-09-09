import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import {
  createWebhookTrigger,
  deleteWebhookTrigger,
  listWebhookTriggers,
  rotateWebhookTrigger,
  updateWebhookTrigger,
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
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";
const PUBLIC_ID = `wh_${"ab".repeat(32)}`;

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

function sampleTrigger() {
  return {
    id: TRIGGER_ID,
    publicId: PUBLIC_ID,
    ingressPath: `/api/v1/hooks/${PUBLIC_ID}`,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    type: "webhook",
    status: "enabled",
    secretCredentialId: CREDENTIAL_ID,
    contentType: "application/json",
    fieldMapping: { env: "environment" },
    maxBodyBytes: 65536,
    clockSkewSeconds: 300,
    replayRetentionSeconds: 600,
    rateLimitPerMinute: 60,
    workspaceRatePerMinute: 300,
    maxConcurrency: 5,
    workspaceMaxConcurrency: 20,
  };
}

function validDraft() {
  return emptyWebhookTriggerDraft({
    workflowVersionId: VERSION_ID,
    secretMode: "vault",
    secretCredentialId: CREDENTIAL_ID,
    fieldMappingText: "alertId: payload.id",
  });
}

describe("webhook trigger client", () => {
  it("lists GET /workflows/{id}/triggers and fail-closes 404", async () => {
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
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
    }
    assert.equal(seen.url, `/api/v1/workflows/${WORKFLOW_ID}/triggers`);
    assert.equal(seen.init?.method ?? "GET", "GET");
  });

  it("creates with CSRF, published version, vault secret, and never keeps a leaked secret", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          ...sampleTrigger(),
          secret: "whsec_should_not_exist",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await createWebhookTrigger(identity, WORKFLOW_ID, validDraft());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.leak.leaked, true);
      assert.equal(result.trigger?.publicId, PUBLIC_ID);
      assert.equal(result.trigger?.ingressPath, `/api/v1/hooks/${PUBLIC_ID}`);
      assert.equal(result.trigger && "secret" in result.trigger, false);
      assert.match(result.message, /never returned/);
      assert.match(result.message, /discarded/);
    }
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.init?.method, "POST");
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.equal(body.type, "webhook");
    assert.equal(body.workflowVersionId, VERSION_ID);
    assert.equal(body.secretCredentialId, CREDENTIAL_ID);
    assert.equal(body.contentType, "application/json");
    assert.equal(body.clockSkewSeconds, 300);
    assert.equal(body.maxConcurrency, 5);
    assert.deepEqual(body.fieldMapping, { alertId: "payload.id" });
    assert.equal("id" in body, false);
    assert.equal("workspaceId" in body, false);
    assert.equal("secret" in body, false);
    assert.equal("inputSchema" in body, false);
    assert.equal(seen.url, `/api/v1/workflows/${WORKFLOW_ID}/triggers`);
  });

  it("creates with inline {secret:{secret}} then forgets the plaintext", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(JSON.stringify(sampleTrigger()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const draft = emptyWebhookTriggerDraft({
      workflowVersionId: VERSION_ID,
      secretMode: "inline",
      inlineSecret: "whsec_operator",
    });
    const result = await createWebhookTrigger(identity, WORKFLOW_ID, draft);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.leak.leaked, false);
      assert.match(result.message, /never returned/);
    }
    const body = JSON.parse(String(seen.init?.body)) as {
      secret?: { secret?: string };
    };
    assert.deepEqual(body.secret, { secret: "whsec_operator" });
    assert.equal(draft.inlineSecret, "");
  });

  it("rotates POST /triggers/{id}/rotate with {secret:{secret}} and fail-closes 403", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    let calls = 0;
    globalThis.fetch = (async (input, init) => {
      calls += 1;
      seen.url = String(input);
      seen.init = init;
      if (calls === 1) {
        return new Response(JSON.stringify(sampleTrigger()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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

    const rotated = await rotateWebhookTrigger(
      identity,
      WORKFLOW_ID,
      TRIGGER_ID,
      "whsec_next",
    );
    assert.equal(rotated.ok, true);
    if (rotated.ok) {
      assert.match(rotated.message, /not returned/);
    }
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.url, `/api/v1/triggers/${TRIGGER_ID}/rotate`);
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, { secret: { secret: "whsec_next" } });

    const denied = await rotateWebhookTrigger(
      identity,
      WORKFLOW_ID,
      TRIGGER_ID,
      "whsec_next",
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.forbidden, true);
      assert.equal(denied.statusCode, 403);
    }
  });

  it("patches /triggers/{id} without secret and deletes with CSRF", async () => {
    withSession();
    const seen: { url?: string; method?: string; body?: unknown }[] = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
      });
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(sampleTrigger()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const patched = await updateWebhookTrigger(
      identity,
      WORKFLOW_ID,
      TRIGGER_ID,
      validDraft(),
    );
    assert.equal(patched.ok, true);
    const patchBody = JSON.parse(String(seen[0]?.body)) as Record<string, unknown>;
    assert.equal(seen[0]?.url, `/api/v1/triggers/${TRIGGER_ID}`);
    assert.equal(seen[0]?.method, "PATCH");
    assert.equal("secret" in patchBody, false);
    assert.equal(patchBody.workflowVersionId, VERSION_ID);

    const removed = await deleteWebhookTrigger(identity, WORKFLOW_ID, PUBLIC_ID);
    assert.equal(removed.ok, true);
    if (removed.ok) {
      assert.equal(removed.trigger, null);
      assert.match(removed.message, /deleted/i);
    }
    assert.equal(seen[1]?.url, `/api/v1/triggers/${PUBLIC_ID}`);
    assert.equal(seen[1]?.method, "DELETE");
  });
});
