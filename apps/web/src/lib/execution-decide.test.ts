import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ApprovalBinding, ApprovalRequest } from "./approval-types.ts";
import {
  EXECUTION_DECIDE,
  EXECUTION_DECIDE_APPROVE_LABEL,
  EXECUTION_DECIDE_HELP,
  EXECUTION_DECIDE_OPEN_LABEL,
  EXECUTION_DECIDE_REJECT_LABEL,
  EXECUTION_DECIDE_REPLAY_GRAPH_SOURCE,
  EXECUTION_DECIDE_SELF_REQUESTED_COPY,
  EXECUTION_DECIDE_SOURCES,
  EXECUTION_DECIDE_WAITING_COPY,
  INVENTED_COMPARE_ROUTE,
  INVENTED_RESUME_ROUTE,
  R45_EPIC,
  R45_KEEP_STORY_OPEN,
  R45_STORY,
  executionDecideAffordances,
  executionDecideBlocksSelfApproval,
  executionDecideCitesExistingHelp,
  executionDecideCompareStaysClientSide,
  executionDecideDoesNotInventReplayRoute,
  executionDecideDoesNotInventResumeRoute,
  executionDecideDraftsNeverRun,
  executionDecideHasSingleOperatePath,
  executionDecideIndeterminateIsLoud,
  executionDecideInheritsR4Guardrails,
  executionDecideListPath,
  executionDecidePath,
  executionDecideShouldLoadApprovals,
  executionDecideSurfaceOn,
  executionDecideUsesExistingRoutes,
} from "./execution-decide.ts";
import { R4_GUARDRAILS, R4_LATER_STORY_NOTES } from "./execution-inbox.ts";
import type { ExecutionRecord } from "./execution-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUESTER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "rollout",
    workflowSlug: "rollout",
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionNumber: 3,
    workflowDigest: "sha256:abcdef0123456789",
    status: "waiting",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "",
    createdAt: "2026-09-09T01:00:00.000Z",
    updatedAt: "2026-09-09T01:00:00.000Z",
    retentionUntil: "2026-12-08T01:00:00.000Z",
    correlationId: "corr-16-characters",
    idempotencyKey: "deploy-prod-1",
    replayed: false,
    requestedBy: "operator-chloe",
    triggerId: "",
    input: { token: "[redacted]" },
    policySnapshot: null,
    permittedActions: [],
    ...overrides,
  };
}

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionDigest: "sha256:aaaa",
    targetId: "44444444-4444-4444-8444-444444444444",
    targetKind: "cluster_target",
    targetName: "prod",
    targetVersionId: "",
    targetDigest: "",
    policyResourceId: "55555555-5555-4555-8555-555555555555",
    policyRevisionId: "55555555-5555-4555-8555-555555555555",
    policyRevisionNumber: 1,
    policyDigest: "sha256:policy1",
    operation: "workflow.execute",
    nodeId: "approve",
    nodeName: "Approve",
    expiresAt: "2099-01-01T00:00:00Z",
    bindingFingerprint: "fp-1",
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: APPROVAL_ID,
    status: "pending",
    binding: binding(),
    validity: {
      current: true,
      reason: "pending",
      changedFields: [],
      currentBinding: null,
    },
    requestedBy: REQUESTER_ID,
    requestedAt: "2026-09-09T00:00:00Z",
    decidedBy: "",
    decidedAt: "",
    note: "",
    workflowId: WORKFLOW_ID,
    workflowName: "rollout",
    executionId: EXECUTION_ID,
    executionStatus: "waiting",
    approverRole: "approver",
    permittedActions: ["approve", "reject"],
    ...overrides,
  };
}

describe("R4.5 waiting → decide density", () => {
  it("keeps #258 open and cites epic #230", () => {
    assert.equal(R45_STORY, 258);
    assert.equal(R45_EPIC, 230);
    assert.equal(R45_KEEP_STORY_OPEN, true);
    assert.equal(executionDecideInheritsR4Guardrails(), true);
    assert.equal(R4_GUARDRAILS.oneOperatePath, true);
    assert.equal(R4_GUARDRAILS.loudIndeterminate, true);
    assert.equal(R4_GUARDRAILS.draftsNeverRun, true);
    assert.match(R4_LATER_STORY_NOTES.r45, /#258/);
    assert.match(EXECUTION_DECIDE_HELP, /\/approvals\/\{id\}\/decide/);
    assert.match(EXECUTION_DECIDE_HELP, /executionId/);
    assert.equal(EXECUTION_DECIDE_APPROVE_LABEL, "Approve");
    assert.equal(EXECUTION_DECIDE_REJECT_LABEL, "Reject");
    assert.equal(EXECUTION_DECIDE_OPEN_LABEL, "Open approval");
    assert.ok(
      EXECUTION_DECIDE_SOURCES.includes(
        "src/components/executions/ExecutionDecideActions.tsx",
      ),
    );
    assert.equal(executionDecideCitesExistingHelp(), true);
  });

  it("loads GET /approvals?executionId= only for waiting executions", () => {
    assert.equal(executionDecideShouldLoadApprovals(record()), true);
    assert.equal(
      executionDecideShouldLoadApprovals(record({ status: "awaiting_approval" })),
      true,
    );
    assert.equal(
      executionDecideShouldLoadApprovals(record({ status: "running" })),
      false,
    );
    assert.equal(
      executionDecideShouldLoadApprovals(record({ status: "indeterminate" })),
      false,
    );
    const unloaded = executionDecideAffordances({ status: "waiting" });
    assert.equal(unloaded.waiting, true);
    assert.equal(unloaded.approvalsLoaded, false);
    assert.equal(unloaded.canDecide, false);
    assert.match(unloaded.blockedReason, /Waiting/);
    assert.match(EXECUTION_DECIDE_WAITING_COPY, /decide/);
  });

  it("offers decide on pending bound approvals and blocks the requester", () => {
    const other = executionDecideAffordances({
      status: "waiting",
      approvals: [approval()],
      actorUserId: ACTOR_ID,
      permissions: ["approval.decide", "approval.view"],
    });
    assert.equal(other.waiting, true);
    assert.equal(other.canDecide, true);
    assert.equal(other.selfRequested, false);
    assert.equal(other.decidable[0]?.id, APPROVAL_ID);
    assert.equal(other.resumeIsDecide, true);
    assert.equal(other.decidePath, `/approvals/${APPROVAL_ID}/decide`);

    const requester = executionDecideAffordances({
      status: "waiting",
      approvals: [approval()],
      actorUserId: REQUESTER_ID,
      permissions: ["approval.decide", "approval.view"],
    });
    assert.equal(requester.canDecide, false);
    assert.equal(requester.selfRequested, true);
    assert.equal(requester.selfRequestedApprovals[0]?.id, APPROVAL_ID);
    assert.match(requester.blockedReason, /Self-approval is forbidden/);
    assert.match(EXECUTION_DECIDE_SELF_REQUESTED_COPY, /approval\.decide/);

    const viewer = executionDecideAffordances({
      status: "waiting",
      approvals: [approval()],
      actorUserId: ACTOR_ID,
      permissions: ["approval.view"],
    });
    assert.equal(viewer.canDecide, false);

    const decided = executionDecideAffordances({
      status: "waiting",
      approvals: [approval({ status: "approved" })],
      actorUserId: ACTOR_ID,
      permissions: ["approval.decide"],
    });
    assert.equal(decided.canDecide, false);
    assert.equal(decided.pending.length, 0);
    assert.equal(executionDecideBlocksSelfApproval(), true);
  });

  it("reuses existing decide/list routes and invents neither resume nor /replay", () => {
    assert.equal(
      executionDecideListPath(EXECUTION_ID),
      `/approvals?executionId=${EXECUTION_ID}`,
    );
    assert.equal(
      executionDecidePath(APPROVAL_ID),
      `/approvals/${APPROVAL_ID}/decide`,
    );
    assert.equal(executionDecideUsesExistingRoutes(APPROVAL_ID, EXECUTION_ID), true);
    assert.equal(executionDecideDoesNotInventResumeRoute(), true);
    assert.equal(executionDecideDoesNotInventReplayRoute(), true);
    assert.equal(executionDecideCompareStaysClientSide(), true);
    assert.equal(executionDecideHasSingleOperatePath(), true);
    assert.equal(executionDecideDraftsNeverRun(), true);
    assert.equal(executionDecideIndeterminateIsLoud(), true);
    assert.equal(executionDecideIndeterminateIsLoud("succeeded"), false);
    assert.equal(executionDecideSurfaceOn("inbox"), true);
    assert.equal(executionDecideSurfaceOn("overlay"), true);
    assert.equal(INVENTED_RESUME_ROUTE, "/executions/{id}/resume");
    assert.equal(INVENTED_COMPARE_ROUTE, "/executions/compare");
    assert.equal(
      EXECUTION_DECIDE_SOURCES.includes(EXECUTION_DECIDE_REPLAY_GRAPH_SOURCE),
      false,
    );
    assert.equal(EXECUTION_DECIDE.noSse, true);
    assert.equal(EXECUTION_DECIDE.migrateInPlace, true);
  });

  it("densifies inbox rows and the overlay in place without a second replay graph", () => {
    const actions = source("components/executions/ExecutionDecideActions.tsx");
    const inbox = source("components/executions/ExecutionHistory.tsx");
    const listbox = source("components/executions/ExecutionHistoryListbox.tsx");
    const overlay = source("components/workflows/EditorRunsDrawer.tsx");
    assert.match(actions, /data-execution-decide/);
    assert.match(actions, /approveApproval|decideApproval/);
    assert.match(actions, /rejectApproval|decideApproval/);
    assert.match(actions, /executionDecideAffordances/);
    assert.doesNotMatch(actions, /ExecutionReplay/);
    assert.doesNotMatch(actions, /\/executions\/\{?id\}?\/resume/);
    assert.doesNotMatch(actions, /\/replay/);
    assert.doesNotMatch(actions, /EventSource|text\/event-stream/);
    assert.match(inbox, /ExecutionDecideActions/);
    assert.match(inbox, /listExecutionApprovals/);
    assert.match(listbox, /operateActions|data-execution-decide/);
    assert.match(overlay, /ExecutionDecideActions/);
    assert.match(overlay, /listExecutionApprovals/);
    assert.doesNotMatch(inbox, /ExecutionReplay/);
    assert.doesNotMatch(overlay, /ExecutionReplay/);
    assert.doesNotMatch(overlay, /\/executions\/.*\/resume/);
    assert.equal(EXECUTION_DECIDE.inboxRowsExposeDecide, true);
    assert.equal(EXECUTION_DECIDE.overlayExposesDecide, true);
  });
});
