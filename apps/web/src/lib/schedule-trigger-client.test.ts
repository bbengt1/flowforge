import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import {
  createScheduleTrigger,
  deleteScheduleTrigger,
  disableScheduleTrigger,
  listScheduleTriggers,
  updateScheduleTrigger,
} from "./schedule-trigger-client.ts";
import { emptyScheduleTriggerDraft } from "./schedule-trigger-contract.ts";

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
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    type: "schedule",
    status: "enabled",
    timezone: "UTC",
    cron: "0 0 * * *",
    overlapPolicy: "skip",
    misfirePolicy: "ignore",
    catchUp: 0,
  };
}

function validDraft() {
  return emptyScheduleTriggerDraft({
    workflowVersionId: VERSION_ID,
    timezone: "UTC",
    expressionKind: "cron",
    cron: "0 0 * * *",
    overlapPolicy: "skip",
    misfirePolicy: "ignore",
    catchUp: "0",
  });
}

describe("schedule trigger client", () => {
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

    const result = await listScheduleTriggers(identity, WORKFLOW_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
    }
    assert.equal(seen.url, `/api/v1/workflows/${WORKFLOW_ID}/triggers`);
    assert.equal(seen.init?.method ?? "GET", "GET");
  });

  it("creates with CSRF, published version, and safe catch-up/overlap", async () => {
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

    const result = await createScheduleTrigger(identity, WORKFLOW_ID, validDraft());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.trigger?.timezone, "UTC");
      assert.equal(result.trigger?.overlapPolicy, "skip");
      assert.equal(result.trigger?.catchUp, 0);
      assert.match(result.message, /published workflow version/);
    }
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.init?.method, "POST");
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.equal(body.type, "schedule");
    assert.equal(body.workflowVersionId, VERSION_ID);
    assert.equal(body.timezone, "UTC");
    assert.equal(body.cron, "0 0 * * *");
    assert.equal(body.overlapPolicy, "skip");
    assert.equal(body.catchUp, 0);
    assert.equal("id" in body, false);
    assert.equal("workspaceId" in body, false);
    assert.equal("interval" in body, false);
    assert.equal(seen.url, `/api/v1/workflows/${WORKFLOW_ID}/triggers`);
  });

  it("filters webhook rows out of the shared list", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            sampleTrigger(),
            {
              id: "44444444-4444-4444-8444-444444444444",
              type: "webhook",
              publicId: `wh_${"cd".repeat(32)}`,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await listScheduleTriggers(identity, WORKFLOW_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.type, "schedule");
    }
  });

  it("patches timezone/overlap and fail-closes 403", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      if (String(input).endsWith("/disable")) {
        return new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            detail: "",
            instance: "/triggers",
            code: "forbidden",
            request_id: "r-403",
          }),
          { status: 403, headers: { "Content-Type": "application/problem+json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ...sampleTrigger(),
          timezone: "Europe/Berlin",
          overlapPolicy: "reject",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const patched = await updateScheduleTrigger(
      identity,
      WORKFLOW_ID,
      TRIGGER_ID,
      emptyScheduleTriggerDraft({
        workflowVersionId: VERSION_ID,
        timezone: "Europe/Berlin",
        expressionKind: "cron",
        cron: "0 0 * * *",
        overlapPolicy: "reject",
        misfirePolicy: "ignore",
        catchUp: "0",
      }),
    );
    assert.equal(patched.ok, true);
    if (patched.ok) {
      assert.equal(patched.trigger?.timezone, "Europe/Berlin");
      assert.equal(patched.trigger?.overlapPolicy, "reject");
    }
    assert.equal(seen.url, `/api/v1/triggers/${TRIGGER_ID}`);
    assert.equal(seen.init?.method, "PATCH");

    const denied = await disableScheduleTrigger(identity, WORKFLOW_ID, TRIGGER_ID);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.forbidden, true);
      assert.equal(denied.statusCode, 403);
    }
  });

  it("deletes with CSRF", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const removed = await deleteScheduleTrigger(identity, WORKFLOW_ID, TRIGGER_ID);
    assert.equal(removed.ok, true);
    if (removed.ok) {
      assert.equal(removed.trigger, null);
      assert.match(removed.message, /deleted/i);
    }
    assert.equal(seen.url, `/api/v1/triggers/${TRIGGER_ID}`);
    assert.equal(seen.init?.method, "DELETE");
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
  });
});
