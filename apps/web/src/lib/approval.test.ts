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
  isExpiredApprovalProblem,
  isInvalidatedApprovalProblem,
  isSecretKey,
  isSelfApprovalProblem,
  parseApprovalRequest,
  parsePolicyEvaluation,
  pendingApprovals,
  problemClosesApproval,
  publishInvalidatesApprovals,
  shouldBlockRun,
  stripSecretKeys,
} from "./approval.ts";
import {
  APPROVAL_PROBLEM_CODES,
  APPROVAL_SOD_HELP,
  APPROVAL_WAIT_DURABLE_HELP,
  E10_APPROVAL_DECIDE_ENABLED,
  E10_APPROVAL_WAIT_DURABLE,
  EXPIRED_APPROVAL_DETAIL,
  INVALIDATED_APPROVAL_DETAIL,
  SELF_APPROVAL_DETAIL,
} from "./approval-contract.ts";
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
    targetVersionId: "",
    targetDigest: "",
    policyResourceId: POLICY_ID,
    policyRevisionId: POLICY_ID,
    policyRevisionNumber: 1,
    policyDigest: "sha256:policy1",
    operation: "workflow.execute",
    nodeId: "",
    nodeName: "",
    expiresAt: "2099-01-01T00:00:00Z",
    bindingFingerprint: "fp-1",
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
    approverRole: "approver",
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

  it("parses a flat #44 record into the nested binding view", () => {
    const parsed = parseApprovalRequest({
      id: APPROVAL_ID,
      status: "pending",
      workflowId: "77777777-7777-4777-8777-777777777777",
      workflowVersionId: VERSION_ID,
      workflowDigest: "sha256:aaaa",
      targetId: TARGET_ID,
      targetKind: "cluster_target",
      policyResourceId: POLICY_ID,
      policyVersionId: POLICY_ID,
      policyRevision: 2,
      operation: "k8s.apply",
      nodeId: "deploy",
      expiresAt: "2099-01-01T00:00:00Z",
      bindingFingerprint: "fp-flat",
      requestedBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      approverRole: "approver",
    });
    assert.ok(parsed);
    assert.equal(parsed.binding.workflowVersionDigest, "sha256:aaaa");
    assert.equal(parsed.binding.policyRevisionNumber, 2);
    assert.equal(parsed.binding.operation, "k8s.apply");
    assert.equal(parsed.binding.nodeId, "deploy");
    assert.equal(canDecideApproval(parsed), true);
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

  it("maps conflict+detail and aliases to fail-closed", () => {
    const expired = {
      type: "urn:flowforge:problem:conflict",
      title: "Conflict",
      status: 409,
      detail: EXPIRED_APPROVAL_DETAIL,
      instance: "/api/v1/approvals/" + APPROVAL_ID + "/decide",
      code: APPROVAL_PROBLEM_CODES.conflict,
      request_id: "req-expired",
    };
    const invalidated = {
      ...expired,
      detail: INVALIDATED_APPROVAL_DETAIL,
    };
    const aliased = {
      ...expired,
      code: APPROVAL_PROBLEM_CODES.expired,
      detail: "Approval expiry elapsed.",
    };
    assert.equal(isExpiredApprovalProblem(expired), true);
    assert.equal(isInvalidatedApprovalProblem(invalidated), true);
    assert.equal(problemClosesApproval(expired), true);
    assert.equal(problemClosesApproval(invalidated), true);
    assert.equal(problemClosesApproval(aliased), true);
    assert.equal(expired.status, 409);
    assert.equal(typeof PROBLEM_JSON, "string");
  });

  it("surfaces self-approval as 403 without treating it as expired", () => {
    const self = {
      type: "urn:flowforge:problem:forbidden",
      title: "Forbidden",
      status: 403,
      detail: SELF_APPROVAL_DETAIL,
      instance: "/api/v1/approvals/" + APPROVAL_ID + "/decide",
      code: APPROVAL_PROBLEM_CODES.forbidden,
      request_id: "req-self",
    };
    assert.equal(isSelfApprovalProblem(self), true);
    assert.equal(isExpiredApprovalProblem(self), false);
    assert.equal(isInvalidatedApprovalProblem(self), false);
  });
});

describe("server recheck is authoritative", () => {
  it("never treats a stale local approved flag as sufficient to dispatch", () => {
    const required: PolicyEvaluation = {
      decision: "approval-required",
      dispatchAllowed: false,
      evaluationId: "eval-1",
      workflowVersionId: VERSION_ID,
      workflowDigest: "sha256:aaaa",
      operation: "workflow.execute",
      requirements: [],
      approvals: [approval()],
      denied: [],
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
        evaluation: {
          ...required,
          decision: "allow",
          dispatchAllowed: true,
          approvals: [],
        },
        staleLocalApproved: false,
      }),
      false,
    );
    assert.equal(
      canDispatchFromEvaluation({
        ...required,
        approvals: [approval({ status: "approved" })],
      }),
      true,
    );
  });

  it("allows decide when the API omits permittedActions", () => {
    const noActions = approval({ permittedActions: [] });
    assert.equal(canDecideApproval(noActions), true);
    const rejected = approval({ status: "rejected" });
    assert.equal(canDecideApproval(rejected), false);
  });

  it("hides decide when the workspace principal is the requester", () => {
    const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const own = approval({ requestedBy: actor });
    assert.equal(canDecideApproval(own, Date.now(), actor), false);
    assert.equal(canDecideApproval(own, Date.now(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), true);
    assert.equal(canDecideApproval(own, Date.now(), "approver-chloe"), true);
  });
});

describe("approval list and RBAC", () => {
  it("filters pending in the browser", () => {
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
    assert.equal(isExecutionAwaitingApproval("approval-required"), true);
    assert.equal(isExecutionAwaitingApproval("pinned"), false);
  });

  it("invalidates prior approvals after target or policy publish", () => {
    assert.equal(publishInvalidatesApprovals("policy"), true);
    assert.equal(publishInvalidatesApprovals("cluster_target"), true);
    assert.equal(publishInvalidatesApprovals("ssh_target"), true);
    assert.equal(publishInvalidatesApprovals("command_profile"), false);
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

  it("parses evaluate requirements and dispatchAllowed from #44", () => {
    const evaluation = parsePolicyEvaluation({
      decision: "approval-required",
      dispatchAllowed: false,
      workflowVersionId: VERSION_ID,
      workflowDigest: "sha256:aaaa",
      requirements: [
        {
          operation: "workflow.execute",
          nodeId: "gate",
          reason: "policy.requireApproval",
          approverRole: "approver",
        },
      ],
      approvals: [
        {
          id: APPROVAL_ID,
          status: "pending",
          workflowVersionId: VERSION_ID,
          workflowDigest: "sha256:aaaa",
          operation: "workflow.execute",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
      denied: [],
    });
    assert.ok(evaluation);
    assert.equal(evaluation.decision, "approval-required");
    assert.equal(evaluation.dispatchAllowed, false);
    assert.equal(evaluation.requirements[0]?.operation, "workflow.execute");
    assert.equal(evaluation.approvals[0]?.id, APPROVAL_ID);
  });

  it("parses evaluate operations retry fields from #90", () => {
    const evaluation = parsePolicyEvaluation({
      decision: "allow",
      dispatchAllowed: true,
      operations: [
        {
          nodeId: "run",
          operation: "ssh.run",
          retrySafe: true,
          retryMaxAttempts: 2,
          retryAllowed: false,
          verificationDeclared: true,
        },
      ],
      requirements: [],
      denied: [],
    });
    assert.ok(evaluation);
    assert.equal(evaluation.operations?.[0]?.operation, "ssh.run");
    assert.equal(evaluation.operations?.[0]?.retrySafe, true);
    assert.equal(evaluation.operations?.[0]?.retryMaxAttempts, 2);
    assert.equal(evaluation.operations?.[0]?.retryAllowed, false);
    assert.equal(evaluation.operations?.[0]?.verificationDeclared, true);
  });
});

describe("E10.3 approval decide contract", () => {
  it("enables durable wait and SoD decide copy without inventing resume", () => {
    assert.equal(E10_APPROVAL_DECIDE_ENABLED, true);
    assert.equal(E10_APPROVAL_WAIT_DURABLE, true);
    assert.match(APPROVAL_SOD_HELP, /requester cannot/);
    assert.match(APPROVAL_WAIT_DURABLE_HELP, /survives/);
    assert.match(APPROVAL_WAIT_DURABLE_HELP, /decide/);
  });
});
