import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getExecution,
  listExecutions,
  loadExecutionHistory,
} from "./execution-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
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
    workflowVersionNumber: 2,
    workflowDigest: "sha256:abc",
    status: "succeeded",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:01:00.000Z",
    correlationId: "corr-16-characters",
    idempotencyKey: "deploy-prod-1",
    ...overrides,
  };
}

describe("execution client", () => {
  it("lists executions with documented filters and strips secrets", async () => {
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
    });
    assert.equal(result.ok, true);
    assert.equal(
      seen.url,
      `/api/v1/executions?workflowId=${WORKFLOW_ID}&status=indeterminate`,
    );
    assert.equal(seen.init?.credentials, "include");
    if (result.ok) {
      assert.equal(result.items.length, 2);
      assert.equal(result.items[1]?.status, "indeterminate");
      assert.ok(result.strippedKeys.some((key) => key.includes("kubeconfig")));
      assert.equal(JSON.stringify(result.items).includes("leaked"), false);
      assert.equal(JSON.stringify(result.items).includes("apiVersion"), false);
    }
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
      assert.equal(result.problem.code, "forbidden");
      assert.equal(result.problem.request_id, "forbid-request-16");
    }
  });

  it("loads detail plus nested steps/jobs/events and redacts outputs", async () => {
    withSession();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith(`/executions/${EXECUTION_ID}`)) {
        return new Response(
          JSON.stringify({
            ...summaryPayload({ status: "indeterminate", reused: true }),
            token: "should-not-leak",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/steps")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "step-1",
                nodeId: "apply",
                status: "indeterminate",
                output: { privateKey: "-----BEGIN" },
                outputRedacted: { applied: false },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/jobs")) {
        return new Response(
          JSON.stringify({ items: [{ id: "job-1", status: "lost-lease" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/events")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "evt-1",
                action: "execution.step.indeterminate",
                detailsRedacted: { reason: "lease-lost" },
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
      assert.equal(result.execution.reused, true);
      assert.equal(result.execution.steps[0]?.status, "indeterminate");
      assert.deepEqual(result.execution.steps[0]?.outputRedacted, {
        applied: false,
      });
      assert.equal(result.execution.jobs[0]?.status, "lost-lease");
      assert.equal(
        result.execution.events[0]?.action,
        "execution.step.indeterminate",
      );
      assert.ok(result.strippedKeys.some((key) => key.includes("token")));
      assert.ok(
        result.strippedKeys.some(
          (key) => key.includes("output") || key.includes("privateKey"),
        ),
      );
      assert.equal(JSON.stringify(result.execution).includes("BEGIN"), false);
      assert.equal(
        JSON.stringify(result.execution).includes("should-not-leak"),
        false,
      );
    }
  });

  it("falls back to the E3.2 pin GET when workspace detail is 404", async () => {
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
            detail: "not published yet",
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
          JSON.stringify(summaryPayload({ status: "pinned" })),
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
    if (result.ok) {
      assert.equal(result.execution.status, "pinned");
      assert.equal(result.execution.workflowVersionId, VERSION_ID);
    }
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
});
