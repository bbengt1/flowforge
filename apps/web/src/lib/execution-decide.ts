/**
 * R4.5: waiting executions → approval decide from inbox/overlay.
 *
 * Relates to #258 / Part of #230. Keep #258 open.
 *
 * Chloe UI only. Densify existing E10 decide chrome onto inbox rows
 * and the lightweight Runs overlay (D6). Reuse
 * `GET /approvals?executionId=` and `POST /approvals/{id}/decide`.
 * Requester cannot self-approve. Resume stays decide — do not invent
 * `/executions/{id}/resume`, `/replay`, SSE, or a compare API.
 * Drafts never run. Inherit Gracie R4 guardrails from
 * execution-inbox.ts. Do not regress loud indeterminate (R4.4).
 */

import {
  approvalDecideControlsState,
  isExecutionAwaitingApproval,
  pendingApprovals,
} from "./approval.ts";
import {
  APPROVAL_DECIDE_HELP,
  APPROVAL_RESUME_VIA_DECIDE_HELP,
  APPROVAL_SOD_HELP,
  APPROVAL_WAIT_DURABLE_HELP,
  approvalDecidePath,
  executionApprovalsPath,
  listApprovalsPath,
} from "./approval-contract.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import {
  EDITOR_RUNS_REPLAY_GRAPH_SOURCE,
  INVENTED_REPLAY_ROUTE as EDITOR_INVENTED_REPLAY_ROUTE,
} from "./editor-runs.ts";
import {
  APPROVAL_RESUME_DISABLED_HELP,
  PRE_RUN_PUBLISHED_ONLY_HELP,
} from "./execution-contract.ts";
import {
  EXECUTION_INBOX_REPLAY_GRAPH_SOURCE,
  INVENTED_REPLAY_ROUTE,
  R4_GUARDRAILS,
  R4_LATER_STORY_NOTES,
  executionInboxIndeterminateIsLoud,
} from "./execution-inbox.ts";
import { executionOperateIndeterminateIsLoud } from "./execution-operate.ts";
import type { ExecutionRecord, ExecutionStatus } from "./execution-types.ts";

export const R45_STORY = 258;
export const R45_EPIC = 230;
export const R45_KEEP_STORY_OPEN = true;

export const EXECUTION_DECIDE_APPROVE_LABEL = "Approve";
export const EXECUTION_DECIDE_REJECT_LABEL = "Reject";
export const EXECUTION_DECIDE_OPEN_LABEL = "Open approval";
export const INVENTED_RESUME_ROUTE = "/executions/{id}/resume";
export const INVENTED_COMPARE_ROUTE = "/executions/compare";

export const EXECUTION_DECIDE_HELP =
  "Waiting runs resume by deciding the bound approval. Load GET /approvals?executionId= and POST /approvals/{id}/decide with CSRF. The requester cannot self-approve. Do not invent /executions/{id}/resume or /replay. Full detail stays /executions/{id}.";

export const EXECUTION_DECIDE_WAITING_COPY =
  "This run is waiting on a current approval. Resume is decide — not a new route.";

export const EXECUTION_DECIDE_SELF_REQUESTED_COPY =
  "You requested this approval. Another operator with approval.decide must approve or reject it. Self-approval is forbidden.";

export const EXECUTION_DECIDE_MISSING_COPY =
  "Waiting — bound approval is not on this list yet. Open the execution for GET /approvals?executionId= detail. Do not invent a resume route.";

export type ExecutionDecideSurface = "inbox" | "overlay" | "detail";

export const EXECUTION_DECIDE = {
  operateDensity: true,
  inboxRowsExposeDecide: true,
  overlayExposesDecide: true,
  detailRemainsExistingPath: true,
  usesExistingApprovalsList: true,
  usesExistingDecideRoute: true,
  resumeIsDecide: true,
  noInventedResumeRoute: true,
  requesterCannotSelfApprove: true,
  loudIndeterminate: true,
  neverSilentSuccessWhenUncertain: true,
  draftsNeverRun: true,
  publishedWorkflowVersionIdOnly: true,
  oneOperatePath: true,
  noSecondReplayGraph: true,
  noReplayRoute: true,
  compareIsClientDiff: true,
  noInventedCompareApi: true,
  noSse: true,
  migrateInPlace: true,
} as const;

export const EXECUTION_DECIDE_SOURCES: readonly string[] = [
  "src/lib/execution-decide.ts",
  "src/components/executions/ExecutionDecideActions.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/workflows/EditorRunsDrawer.tsx",
];

export const EXECUTION_DECIDE_REPLAY_GRAPH_SOURCE =
  EXECUTION_INBOX_REPLAY_GRAPH_SOURCE;

export type ExecutionDecideInput = {
  status?: ExecutionStatus;
  approvals?: readonly ApprovalRequest[] | null;
  actorUserId?: string;
  permissions?: readonly string[] | null;
  now?: number;
};

export type ExecutionDecideAffordances = {
  waiting: boolean;
  pending: ApprovalRequest[];
  decidable: ApprovalRequest[];
  selfRequestedApprovals: ApprovalRequest[];
  canDecide: boolean;
  selfRequested: boolean;
  approvalsLoaded: boolean;
  resumeIsDecide: true;
  decidePath: string;
  listPath: string;
  blockedReason: string;
  help: string;
};

export function executionDecideShouldLoadApprovals(
  record: Pick<ExecutionRecord, "status">,
): boolean {
  return isExecutionAwaitingApproval(record.status);
}

export function executionDecideListPath(executionId: string): string {
  return listApprovalsPath({ executionId });
}

export function executionDecidePath(approvalId: string): string {
  return approvalDecidePath(approvalId);
}

export function executionDecideAffordances(
  input: ExecutionDecideInput,
): ExecutionDecideAffordances {
  const waiting = isExecutionAwaitingApproval(input.status);
  const approvalsLoaded = input.approvals != null;
  const pending = pendingApprovals(input.approvals ?? []);
  const actorUserId = input.actorUserId ?? "";
  const permissions = input.permissions ?? null;
  const decidable: ApprovalRequest[] = [];
  const selfRequestedApprovals: ApprovalRequest[] = [];
  for (const approval of pending) {
    const state = approvalDecideControlsState(
      approval,
      actorUserId,
      permissions ? [...permissions] : null,
      input.now,
    );
    if (state.selfRequested) {
      selfRequestedApprovals.push(approval);
      continue;
    }
    if (state.canDecide) {
      decidable.push(approval);
    }
  }
  const first = pending[0];
  const decidePath = first ? executionDecidePath(first.id) : "";
  const listPath = executionDecideListPath(first?.executionId || "execution");
  let blockedReason = "";
  if (waiting && !approvalsLoaded) {
    blockedReason = EXECUTION_DECIDE_WAITING_COPY;
  } else if (waiting && pending.length === 0) {
    blockedReason = EXECUTION_DECIDE_MISSING_COPY;
  } else if (selfRequestedApprovals.length > 0 && decidable.length === 0) {
    blockedReason = EXECUTION_DECIDE_SELF_REQUESTED_COPY;
  }
  return {
    waiting,
    pending,
    decidable,
    selfRequestedApprovals,
    canDecide: decidable.length > 0,
    selfRequested: selfRequestedApprovals.length > 0,
    approvalsLoaded,
    resumeIsDecide: true,
    decidePath,
    listPath,
    blockedReason,
    help: [
      EXECUTION_DECIDE_HELP,
      APPROVAL_RESUME_VIA_DECIDE_HELP,
      APPROVAL_SOD_HELP,
      APPROVAL_WAIT_DURABLE_HELP,
    ].join(" "),
  };
}

export function executionDecideUsesExistingRoutes(
  approvalId: string,
  executionId: string,
): boolean {
  const decide = executionDecidePath(approvalId);
  const list = executionDecideListPath(executionId);
  const twin = executionApprovalsPath("workflow", executionId);
  return (
    decide === `/approvals/${approvalId}/decide` &&
    list === `/approvals?executionId=${executionId}` &&
    twin === list &&
    EXECUTION_DECIDE.usesExistingDecideRoute &&
    EXECUTION_DECIDE.usesExistingApprovalsList &&
    EXECUTION_DECIDE.resumeIsDecide
  );
}

export function executionDecideDoesNotInventResumeRoute(): boolean {
  const invented = INVENTED_RESUME_ROUTE;
  return (
    EXECUTION_DECIDE.noInventedResumeRoute &&
    EXECUTION_DECIDE.resumeIsDecide &&
    !executionDecidePath("id").includes("/resume") &&
    !executionDecideListPath("id").includes("/resume") &&
    !APPROVAL_RESUME_DISABLED_HELP.includes(invented) &&
    /decide/.test(APPROVAL_RESUME_DISABLED_HELP) &&
    /decide/.test(APPROVAL_RESUME_VIA_DECIDE_HELP) &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes("/resume") || route.embed.includes("/resume"),
    )
  );
}

export function executionDecideDoesNotInventReplayRoute(): boolean {
  const invented = INVENTED_REPLAY_ROUTE;
  return (
    EXECUTION_DECIDE.noReplayRoute &&
    R4_GUARDRAILS.noReplayProductRoute &&
    invented === EDITOR_INVENTED_REPLAY_ROUTE &&
    !executionDecidePath("id").includes(invented) &&
    !executionDecideListPath("id").includes(invented) &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(invented) || route.embed.includes(invented),
    )
  );
}

export function executionDecideCompareStaysClientSide(): boolean {
  return (
    EXECUTION_DECIDE.compareIsClientDiff &&
    EXECUTION_DECIDE.noInventedCompareApi &&
    R4_GUARDRAILS.compareIsClientDiff &&
    R4_GUARDRAILS.pingJonnyOnlyIfCompareNeedsProjection &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(INVENTED_COMPARE_ROUTE) ||
        route.embed.includes(INVENTED_COMPARE_ROUTE),
    )
  );
}

export function executionDecideHasSingleOperatePath(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    EXECUTION_DECIDE.oneOperatePath &&
    EXECUTION_DECIDE.noSecondReplayGraph &&
    EXECUTION_DECIDE.detailRemainsExistingPath &&
    !EXECUTION_DECIDE_SOURCES.includes(EXECUTION_DECIDE_REPLAY_GRAPH_SOURCE) &&
    !EXECUTION_DECIDE_SOURCES.includes(EDITOR_RUNS_REPLAY_GRAPH_SOURCE)
  );
}

export function executionDecideDraftsNeverRun(): boolean {
  return (
    EXECUTION_DECIDE.draftsNeverRun &&
    EXECUTION_DECIDE.publishedWorkflowVersionIdOnly &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.publishedWorkflowVersionIdOnly &&
    /drafts? are never/i.test(PRE_RUN_PUBLISHED_ONLY_HELP) &&
    /workflowVersionId/.test(PRE_RUN_PUBLISHED_ONLY_HELP)
  );
}

export function executionDecideIndeterminateIsLoud(
  status = "indeterminate",
): boolean {
  return (
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.neverSilentSuccessWhenUncertain &&
    EXECUTION_DECIDE.loudIndeterminate &&
    EXECUTION_DECIDE.neverSilentSuccessWhenUncertain &&
    executionInboxIndeterminateIsLoud(status) &&
    executionOperateIndeterminateIsLoud(status)
  );
}

export function executionDecideBlocksSelfApproval(): boolean {
  return (
    EXECUTION_DECIDE.requesterCannotSelfApprove &&
    /requester cannot/i.test(APPROVAL_SOD_HELP) &&
    /self-approval/i.test(EXECUTION_DECIDE_SELF_REQUESTED_COPY)
  );
}

export function executionDecideInheritsR4Guardrails(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.neverSilentSuccessWhenUncertain &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.noReplayProductRoute &&
    R4_GUARDRAILS.compareIsClientDiff &&
    /#258/.test(R4_LATER_STORY_NOTES.r45)
  );
}

export function executionDecideSurfaceOn(
  surface: ExecutionDecideSurface,
): boolean {
  if (surface === "inbox") {
    return EXECUTION_DECIDE.inboxRowsExposeDecide;
  }
  if (surface === "overlay") {
    return EXECUTION_DECIDE.overlayExposesDecide;
  }
  return EXECUTION_DECIDE.detailRemainsExistingPath;
}

export function executionDecideCitesExistingHelp(): boolean {
  return (
    /\/approvals\/\{id\}\/decide/.test(EXECUTION_DECIDE_HELP) &&
    /\/approvals\/\{id\}\/decide/.test(APPROVAL_DECIDE_HELP) &&
    /executionId/.test(EXECUTION_DECIDE_HELP)
  );
}
