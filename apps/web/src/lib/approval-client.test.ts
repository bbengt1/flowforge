import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  approveApproval,
  evaluatePolicy,
  getApproval,
  listApprovals,
  listExecutionApprovals,
  rejectApproval,
} from "./approval-client.ts";
import {
  approvalApprovePath,
  approvalRejectPath,
  approvalsPath,
  buildDecideApprovalBody,
  buildEvaluatePolicyBody,
  policyEvaluatePath,
} from "./approval-contract.ts";
import { shouldBlockRun } from "./approval.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { PROBLEM_JSON } from "./problem.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "approver-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "77777777-7777-4777-8777-777777777777";
const EXECUTION_ID = "88888888-8888-4888-8888-888888888888";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

function withSession() {
  setActiveSession({
    issuer: "https://flowforge.local",
    subject: "approver-chloe",
    displayName: "Chloe",
    sessionId: "sess-1",
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    csrfToken: "csrf-ok",
  });
}

function approvalPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    status: "pending",
    binding: {
      workflowVersionId: VERSION_ID,
      workflowVersionDigest: "sha256:aaaa",
      targetId: TARGET_ID,
      targetKind: "cluster_target",
      targetName: "prod",
      policyRevisionId: POLICY_ID,
      policyRevisionNumber: 1,
      operation: "workflow.execute",
      expiresAt: "2099-01-01T00:00:00Z",
    },
    validity: { current: true, reason: "pending", changedFields: [] },
    permittedActions: ["approve", "reject"],
    workflowName: "rollout",
    ...overrides,
  };
}

function problem(code: string, status = 409) {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: code,
    status,
    detail: `${code} fail-closed.`,
    instance: approvalApprovePath(APPROVAL_ID),
    code,
    request_id: "req-1",
  };
}

describe("approval client", () => {
  it("lists pending approvals without invented query params", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({ items: [approvalPayload()] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await listApprovals(identity);
    assert.equal(result.ok, true);
    assert.equal(seen.url, `/api/v1${approvalsPath()}`);
    assert.equal(seen.init?.credentials, "include");
    if (result.ok) {
      assert.equal(result.items[0]?.id, APPROVAL_ID);
      assert.equal(result.items[0]?.binding.operation, "workflow.execute");
    }
  });

  it("sends CSRF on approve/reject and never host-supplied workspaceId", async () => {
    withSession();
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(
        JSON.stringify(approvalPayload({ status: "approved" })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const approved = await approveApproval(identity, APPROVAL_ID, "ok");
    const rejected = await rejectApproval(identity, APPROVAL_ID, "no");
    assert.equal(approved.ok, true);
    assert.equal(rejected.ok, true);
    assert.equal(seen[0]?.url, `/api/v1${approvalApprovePath(APPROVAL_ID)}`);
    assert.equal(seen[1]?.url, `/api/v1${approvalRejectPath(APPROVAL_ID)}`);
    for (const call of seen) {
      assert.equal(call.headers.get(CSRF_HEADER), "csrf-ok");
      assert.equal(call.body.includes("workspaceId"), false);
      assert.equal(call.body.includes("workspace_id"), false);
      assert.equal(call.body.includes("\"id\""), false);
    }
    assert.deepEqual(buildDecideApprovalBody(" ok "), { note: "ok" });
    assert.deepEqual(buildDecideApprovalBody("  "), {});
  });

  it("fails closed when the session is missing CSRF on decide", async () => {
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "approver-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "",
    });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await approveApproval(identity, APPROVAL_ID);
    assert.equal(result.ok, false);
    assert.equal(called, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.match(result.problem.code, /csrf|forbidden|unauthenticated/);
    }
  });

  it("treats expired and invalidated decide problems as fail-closed", async () => {
    withSession();
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(problem("approval-expired")), {
        status: 409,
        headers: { "Content-Type": PROBLEM_JSON },
      });
    }) as typeof fetch;

    const expired = await approveApproval(identity, APPROVAL_ID);
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.expired, true);
      assert.equal(expired.invalidated, false);
    }

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(problem("approval-invalidated")), {
        status: 409,
        headers: { "Content-Type": PROBLEM_JSON },
      });
    }) as typeof fetch;
    const invalidated = await rejectApproval(identity, APPROVAL_ID);
    assert.equal(invalidated.ok, false);
    if (!invalidated.ok) {
      assert.equal(invalidated.invalidated, true);
    }
  });

  it("re-evaluates before dispatch and ignores a stale local approved flag", async () => {
    withSession();
    const seen: { url?: string; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          decision: "approval_required",
          workflowVersionId: VERSION_ID,
          operation: "workflow.execute",
          requirements: [approvalPayload()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await evaluatePolicy(identity, {
      workflowVersionId: VERSION_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, `/api/v1${policyEvaluatePath()}`);
    assert.match(seen.body ?? "", /workflowVersionId/);
    assert.equal(seen.body?.includes("workspaceId"), false);
    if (result.ok) {
      assert.equal(
        shouldBlockRun({
          evaluation: result.evaluation,
          staleLocalApproved: true,
        }),
        true,
      );
    }
    assert.deepEqual(buildEvaluatePolicyBody({ workflowVersionId: VERSION_ID }), {
      workflowVersionId: VERSION_ID,
      operation: "workflow.execute",
    });
  });

  it("loads execution waiting approvals and GET detail bindings", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      if (String(input).includes("/executions/")) {
        return new Response(
          JSON.stringify({
            items: [
              approvalPayload({
                executionId: EXECUTION_ID,
                executionStatus: "awaiting_approval",
              }),
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(approvalPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const waiting = await listExecutionApprovals(
      identity,
      WORKFLOW_ID,
      EXECUTION_ID,
    );
    const detail = await getApproval(identity, APPROVAL_ID);
    assert.equal(waiting.ok, true);
    assert.equal(detail.ok, true);
    assert.equal(
      seen[0],
      `/api/v1/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}/approvals`,
    );
    if (detail.ok) {
      assert.equal(detail.approval.binding.workflowVersionDigest, "sha256:aaaa");
      assert.equal(detail.approval.binding.policyRevisionId, POLICY_ID);
      assert.equal(detail.approval.binding.expiresAt, "2099-01-01T00:00:00Z");
    }
  });
});
