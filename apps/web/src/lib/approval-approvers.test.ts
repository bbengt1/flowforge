import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_NOT_TARGETED_MESSAGE,
  APPROVERS_DUPLICATE_MESSAGE,
  APPROVERS_EMPTY_MESSAGE,
  APPROVERS_INVALID_ID_MESSAGE,
  APPROVERS_MAX,
  APPROVERS_TOO_MANY_MESSAGE,
  APPROVER_CANNOT_DECIDE_MESSAGE,
  APPROVER_DISABLED_MESSAGE,
  APPROVER_GROUP_NOT_FOUND_MESSAGE,
  APPROVER_NOT_MEMBER_MESSAGE,
  APPROVER_ROLE_MISMATCH_MESSAGE,
  NO_ELIGIBLE_DECIDER_CLOSE_SENTENCE,
  NO_ELIGIBLE_DECIDER_RUN_SENTENCE,
  approvalApproverSets,
  approvalCapabilityDenies,
  approvalCapabilityNotTargeted,
  approvalDecideVia,
  approvalIsAdminOverride,
  approvalPrincipalLabel,
  approverFieldForPath,
  approverGroupFieldError,
  approverPublishFieldErrors,
  approverSelectionErrors,
  approverSelectionToWith,
  approverUserFieldError,
  approversWithErrors,
  noEligibleDeciderSentence,
  parseApprovalApprovers,
  parseApprovalCapabilities,
  parseApproverCandidates,
  readApproverSelection,
  readRequirementUnresolvableCause,
  toggleApprover,
} from "./approval-approvers.ts";
import {
  approvalClosedExplanation,
  approvalDecideControlsState,
  approvalDecideOutcome,
  failClosedProblemTitle,
  parseApprovalRequest,
} from "./approval.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import {
  executionFailureReasonText,
  parseExecutionRecord,
  stepFailureErrorText,
} from "./execution.ts";
import { gateStepFailureCopy } from "./execution-replay.ts";
import { validateWizardDraft } from "./workflow-action-wizard.ts";
import { serializeNodeBlock } from "./workflow-yaml-nodes.ts";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const G1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const G2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "77777777-7777-4777-8777-777777777777";
const REQUESTER = "99999999-9999-4999-8999-999999999999";
const ACTOR = "88888888-8888-4888-8888-888888888888";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function approvalRow(extra: Record<string, unknown> = {}): ApprovalRequest {
  const parsed = parseApprovalRequest({
    id: APPROVAL_ID,
    status: "pending",
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    workflowDigest: "sha256:aaaa",
    operation: "workflow.execute",
    nodeId: "gate",
    expiresAt: "2099-01-01T00:00:00Z",
    bindingFingerprint: "fp",
    requestedBy: REQUESTER,
    approverRole: "approver",
    permittedActions: ["approve", "reject"],
    ...extra,
  });
  assert.ok(parsed);
  return parsed;
}

function problem(status: number, code: string) {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: "Forbidden",
    status,
    detail: "denied",
    instance: "/approvals/x/decide",
    code,
    request_id: "req-1",
  };
}

describe("approver sets", () => {
  it("parses users and groups, UUID rows only, first occurrence wins", () => {
    const parsed = parseApprovalApprovers({
      users: [
        { id: U1, displayName: "Ada" },
        { id: U1.toUpperCase(), displayName: "dupe" },
        { id: "not-a-uuid", displayName: "x" },
      ],
      groups: [{ id: G1, displayName: "", members: [{ id: U2 }] }],
    });
    assert.deepEqual(parsed, {
      users: [{ id: U1, displayName: "Ada" }],
      groups: [{ id: G1, displayName: "" }],
    });
    assert.equal(parseApprovalApprovers(null), undefined);
    assert.equal(parseApprovalApprovers({}), undefined);
  });

  it("labels with display name, then UUID, and never lists group members", () => {
    assert.equal(approvalPrincipalLabel({ id: U1, displayName: " Ada " }), "Ada");
    assert.equal(approvalPrincipalLabel({ id: U1, displayName: "  " }), U1);
    const sets = approvalApproverSets(
      parseApprovalApprovers({
        users: [{ id: U1, displayName: "Ada" }],
        groups: [{ id: G1, displayName: "", members: [{ id: U2, displayName: "Bo" }] }],
      }),
    );
    assert.deepEqual(sets, [
      { kind: "users", label: "People", items: [{ id: U1, label: "Ada" }] },
      { kind: "groups", label: "Groups", items: [{ id: G1, label: G1 }] },
    ]);
    assert.equal(JSON.stringify(sets).includes("Bo"), false);
    assert.deepEqual(approvalApproverSets(undefined), []);
  });

  it("parseApprovalRequest carries approvers, capabilities, and close cause", () => {
    const parsed = approvalRow({
      approvers: { users: [{ id: U1, displayName: "Ada" }], groups: [] },
      capabilities: { decide: { allowed: true, via: "target" } },
      closeReasonDetails: { cause: "no_eligible_decider" },
    });
    assert.deepEqual(parsed.approvers, { users: [{ id: U1, displayName: "Ada" }], groups: [] });
    assert.deepEqual(parsed.capabilities, { decide: { allowed: true, via: "target" } });
    assert.equal(parsed.closeReasonCause, "no_eligible_decider");
    const plain = approvalRow();
    assert.equal(plain.approvers, undefined);
    assert.equal(plain.capabilities, undefined);
    assert.equal(plain.closeReasonCause, undefined);
  });
});

describe("decide via", () => {
  it("parses capabilities and fails closed on an unknown via", () => {
    assert.deepEqual(parseApprovalCapabilities({ decide: { allowed: true, via: "admin_override" } }), {
      decide: { allowed: true, via: "admin_override" },
    });
    assert.equal(parseApprovalCapabilities({ decide: { allowed: true, via: "magic" } }), undefined);
    assert.equal(parseApprovalCapabilities({ decide: { allowed: true } }), undefined);
    assert.deepEqual(parseApprovalCapabilities({ decide: { allowed: false, code: "self_approval" } }), {
      decide: { allowed: false, code: "self_approval" },
    });
    assert.deepEqual(parseApprovalCapabilities({ decide: { allowed: false, code: "weird" } }), {
      decide: { allowed: false, code: "" },
    });
    assert.equal(parseApprovalCapabilities(null), undefined);
  });

  it("reads via, override only while pending, and denial codes", () => {
    const override = { capabilities: parseApprovalCapabilities({ decide: { allowed: true, via: "admin_override" } }) };
    const target = { capabilities: parseApprovalCapabilities({ decide: { allowed: true, via: "target" } }) };
    const notTargeted = {
      capabilities: parseApprovalCapabilities({ decide: { allowed: false, code: "approver_not_targeted" } }),
    };
    assert.equal(approvalDecideVia(override), "admin_override");
    assert.equal(approvalDecideVia(target), "target");
    assert.equal(approvalDecideVia(notTargeted), null);
    assert.equal(approvalIsAdminOverride({ ...override, status: "pending" }), true);
    assert.equal(approvalIsAdminOverride({ ...override, status: "approved" }), false);
    assert.equal(approvalIsAdminOverride({ ...target, status: "pending" }), false);
    assert.equal(approvalCapabilityNotTargeted(notTargeted), true);
    assert.equal(approvalCapabilityDenies(notTargeted), true);
    assert.equal(approvalCapabilityDenies({}), false);
  });

  it("controls state: override needs confirm, target does not, server denial disables", () => {
    const perms = ["approval.decide"];
    const override = approvalDecideControlsState(
      approvalRow({ capabilities: { decide: { allowed: true, via: "admin_override" } } }),
      ACTOR,
      perms,
    );
    assert.equal(override.canDecide, true);
    assert.equal(override.adminOverride, true);
    const target = approvalDecideControlsState(
      approvalRow({ capabilities: { decide: { allowed: true, via: "target" } } }),
      ACTOR,
      perms,
    );
    assert.equal(target.canDecide, true);
    assert.equal(target.adminOverride, false);
    const denied = approvalDecideControlsState(
      approvalRow({ capabilities: { decide: { allowed: false, code: "approver_not_targeted" } } }),
      ACTOR,
      perms,
    );
    assert.equal(denied.canDecide, false);
    assert.equal(denied.notTargeted, true);
    assert.equal(denied.adminOverride, false);
    // A requester reached through a group still gets self_approval from the server.
    const requester = approvalDecideControlsState(
      approvalRow({ capabilities: { decide: { allowed: false, code: "self_approval" } } }),
      ACTOR,
      perms,
    );
    assert.equal(requester.canDecide, false);
    assert.equal(requester.selfRequested, true);
    assert.equal(requester.notTargeted, false);
  });

  it("maps 403 approver_not_targeted to a plain sentence", () => {
    const outcome = approvalDecideOutcome(problem(403, "approver_not_targeted"));
    assert.equal(outcome.kind, "wrong-approver");
    assert.equal("message" in outcome ? outcome.message : "", APPROVAL_NOT_TARGETED_MESSAGE);
    assert.equal(failClosedProblemTitle(problem(403, "approver_not_targeted")), "Not a named approver");
    const generic = approvalDecideOutcome(problem(403, "forbidden"));
    assert.equal(generic.kind, "wrong-approver");
    assert.notEqual("message" in generic ? generic.message : "", APPROVAL_NOT_TARGETED_MESSAGE);
  });
});

describe("no_eligible_decider", () => {
  it("returns the sentence only for requirement_unresolvable with the cause", () => {
    assert.equal(
      noEligibleDeciderSentence({ reason: "requirement_unresolvable", cause: "no_eligible_decider" }),
      NO_ELIGIBLE_DECIDER_RUN_SENTENCE,
    );
    assert.equal(noEligibleDeciderSentence({ reason: "requirement_unresolvable", cause: "" }), null);
    assert.equal(noEligibleDeciderSentence({ reason: "canceled", cause: "no_eligible_decider" }), null);
    assert.equal(readRequirementUnresolvableCause({ cause: "no_eligible_decider" }), "no_eligible_decider");
    assert.equal(readRequirementUnresolvableCause({ cause: "other" }), "");
    assert.equal(readRequirementUnresolvableCause(null), "");
  });

  it("run failure text reads the run cause, then a failed step's cause", () => {
    assert.equal(
      executionFailureReasonText({
        status: "failed",
        statusReason: "requirement_unresolvable",
        statusReasonCause: "no_eligible_decider",
      }),
      NO_ELIGIBLE_DECIDER_RUN_SENTENCE,
    );
    assert.equal(
      executionFailureReasonText({
        status: "failed",
        statusReason: "requirement_unresolvable",
        steps: [
          {
            status: "failed",
            error: { code: "requirement_unresolvable", details: { cause: "no_eligible_decider" } },
          },
        ],
      }),
      NO_ELIGIBLE_DECIDER_RUN_SENTENCE,
    );
    const generic = executionFailureReasonText({
      status: "failed",
      statusReason: "requirement_unresolvable",
    });
    assert.notEqual(generic, NO_ELIGIBLE_DECIDER_RUN_SENTENCE);
  });

  it("parses statusReasonDetails.cause from the execution record", () => {
    const record = parseExecutionRecord({
      id: APPROVAL_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      status: "failed",
      statusReason: "requirement_unresolvable",
      statusReasonDetails: { cause: "no_eligible_decider" },
    });
    assert.equal(record?.statusReasonCause, "no_eligible_decider");
    const bare = parseExecutionRecord({
      id: APPROVAL_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      status: "failed",
    });
    assert.equal(bare?.statusReasonCause, undefined);
  });

  it("step text and gate copy use the step's error.details.cause", () => {
    const step = {
      nodeType: "flow.approval",
      status: "failed",
      error: { code: "requirement_unresolvable", details: { cause: "no_eligible_decider" } },
    };
    assert.equal(stepFailureErrorText(step), NO_ELIGIBLE_DECIDER_RUN_SENTENCE);
    assert.equal(gateStepFailureCopy(step), NO_ELIGIBLE_DECIDER_RUN_SENTENCE);
    const codeOnly = { ...step, error: { code: "requirement_unresolvable" } };
    assert.notEqual(gateStepFailureCopy(codeOnly), NO_ELIGIBLE_DECIDER_RUN_SENTENCE);
  });

  it("closed approval uses the cause, and degrades without it", () => {
    assert.equal(
      approvalClosedExplanation({
        status: "canceled",
        closeReason: "requirement_unresolvable",
        closeReasonCause: "no_eligible_decider",
      }),
      NO_ELIGIBLE_DECIDER_CLOSE_SENTENCE,
    );
    const noCause = approvalClosedExplanation({ status: "canceled", closeReason: "requirement_unresolvable" });
    assert.notEqual(noCause, NO_ELIGIBLE_DECIDER_CLOSE_SENTENCE);
    // Any requirement that couldn't be rebuilt (a disabled policy too),
    // not only "no one eligible".
    assert.equal(
      noCause,
      "Closed because its approval requirement could no longer be met.",
    );
    assert.equal(
      NO_ELIGIBLE_DECIDER_CLOSE_SENTENCE,
      "Closed because no one other than the requester could approve it.",
    );
    assert.equal(
      NO_ELIGIBLE_DECIDER_RUN_SENTENCE,
      "No one other than the requester can approve this step, so it failed right away.",
    );
    assert.equal(/no_eligible_decider|requirement_unresolvable/.test(noCause ?? ""), false);
    const bare = approvalClosedExplanation({ status: "canceled" });
    assert.equal(/no_eligible_decider|requirement_unresolvable/.test(bare ?? ""), false);
  });
});

describe("approver picker", () => {
  it("parses candidates as {users, groups}", () => {
    assert.deepEqual(
      parseApproverCandidates({ users: [{ id: U1, displayName: "Ada" }], groups: [{ id: G1, displayName: "Ops" }] }),
      { users: [{ id: U1, displayName: "Ada" }], groups: [{ id: G1, displayName: "Ops" }] },
    );
    assert.equal(parseApproverCandidates({ items: [] }), null);
  });

  it("toggles ids, refuses to add past the cap, and writes undefined when empty", () => {
    let selection = readApproverSelection(undefined);
    selection = toggleApprover(selection, "users", U1);
    selection = toggleApprover(selection, "groups", G1);
    assert.deepEqual(approverSelectionToWith(selection), { users: [U1], groups: [G1] });
    selection = toggleApprover(selection, "users", U1.toUpperCase());
    assert.deepEqual(approverSelectionToWith(selection), { groups: [G1] });
    selection = toggleApprover(selection, "groups", G1);
    assert.equal(approverSelectionToWith(selection), undefined);

    const full = { users: Array.from({ length: APPROVERS_MAX }, (_, i) => uuid(i + 1)), groups: [] };
    assert.equal(toggleApprover(full, "groups", G2), full);
  });

  it("enforces 1–25 combined, no duplicates, UUIDs only", () => {
    assert.deepEqual(approverSelectionErrors({ users: [U1, U2], groups: [G1] }), []);
    assert.deepEqual(approverSelectionErrors({ users: [U1, U1.toUpperCase()], groups: [] }), [
      APPROVERS_DUPLICATE_MESSAGE,
    ]);
    assert.deepEqual(approverSelectionErrors({ users: ["nope"], groups: [] }), [APPROVERS_INVALID_ID_MESSAGE]);
    const tooMany = {
      users: Array.from({ length: 20 }, (_, i) => uuid(i + 1)),
      groups: Array.from({ length: 6 }, (_, i) => uuid(i + 100)),
    };
    assert.deepEqual(approverSelectionErrors(tooMany), [APPROVERS_TOO_MANY_MESSAGE]);
    assert.deepEqual(approversWithErrors(undefined), []);
    assert.deepEqual(approversWithErrors({}), [APPROVERS_EMPTY_MESSAGE]);
    assert.deepEqual(approversWithErrors("x"), [APPROVERS_INVALID_ID_MESSAGE]);
    assert.deepEqual(approversWithErrors({ users: [U1], groups: [G1] }), []);
  });

  it("wizard validation blocks bad approvers on flow.approval", () => {
    const draft = {
      type: "flow.approval",
      name: "Gate",
      with: { approverRole: "approver", expiresIn: "PT30M", approvers: { users: [U1, U1] } },
      credentialId: "",
      credentialDisplayName: "",
      mappings: [],
    };
    const bad = validateWizardDraft(draft, null);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes(APPROVERS_DUPLICATE_MESSAGE));
    const good = validateWizardDraft(
      { ...draft, with: { ...draft.with, approvers: { users: [U1], groups: [G1] } } },
      null,
    );
    assert.equal(good.errors.includes(APPROVERS_DUPLICATE_MESSAGE), false);
    assert.equal(good.errors.some((error) => error.startsWith("approvers")), false);
  });

  it("serializes with.approvers users and groups into YAML", () => {
    const block = serializeNodeBlock({
      id: "gate",
      type: "flow.approval",
      name: "Gate",
      with: { approverRole: "approver", approvers: { users: [U1], groups: [G1, G2] } },
    });
    assert.match(
      block,
      new RegExp(
        `approvers:\\n {10}users:\\n {12}- ${U1}\\n {10}groups:\\n {12}- ${G1}\\n {12}- ${G2}\\n`,
      ),
    );
  });
});

describe("publish field errors", () => {
  it("places errors by spec.nodes[N] path only", () => {
    assert.equal(approverFieldForPath("spec.nodes[2].with.approvers.groups[0]"), "groups");
    assert.equal(approverFieldForPath("spec.nodes[0].with.approvers.users[3]"), "users");
    assert.equal(approverFieldForPath("spec.nodes[0].with.approvers"), null);
    assert.equal(approverFieldForPath("spec.nodes[0].with.approverRole"), null);
    assert.equal(approverFieldForPath(undefined), null);
  });

  it("maps group and people codes to plain sentences", () => {
    assert.equal(
      approverGroupFieldError({ path: "spec.nodes[2].with.approvers.groups[0]", code: "approver-group-not-found" }),
      APPROVER_GROUP_NOT_FOUND_MESSAGE,
    );
    assert.equal(
      approverGroupFieldError({ path: "spec.nodes[2].with.approvers.users[0]", code: "approver-group-not-found" }),
      null,
    );
    const users = "spec.nodes[1].with.approvers.users[0]";
    assert.equal(approverUserFieldError({ path: users, code: "approver-not-member" }), APPROVER_NOT_MEMBER_MESSAGE);
    assert.equal(approverUserFieldError({ path: users, code: "approver-disabled" }), APPROVER_DISABLED_MESSAGE);
    assert.equal(approverUserFieldError({ path: users, code: "approver-cannot-decide" }), APPROVER_CANNOT_DECIDE_MESSAGE);
    assert.equal(approverUserFieldError({ path: users, code: "approver-role-mismatch" }), APPROVER_ROLE_MISMATCH_MESSAGE);
    assert.equal(approverUserFieldError({ path: users, code: "other" }), null);
  });

  it("collects approver errors under field labels and keeps other messages", () => {
    const items = approverPublishFieldErrors({
      errors: [
        { path: "spec.nodes[2].with.approvers.groups[0]", code: "approver-group-not-found", message: "server" },
        { path: "spec.nodes[2].with.approvers.users[1]", code: "approver-new-code", message: "Server text." },
        { path: "spec.nodes[0].with.approverRole", code: "x", message: "ignored" },
      ],
    });
    assert.deepEqual(items, [
      {
        field: "groups",
        label: "Approver groups",
        path: "spec.nodes[2].with.approvers.groups[0]",
        message: APPROVER_GROUP_NOT_FOUND_MESSAGE,
      },
      {
        field: "users",
        label: "Approver people",
        path: "spec.nodes[2].with.approvers.users[1]",
        message: "Server text.",
      },
    ]);
    assert.deepEqual(approverPublishFieldErrors(null), []);
  });
});
