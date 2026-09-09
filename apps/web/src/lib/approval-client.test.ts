import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  approveApproval,
  createApprovals,
  evaluatePolicy,
  evaluatePolicyForRun,
  getApproval,
  getApprovalCatalog,
  listApprovals,
  listExecutionApprovals,
  rejectApproval,
} from "./approval-client.ts";
import {
  approvalDecidePath,
  approvalsCatalogPath,
  approvalsPath,
  buildDecideApprovalBody,
  buildEvaluatePolicyBody,
  EXPIRED_APPROVAL_DETAIL,
  INVALIDATED_APPROVAL_DETAIL,
  listApprovalsPath,
  policyEvaluatePath,
  SELF_APPROVAL_DETAIL,
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
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    workflowDigest: "sha256:aaaa",
    targetId: TARGET_ID,
    targetKind: "cluster_target",
    policyResourceId: POLICY_ID,
    policyVersionId: POLICY_ID,
    policyRevision: 1,
    operation: "workflow.execute",
    expiresAt: "2099-01-01T00:00:00Z",
    bindingFingerprint: "fp-1",
    approverRole: "approver",
    ...overrides,
  };
}

function problem(detail: string, status = 409, code = "conflict") {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: code,
    status,
    detail,
    instance: approvalDecidePath(APPROVAL_ID),
    code,
    request_id: "req-1",
  };
}

describe("approval client", () => {
  it("loads the #44 catalog over GET without CSRF", async () => {
    withSession();
    const seen: { url?: string; method?: string; csrf?: string | null } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method ?? "GET";
      seen.csrf = new Headers(init?.headers).get(CSRF_HEADER);
      return new Response(
        JSON.stringify({
          statuses: ["pending", "approved"],
          decisions: ["approved", "rejected"],
          defaultExpiresIn: "PT1H",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await getApprovalCatalog(identity);
    assert.equal(result.ok, true);
    assert.equal(seen.url, `/api/v1${approvalsCatalogPath()}`);
    assert.equal(seen.method, "GET");
    if (result.ok) {
      assert.equal(result.catalog.defaultExpiresIn, "PT1H");
    }
  });

  it("lists approvals with documented status query only", async () => {
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

    const result = await listApprovals(identity, { status: "pending" });
    assert.equal(result.ok, true);
    assert.equal(seen.url, `/api/v1${listApprovalsPath({ status: "pending" })}`);
    assert.equal(seen.init?.credentials, "include");
    if (result.ok) {
      assert.equal(result.items[0]?.id, APPROVAL_ID);
      assert.equal(result.items[0]?.binding.operation, "workflow.execute");
    }
  });

  it("sends CSRF on decide and never host-supplied workspaceId", async () => {
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
    assert.equal(seen[0]?.url, `/api/v1${approvalDecidePath(APPROVAL_ID)}`);
    assert.equal(seen[1]?.url, `/api/v1${approvalDecidePath(APPROVAL_ID)}`);
    for (const call of seen) {
      assert.equal(call.headers.get(CSRF_HEADER), "csrf-ok");
      assert.equal(call.body.includes("workspaceId"), false);
      assert.equal(call.body.includes("workspace_id"), false);
      assert.equal(call.body.includes("\"id\""), false);
    }
    assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), {
      decision: "approved",
      note: "ok",
    });
    assert.deepEqual(JSON.parse(seen[1]?.body ?? "{}"), {
      decision: "rejected",
      note: "no",
    });
    assert.deepEqual(buildDecideApprovalBody("approved", " ok "), {
      decision: "approved",
      note: "ok",
    });
    assert.deepEqual(buildDecideApprovalBody("rejected", "  "), {
      decision: "rejected",
    });
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

  it("treats expired, invalidated, and self-approval decide problems as fail-closed", async () => {
    withSession();
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(problem(EXPIRED_APPROVAL_DETAIL)), {
        status: 409,
        headers: { "Content-Type": PROBLEM_JSON },
      });
    }) as typeof fetch;

    const expired = await approveApproval(identity, APPROVAL_ID);
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.expired, true);
      assert.equal(expired.invalidated, false);
      assert.equal(expired.selfApproval, false);
    }

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(problem(INVALIDATED_APPROVAL_DETAIL)), {
        status: 409,
        headers: { "Content-Type": PROBLEM_JSON },
      });
    }) as typeof fetch;
    const invalidated = await rejectApproval(identity, APPROVAL_ID);
    assert.equal(invalidated.ok, false);
    if (!invalidated.ok) {
      assert.equal(invalidated.invalidated, true);
    }

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify(problem(SELF_APPROVAL_DETAIL, 403, "forbidden")),
        {
          status: 403,
          headers: { "Content-Type": PROBLEM_JSON },
        },
      );
    }) as typeof fetch;
    const self = await approveApproval(identity, APPROVAL_ID);
    assert.equal(self.ok, false);
    if (!self.ok) {
      assert.equal(self.selfApproval, true);
      assert.equal(self.expired, false);
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
          decision: "approval-required",
          dispatchAllowed: false,
          workflowVersionId: VERSION_ID,
          requirements: [{ operation: "workflow.execute", reason: "gate" }],
          approvals: [approvalPayload()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await evaluatePolicy(identity, {
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, `/api/v1${policyEvaluatePath()}`);
    assert.match(seen.body ?? "", /workflowId/);
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
    assert.deepEqual(
      buildEvaluatePolicyBody({
        workflowId: WORKFLOW_ID,
        workflowVersionId: VERSION_ID,
      }),
      { workflowId: WORKFLOW_ID, workflowVersionId: VERSION_ID },
    );
  });

  it("materializes pending rows when evaluate returns approval-required", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/policy/evaluate")) {
        return new Response(
          JSON.stringify({
            decision: "approval-required",
            dispatchAllowed: false,
            workflowVersionId: VERSION_ID,
            requirements: [{ operation: "workflow.execute", reason: "gate" }],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ items: [approvalPayload()] }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await evaluatePolicyForRun(identity, {
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [
      `POST /api/v1${policyEvaluatePath()}`,
      `POST /api/v1${approvalsPath()}`,
    ]);
    if (result.ok) {
      assert.equal(result.evaluation.approvals[0]?.id, APPROVAL_ID);
    }
  });

  it("loads execution waiting approvals via documented executionId query", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes(APPROVAL_ID) && !url.includes("executionId")) {
        return new Response(JSON.stringify(approvalPayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          items: [
            approvalPayload({
              executionId: EXECUTION_ID,
            }),
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const waiting = await listExecutionApprovals(
      identity,
      WORKFLOW_ID,
      EXECUTION_ID,
    );
    const created = await createApprovals(identity, {
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
    });
    const detail = await getApproval(identity, APPROVAL_ID);
    assert.equal(waiting.ok, true);
    assert.equal(created.ok, true);
    assert.equal(detail.ok, true);
    assert.equal(
      seen[0],
      `/api/v1${listApprovalsPath({ executionId: EXECUTION_ID })}`,
    );
    if (detail.ok) {
      assert.equal(detail.approval.binding.workflowVersionDigest, "sha256:aaaa");
      assert.equal(detail.approval.binding.policyRevisionId, POLICY_ID);
      assert.equal(detail.approval.binding.expiresAt, "2099-01-01T00:00:00Z");
    }
  });
});
