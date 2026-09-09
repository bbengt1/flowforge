import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import {
  createScheduleTrigger,
  deleteScheduleTrigger,
  disableScheduleTrigger,
  dispatchSchedule,
  getScheduleCatalog,
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
const SCHEDULE_ID = "22222222-2222-4222-8222-222222222222";
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

function sampleSchedule() {
  return {
    id: SCHEDULE_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    status: "enabled",
    timezone: "UTC",
    cron: "0 0 * * *",
    overlapPolicy: "skip",
    misfirePolicy: "ignore",
    catchUp: 0,
    nextFireAt: "2026-09-10T00:00:00Z",
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

describe("schedule client", () => {
  it("lists GET /schedules?workflowId= and fail-closes 404", async () => {
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
          instance: "/schedules",
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
    assert.equal(seen.url, `/api/v1/schedules?workflowId=${WORKFLOW_ID}`);
    assert.equal(seen.init?.method ?? "GET", "GET");
  });

  it("creates POST /schedules with workflowId, CSRF, and no type field", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(JSON.stringify(sampleSchedule()), {
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
      assert.equal(result.trigger?.nextFireAt, "2026-09-10T00:00:00Z");
      assert.match(result.message, /published workflow version/);
    }
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.init?.method, "POST");
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.equal("type" in body, false);
    assert.equal(body.workflowId, WORKFLOW_ID);
    assert.equal(body.workflowVersionId, VERSION_ID);
    assert.equal(body.timezone, "UTC");
    assert.equal(body.cron, "0 0 * * *");
    assert.equal(body.overlapPolicy, "skip");
    assert.equal(body.catchUp, 0);
    assert.equal("id" in body, false);
    assert.equal("workspaceId" in body, false);
    assert.equal("interval" in body, false);
    assert.equal(seen.url, "/api/v1/schedules");
  });

  it("loads GET /schedules/catalog", async () => {
    withSession();
    const seen: { url?: string } = {};
    globalThis.fetch = (async (input) => {
      seen.url = String(input);
      return new Response(
        JSON.stringify({
          defaultOverlapPolicy: "skip",
          defaultMisfirePolicy: "ignore",
          defaultCatchUp: 0,
          dispatchRoute: "POST /api/v1/schedules/dispatch",
          help: "catalog",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await getScheduleCatalog(identity);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.catalog.defaultOverlapPolicy, "skip");
      assert.equal(result.catalog.dispatchRoute, "POST /api/v1/schedules/dispatch");
    }
    assert.equal(seen.url, "/api/v1/schedules/catalog");
  });

  it("patches /schedules/{id} and fail-closes 403 on disable", async () => {
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
            instance: "/schedules",
            code: "forbidden",
            request_id: "r-403",
          }),
          { status: 403, headers: { "Content-Type": "application/problem+json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ...sampleSchedule(),
          timezone: "Europe/Berlin",
          overlapPolicy: "reject",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const patched = await updateScheduleTrigger(
      identity,
      WORKFLOW_ID,
      SCHEDULE_ID,
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
    assert.equal(seen.url, `/api/v1/schedules/${SCHEDULE_ID}`);
    assert.equal(seen.init?.method, "PATCH");

    const denied = await disableScheduleTrigger(identity, WORKFLOW_ID, SCHEDULE_ID);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.forbidden, true);
      assert.equal(denied.statusCode, 403);
    }
  });

  it("dispatches POST /schedules/dispatch with CSRF and optional scheduleId", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          items: [{ scheduleId: SCHEDULE_ID, skipReason: "not-due" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await dispatchSchedule(identity, SCHEDULE_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.items[0]?.scheduleId, SCHEDULE_ID);
      assert.match(result.message, /operator tick/);
    }
    assert.equal(seen.url, "/api/v1/schedules/dispatch");
    assert.equal(seen.init?.method, "POST");
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    assert.equal(body.scheduleId, SCHEDULE_ID);
    assert.equal("id" in body, false);
    assert.equal("workspaceId" in body, false);
  });

  it("deletes with CSRF", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const removed = await deleteScheduleTrigger(identity, WORKFLOW_ID, SCHEDULE_ID);
    assert.equal(removed.ok, true);
    if (removed.ok) {
      assert.equal(removed.trigger, null);
      assert.match(removed.message, /deleted/i);
    }
    assert.equal(seen.url, `/api/v1/schedules/${SCHEDULE_ID}`);
    assert.equal(seen.init?.method, "DELETE");
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
  });
});
