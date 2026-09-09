import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getExecution,
  listExecutions,
  listWorkflowExecutions,
  listWorkspaceAuditEvents,
  loadExecutionHistory,
} from "./execution-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { startWorkflowExecution } from "./workflow-client.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

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

function summaryPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "rollout",
    workflowVersionId: VERSION_ID,
    workflowDigest: "sha256:abc",
    status: "queued",
    createdAt: "2026-09-09T01:00:00.000Z",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:01:00.000Z",
    correlationId: "corr-16-characters",
    idempotencyKey: "deploy-prod-1",
    replayed: false,
    input: { secret: "[redacted]" },
    policySnapshot: {},
    ...overrides,
  };
}

describe("execution client", () => {
  it("lists workspace executions with documented filters and strips secrets", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          items: [
            summaryPayload(),
            {
              ...summaryPayload({
                id: "44444444-4444-4444-8444-444444444444",
                status: "indeterminate",
              }),
              kubeconfig: "apiVersion: v1",
              secret: "leaked",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await listExecutions(identity, {
      workflowId: WORKFLOW_ID,
      status: "indeterminate",
      limit: 25,
    });
    assert.equal(result.ok, true);
    assert.equal(
      seen.url,
      `/api/v1/executions?workflowId=${WORKFLOW_ID}&status=indeterminate&limit=25`,
    );
    assert.equal(seen.init?.credentials, "include");
    if (result.ok) {
      assert.equal(result.items.length, 2);
      assert.equal(result.items[1]?.status, "indeterminate");
      assert.ok(result.strippedKeys.some((key) => key.includes("kubeconfig")));
      assert.equal(JSON.stringify(result.items).includes("leaked"), false);
      assert.match(JSON.stringify(result.items), /\[redacted\]/);
    }
  });

  it("lists per-workflow executions on the documented collection", async () => {
    withSession();
    let seen = "";
    globalThis.fetch = (async (input) => {
      seen = String(input);
      return new Response(JSON.stringify({ items: [summaryPayload()] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await listWorkflowExecutions(identity, WORKFLOW_ID, {
      status: "queued",
      limit: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(
      seen,
      `/api/v1/workflows/${WORKFLOW_ID}/executions?status=queued&limit=10`,
    );
  });

  it("fails closed on 403 and does not keep list rows", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "execution.view is required.",
          instance: "/api/v1/executions",
          code: "forbidden",
          request_id: "forbid-request-16",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": PROBLEM_JSON,
            "X-Request-ID": "forbid-request-16",
          },
        },
      )) as typeof fetch;

    const result = await listExecutions(identity);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.equal(result.forbidden, true);
    }
  });

  it("loads detail plus nested steps/jobs/audit-events and shows [redacted]", async () => {
    withSession();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith(`/executions/${EXECUTION_ID}`)) {
        return new Response(
          JSON.stringify({
            ...summaryPayload({ status: "indeterminate", replayed: true }),
            token: "should-not-leak",
            pins: [
              {
                kind: "policy",
                resourceId: WORKFLOW_ID,
                versionId: VERSION_ID,
                versionNumber: 1,
                name: "gate",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/steps")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                nodeId: "apply",
                status: "indeterminate",
                attempt: 1,
                output: { privateKey: "-----BEGIN", result: "[redacted]" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/jobs")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "55555555-5555-4555-8555-555555555555",
                status: "queued",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/audit-events")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "66666666-6666-4666-8666-666666666666",
                action: "execution.step.indeterminate",
                details: { reason: "lease-lost", password: "[redacted]" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await loadExecutionHistory(identity, EXECUTION_ID);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.execution.status, "indeterminate");
      assert.equal(result.execution.replayed, true);
      assert.equal(result.execution.pins[0]?.name, "gate");
      assert.equal(result.execution.steps[0]?.status, "indeterminate");
      assert.equal(
        (result.execution.steps[0]?.output as { result?: string }).result,
        "[redacted]",
      );
      assert.equal(result.execution.jobs[0]?.status, "queued");
      assert.equal(
        result.execution.auditEvents[0]?.action,
        "execution.step.indeterminate",
      );
      assert.ok(result.strippedKeys.some((key) => key.includes("token")));
      assert.ok(result.strippedKeys.some((key) => key.includes("privateKey")));
      assert.equal(JSON.stringify(result.execution).includes("BEGIN"), false);
      assert.equal(
        JSON.stringify(result.execution).includes("should-not-leak"),
        false,
      );
      assert.match(JSON.stringify(result.execution), /\[redacted\]/);
    }
  });

  it("uses the workflow-scoped twin when workspace detail is 404", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === `/api/v1/executions/${EXECUTION_ID}`) {
        return new Response(
          JSON.stringify({
            type: "urn:flowforge:problem:not-found",
            title: "Not Found",
            status: 404,
            detail: "not in workspace index",
            instance: `/api/v1/executions/${EXECUTION_ID}`,
            code: "not-found",
            request_id: "missing-query-16xx",
          }),
          { status: 404, headers: { "Content-Type": PROBLEM_JSON } },
        );
      }
      if (
        url ===
        `/api/v1/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}`
      ) {
        return new Response(
          JSON.stringify(summaryPayload({ status: "queued" })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await getExecution(identity, EXECUTION_ID, WORKFLOW_ID);
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [
      `/api/v1/executions/${EXECUTION_ID}`,
      `/api/v1/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}`,
    ]);
  });

  it("does not fall back on 403 detail", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "execution.view is required.",
          instance: `/api/v1/executions/${EXECUTION_ID}`,
          code: "forbidden",
          request_id: "detail-forbid-16x",
        }),
        { status: 403, headers: { "Content-Type": PROBLEM_JSON } },
      );
    }) as typeof fetch;

    const result = await getExecution(identity, EXECUTION_ID, WORKFLOW_ID);
    assert.equal(result.ok, false);
    assert.deepEqual(seen, [`/api/v1/executions/${EXECUTION_ID}`]);
    if (!result.ok) {
      assert.equal(result.forbidden, true);
    }
  });

  it("lists workspace audit events on /audit-events, not the E2.2 stub", async () => {
    withSession();
    let seen = "";
    globalThis.fetch = (async (input) => {
      seen = String(input);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              action: "execution.started",
              details: { secret: "[redacted]" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await listWorkspaceAuditEvents(identity, {
      resourceType: "execution",
      resourceId: EXECUTION_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(
      seen,
      `/api/v1/audit-events?resourceType=execution&resourceId=${EXECUTION_ID}`,
    );
    assert.equal(seen.includes("/workspace/audit-events"), false);
  });

  it("POSTs start with CSRF and surfaces 201 vs 200 vs 409", async () => {
    withSession();
    const seen: { url?: string; body?: string; csrf?: string | null; status: number }[] =
      [];
    let call = 0;
    globalThis.fetch = (async (input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        csrf: headers.get(CSRF_HEADER),
        status: call === 1 ? 201 : call === 2 ? 200 : 409,
      });
      if (call === 3) {
        return new Response(
          JSON.stringify({
            type: "urn:flowforge:problem:conflict",
            title: "Conflict",
            status: 409,
            detail: "idempotency key reused with a different fingerprint",
            instance: `/api/v1/workflows/${WORKFLOW_ID}/executions`,
            code: "conflict",
            request_id: "conflict-start-16",
          }),
          { status: 409, headers: { "Content-Type": PROBLEM_JSON } },
        );
      }
      return new Response(
        JSON.stringify(
          summaryPayload({
            replayed: call === 2,
            status: "queued",
          }),
        ),
        {
          status: call === 1 ? 201 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const created = await startWorkflowExecution(
      identity,
      WORKFLOW_ID,
      VERSION_ID,
      { idempotencyKey: "deploy-prod-1" },
    );
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.statusCode, 201);
      assert.equal(created.execution.replayed, false);
    }
    assert.match(seen[0]?.body ?? "", /workflowVersionId/);
    assert.match(seen[0]?.body ?? "", /idempotencyKey/);
    assert.equal(seen[0]?.csrf, "csrf-ok");

    const replayed = await startWorkflowExecution(
      identity,
      WORKFLOW_ID,
      VERSION_ID,
      { idempotencyKey: "deploy-prod-1" },
    );
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.statusCode, 200);
      assert.equal(replayed.execution.replayed, true);
    }

    const conflict = await startWorkflowExecution(
      identity,
      WORKFLOW_ID,
      VERSION_ID,
      { idempotencyKey: "deploy-prod-1", input: { other: true } },
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.conflict, true);
    }
  });
});
