import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDecideApproval,
  canDispatchFromEvaluation,
  canSeeApprovalsNav,
  diffBinding,
  filterApprovalList,
  FORBIDDEN_APPROVAL_STORAGE,
  invalidationSummary,
  isApprovalExpired,
  isApprovalInvalidated,
  isExecutionAwaitingApproval,
  isSecretKey,
  parseApprovalRequest,
  parsePolicyEvaluation,
  pendingApprovals,
  problemClosesApproval,
  shouldBlockRun,
  stripSecretKeys,
} from "./approval.ts";
import { APPROVAL_PROBLEM_CODES } from "./approval-contract.ts";
import type { ApprovalBinding, ApprovalRequest, PolicyEvaluation } from "./approval-types.ts";
import { PROBLEM_JSON } from "./problem.ts";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_V2 = "55555555-5555-4555-8555-555555555555";
const VERSION_V2 = "66666666-6666-4666-8666-666666666666";

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    workflowVersionId: VERSION_ID,
    workflowVersionDigest: "sha256:aaaa",
    targetId: TARGET_ID,
    targetKind: "cluster_target",
    targetName: "prod",
    policyRevisionId: POLICY_ID,
    policyRevisionNumber: 1,
    policyDigest: "sha256:policy1",
    operation: "workflow.execute",
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const bound = overrides.binding ?? binding();
  return {
    id: APPROVAL_ID,
    status: "pending",
    binding: bound,
    validity: {
      current: true,
      reason: "pending",
      changedFields: [],
      currentBinding: null,
    },
    requestedBy: "operator",
    requestedAt: "2026-09-09T00:00:00Z",
    decidedBy: "",
    decidedAt: "",
    note: "",
    workflowId: "77777777-7777-4777-8777-777777777777",
    workflowName: "rollout",
    executionId: "",
    executionStatus: "",
    permittedActions: ["approve", "reject"],
    ...overrides,
  };
}

describe("approval binding invalidation", () => {
  it("marks a prior approval invalid when policy, target, or version changes", () => {
    const bound = binding();
    const policyChanged = diffBinding(
      bound,
      binding({ policyRevisionId: POLICY_V2 }),
    );
    assert.deepEqual(policyChanged, ["policyRevision"]);

    const targetChanged = diffBinding(
      bound,
      binding({ targetId: "88888888-8888-4888-8888-888888888888" }),
    );
    assert.deepEqual(targetChanged, ["target"]);

    const versionChanged = diffBinding(
      bound,
      binding({
        workflowVersionId: VERSION_V2,
        workflowVersionDigest: "sha256:bbbb",
      }),
    );
    assert.deepEqual(versionChanged, ["workflowVersion"]);
  });

  it("surfaces invalidation from server validity and status", () => {
    const invalidated = approval({
      status: "invalidated",
      validity: {
        current: false,
        reason: "binding-changed",
        changedFields: ["policyRevision", "workflowVersion"],
        currentBinding: binding({
          workflowVersionId: VERSION_V2,
          policyRevisionId: POLICY_V2,
        }),
      },
    });
    assert.equal(isApprovalInvalidated(invalidated), true);
    assert.equal(canDecideApproval(invalidated), false);
    assert.match(invalidationSummary(invalidated), /policyRevision/);
    assert.match(invalidationSummary(invalidated), /workflowVersion/);
  });

  it("parses a GET detail that reports a changed currentBinding", () => {
    const parsed = parseApprovalRequest({
      id: APPROVAL_ID,
      status: "pending",
      binding: binding(),
      validity: {
        current: false,
        reason: "invalidated",
        changedFields: ["target"],
        currentBinding: binding({ targetId: POLICY_V2 }),
      },
      permittedActions: ["approve"],
    });
    assert.ok(parsed);
    assert.equal(isApprovalInvalidated(parsed), true);
    assert.equal(canDecideApproval(parsed), false);
  });
});

describe("approval expiry fail-closed", () => {
  it("treats elapsed expiresAt and expired status as closed", () => {
    const elapsed = approval({
      binding: binding({ expiresAt: "2020-01-01T00:00:00Z" }),
    });
    assert.equal(isApprovalExpired(elapsed), true);
    assert.equal(canDecideApproval(elapsed), false);

    const statusExpired = approval({
      status: "expired",
      validity: {
        current: false,
        reason: "expired",
        changedFields: [],
        currentBinding: null,
      },
      permittedActions: ["approve", "reject"],
    });
    assert.equal(isApprovalExpired(statusExpired), true);
    assert.equal(canDecideApproval(statusExpired), false);
  });

  it("maps expired/invalidated problem+json to fail-closed", () => {
    const expired = {
      type: "urn:flowforge:problem:approval-expired",
      title: "Expired",
      status: 409,
      detail: "Approval expiry elapsed.",
      instance: "/api/v1/approvals/" + APPROVAL_ID + "/approve",
      code: APPROVAL_PROBLEM_CODES.expired,
      request_id: "req-expired",
    };
    const invalidated = {
      ...expired,
      code: APPROVAL_PROBLEM_CODES.invalidated,
      title: "Invalidated",
      detail: "Binding no longer matches.",
    };
    assert.equal(problemClosesApproval(expired), true);
    assert.equal(problemClosesApproval(invalidated), true);
    assert.equal(expired.status, 409);
    assert.equal(typeof PROBLEM_JSON, "string");
  });
});

describe("server recheck is authoritative", () => {
  it("never treats a stale local approved flag as sufficient to dispatch", () => {
    const required: PolicyEvaluation = {
      decision: "approval_required",
      evaluationId: "eval-1",
      workflowVersionId: VERSION_ID,
      operation: "workflow.execute",
      requirements: [approval()],
    };
    assert.equal(canDispatchFromEvaluation(required), false);
    assert.equal(
      shouldBlockRun({ evaluation: required, staleLocalApproved: true }),
      true,
    );
    assert.equal(
      shouldBlockRun({ evaluation: null, staleLocalApproved: true }),
      false,
    );
    assert.equal(
      shouldBlockRun({
        evaluation: { ...required, decision: "allow", requirements: [] },
        staleLocalApproved: false,
      }),
      false,
    );
  });

  it("requires a current pending snapshot plus server permittedActions", () => {
    const noActions = approval({ permittedActions: [] });
    assert.equal(canDecideApproval(noActions), false);
    const rejected = approval({ status: "rejected" });
    assert.equal(canDecideApproval(rejected), false);
  });
});

describe("approval list and RBAC", () => {
  it("filters pending in the browser and does not invent query params", () => {
    const items = [
      approval(),
      approval({
        id: "99999999-9999-4999-8999-999999999999",
        status: "approved",
        permittedActions: [],
      }),
    ];
    assert.equal(pendingApprovals(items).length, 1);
    assert.equal(filterApprovalList(items, { status: "pending" }).length, 1);
    assert.equal(filterApprovalList(items, { q: "rollout" }).length, 2);
  });

  it("hides approvals nav when approval.view is absent", () => {
    assert.equal(canSeeApprovalsNav(null), true);
    assert.equal(canSeeApprovalsNav(["workflow.view"]), false);
    assert.equal(canSeeApprovalsNav(["approval.view"]), true);
  });

  it("recognizes execution waiting/approval states", () => {
    assert.equal(isExecutionAwaitingApproval("awaiting_approval"), true);
    assert.equal(isExecutionAwaitingApproval("pinned"), false);
  });
});

describe("secret-free approval payloads", () => {
  it("strips approval tokens and never names browser storage", () => {
    const stripped: string[] = [];
    const cleaned = stripSecretKeys(
      {
        id: APPROVAL_ID,
        status: "pending",
        approvalToken: "tok-should-never-land",
        token: "also-bad",
        binding: binding(),
      },
      stripped,
    ) as Record<string, unknown>;
    assert.equal("approvalToken" in cleaned, false);
    assert.equal("token" in cleaned, false);
    assert.ok(stripped.includes("approvalToken"));
    assert.equal(isSecretKey("decision_token"), true);
    assert.deepEqual(FORBIDDEN_APPROVAL_STORAGE, [
      "localStorage",
      "sessionStorage",
    ]);
  });

  it("parses evaluate requirements without secret fields", () => {
    const evaluation = parsePolicyEvaluation({
      decision: "approval_required",
      workflowVersionId: VERSION_ID,
      operation: "workflow.execute",
      requirements: [
        {
          id: APPROVAL_ID,
          status: "pending",
          binding: binding(),
          secret: "nope",
          permittedActions: ["approve"],
        },
      ],
    });
    assert.ok(evaluation);
    assert.equal(evaluation.decision, "approval_required");
    assert.equal(evaluation.requirements[0]?.id, APPROVAL_ID);
  });
});
