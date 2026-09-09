import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ackAlert,
  getAlert,
  getAlertCatalog,
  listAlerts,
  listWorkspaceAuditEvents,
  resolveAlert,
} from "./alert-client.ts";
import {
  ALERT_ACK_APPLIED_MESSAGE,
  ALERT_RESOLVE_APPLIED_MESSAGE,
} from "./alert-contract.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
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

const ALERT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";

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

function alertPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ALERT_ID,
    kind: "authorization",
    severity: "high",
    status: "open",
    message: "Authorization failed",
    correlationId: "corr-e54-authorization",
    resourceType: "execution",
    resourceId: EXECUTION_ID,
    resourceIds: { executionId: EXECUTION_ID },
    occurredAt: "2026-09-09T03:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function problemResponse(status: number, code: string, detail: string) {
  return new Response(
    JSON.stringify({
      type: `urn:flowforge:problem:${code}`,
      title: code,
      status,
      detail,
      instance: "/api/v1/alerts",
      code,
      request_id: "req-e54",
    }),
    {
      status,
      headers: { "content-type": PROBLEM_JSON },
    },
  );
}

describe("alert client", () => {
  it("lists alerts with documented filters and strips secrets", async () => {
    withSession();
    const seen: { url?: string; method?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method ?? "GET";
      return jsonResponse({
        items: [alertPayload({ secret: "should-not-leak", token: "hunter2" })],
      });
    }) as typeof fetch;

    const result = await listAlerts(identity, {
      kind: "authorization",
      status: "open",
      limit: 20,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.match(String(seen.url), /\/alerts\?kind=authorization&status=open&limit=20/);
    assert.equal(seen.method, "GET");
    assert.equal(result.items[0]?.id, ALERT_ID);
    assert.ok(result.strippedKeys.includes("items[0].secret"));
    assert.ok(!JSON.stringify(result.items).includes("should-not-leak"));
  });

  it("loads catalog and detail without logging secret fields", async () => {
    withSession();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/catalog")) {
        return jsonResponse({
          kinds: ["authorization", "replay", "policy", "redaction"],
          severities: ["high"],
          statuses: ["open"],
        });
      }
      return jsonResponse(alertPayload({ password: "super-secret" }));
    }) as typeof fetch;

    const catalog = await getAlertCatalog(identity);
    assert.equal(catalog.ok, true);
    if (catalog.ok) {
      assert.ok(catalog.catalog.kinds.includes("redaction"));
    }
    const detail = await getAlert(identity, ALERT_ID);
    assert.equal(detail.ok, true);
    if (detail.ok) {
      assert.equal(detail.alert.correlationId, "corr-e54-authorization");
      assert.ok(detail.strippedKeys.includes("password"));
    }
  });

  it("acks with CSRF and an empty body", async () => {
    withSession();
    const seen: { url?: string; body?: string; csrf?: string | null } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      seen.csrf = headers.get(CSRF_HEADER);
      return jsonResponse(alertPayload({ status: "acknowledged" }));
    }) as typeof fetch;

    const result = await ackAlert(identity, ALERT_ID);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.match(String(seen.url), new RegExp(`/alerts/${ALERT_ID}/ack`));
    assert.equal(seen.body, "{}");
    assert.equal(seen.csrf, "csrf-ok");
    assert.equal(result.message, ALERT_ACK_APPLIED_MESSAGE);
    assert.equal(result.alert?.status, "acknowledged");
  });

  it("resolves with CSRF and fails closed on 403", async () => {
    withSession();
    const seen: { csrf?: string | null; body?: string } = {};
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.csrf = headers.get(CSRF_HEADER);
      seen.body = String(init?.body ?? "");
      return jsonResponse(alertPayload({ status: "resolved" }), 200);
    }) as typeof fetch;

    const result = await resolveAlert(identity, ALERT_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(seen.csrf, "csrf-ok");
      assert.equal(seen.body, "{}");
      assert.equal(result.message, ALERT_RESOLVE_APPLIED_MESSAGE);
    }

    globalThis.fetch = (async () =>
      problemResponse(403, "forbidden", "viewer cannot resolve")) as typeof fetch;
    const denied = await resolveAlert(identity, ALERT_ID);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.forbidden, true);
      assert.equal(denied.statusCode, 403);
    }
  });

  it("fails closed when CSRF is missing on ack", async () => {
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "",
    });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse(alertPayload());
    }) as typeof fetch;

    const missing = await ackAlert(identity, ALERT_ID);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.match(missing.problem.code, /csrf|forbidden|invalid-request/);
    }
    assert.equal(called, false);
  });

  it("lists product audit-events and never the E2.2 isolation stub", async () => {
    withSession();
    const seen: { url?: string } = {};
    globalThis.fetch = (async (input) => {
      seen.url = String(input);
      return jsonResponse({
        items: [
          {
            id: ALERT_ID,
            action: "authorization.denied",
            outcome: "denied",
            resourceType: "execution",
            resourceId: EXECUTION_ID,
            correlationId: "corr-e54-authorization",
            secret: "should-not-leak",
          },
        ],
      });
    }) as typeof fetch;

    const result = await listWorkspaceAuditEvents(identity, {
      resourceType: "execution",
      resourceId: EXECUTION_ID,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.match(String(seen.url), /\/audit-events\?resourceType=execution/);
    assert.ok(!String(seen.url).includes("/workspace/audit-events"));
    assert.ok(result.strippedKeys.includes("items[0].secret"));
    assert.equal(result.items[0]?.action, "authorization.denied");
  });
});
