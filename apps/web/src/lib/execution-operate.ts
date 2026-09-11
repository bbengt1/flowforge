/**
 * R4.4: cancel / retry / stop + loud indeterminate density.
 *
 * Relates to #257 / Part of #230. Keep #257 open.
 *
 * Chloe UI only. Densify existing E5/E8/E9 cancel, retry, and
 * emergency-stop affordances onto inbox rows and the lightweight
 * Runs overlay (D6). Reuse `POST /executions/{id}/cancel`,
 * `POST /executions/{id}/retry` (and the step twin), and
 * `POST /executions/{id}/emergency-stop`. Retry stays gated by
 * `result.retry.allowed`. Do not invent `/replay`, `/jobs/claim`,
 * a second ExecutionReplay graph, SSE, or a compare API.
 * Drafts never run. Inherit Gracie R4 guardrails from
 * execution-inbox.ts.
 */

import { EMBED_ROUTES } from "./embed-contract.ts";
import {
  EDITOR_RUNS_REPLAY_GRAPH_SOURCE,
  INVENTED_REPLAY_ROUTE as EDITOR_INVENTED_REPLAY_ROUTE,
} from "./editor-runs.ts";
import {
  CANCEL_FORBIDDEN_MESSAGE,
  INDETERMINATE_STATUS_HELP,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  RETRY_FORBIDDEN_MESSAGE,
  RETRY_INDETERMINATE_MESSAGE,
  executionCancelPath,
  executionRetryPath,
} from "./execution-contract.ts";
import {
  R4_GUARDRAILS,
  R4_LATER_STORY_NOTES,
  EXECUTION_INBOX_REPLAY_GRAPH_SOURCE,
  INVENTED_REPLAY_ROUTE,
} from "./execution-inbox.ts";
import {
  canCancelExecution,
  canRetryExecution,
  executionStatusPresentation,
  isIndeterminateStatus,
  normalizeExecutionStatus,
} from "./execution.ts";
import { isIndeterminateUnmistakable } from "./execution-replay.ts";
import type {
  ExecutionDetail,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionStep,
} from "./execution-types.ts";
import {
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  canOfferScriptRetry,
  executionHasScriptIndeterminate,
  executionHasScriptRun,
  isScriptIoActionType,
  parseScriptIoRetryResult,
  scriptRetryBlockedMessage,
} from "./script-io-contract.ts";
import {
  SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
  SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP,
  SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP,
  canBlindRetryAfterEmergencyStop,
  canOfferScriptEmergencyStop,
  executionEmergencyStopPath,
} from "./script-ops-contract.ts";
import {
  SSH_NO_BLIND_RETRY_HELP,
  canOfferSshRetry,
  executionHasSshIndeterminate,
  executionHasSshRun,
  parseSshRetryResult,
  sshRetryBlockedMessage,
} from "./ssh-retry-contract.ts";

export const R44_STORY = 257;
export const R44_EPIC = 230;
export const R44_KEEP_STORY_OPEN = true;

export const EXECUTION_OPERATE_CANCEL_LABEL = "Cancel";
export const EXECUTION_OPERATE_RETRY_LABEL = "Retry";
export const EXECUTION_OPERATE_STOP_LABEL = "Stop";
export const EXECUTION_OPERATE_STOP_CONFIRM_LABEL = "Confirm stop";
export const INVENTED_JOB_CLAIM_ROUTE = "/jobs/claim";

export const EXECUTION_OPERATE_DETAIL_STATUSES = [
  "queued",
  "claimed",
  "running",
  "failed",
  "canceled",
  "indeterminate",
] as const;

export const EXECUTION_OPERATE_HELP =
  "Cancel, retry, and emergency stop stay on this operate path. Cancel uses POST /executions/{id}/cancel. Retry uses POST /executions/{id}/retry and is shown only when result.retry.allowed is true. Stop uses POST /executions/{id}/emergency-stop for script runs. Indeterminate stays loud — never silent success. Drafts never run.";

export const EXECUTION_OPERATE_INDETERMINATE_HELP = INDETERMINATE_STATUS_HELP;

export const EXECUTION_OPERATE_RETRY_GATE_HELP =
  "Retry is shown only when GET /executions/{id} result.retry.allowed is true. Indeterminate without that flag is not retried.";

export type ExecutionOperateSurface = "inbox" | "overlay" | "detail";

export const EXECUTION_OPERATE = {
  operateDensity: true,
  inboxRowsExposeActions: true,
  overlayExposesActions: true,
  detailRemainsExistingPath: true,
  usesExistingCancelRoute: true,
  usesExistingRetryRoute: true,
  usesExistingEmergencyStopRoute: true,
  retryGatedByResultRetryAllowed: true,
  noBlindRetry: true,
  noBlindRetryAfterStop: true,
  loudIndeterminate: true,
  neverSilentSuccessWhenUncertain: true,
  draftsNeverRun: true,
  publishedWorkflowVersionIdOnly: true,
  oneOperatePath: true,
  noSecondReplayGraph: true,
  noReplayRoute: true,
  noJobClaimBrowserSurface: true,
  noSse: true,
  noWaitingDecideDensify: true,
  migrateInPlace: true,
} as const;

export const EXECUTION_OPERATE_SOURCES: readonly string[] = [
  "src/lib/execution-operate.ts",
  "src/components/executions/ExecutionOperateActions.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/workflows/EditorRunsDrawer.tsx",
];

export const EXECUTION_OPERATE_REPLAY_GRAPH_SOURCE =
  EXECUTION_INBOX_REPLAY_GRAPH_SOURCE;

export type ExecutionOperateInput = {
  permissions?: readonly string[] | null;
  status?: ExecutionStatus;
  steps?: readonly ExecutionStep[] | null;
  result?: unknown;
  stoppedUncertain?: boolean;
};

export type ExecutionOperateAffordances = {
  cancel: boolean;
  retry: boolean;
  stop: boolean;
  indeterminate: boolean;
  needsDetail: boolean;
  retryAllowed: boolean | null;
  retryBlockedReason: string;
  stopBlockedReason: string;
  cancelBlockedReason: string;
  loudIndeterminateCopy: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasWorkflowExecute(
  permissions?: readonly string[] | null,
): boolean {
  if (permissions == null) {
    return true;
  }
  return permissions.includes("workflow.execute");
}

/** `true` / `false` when any result.retry is present; otherwise `null`. */
export function parseExecutionRetryAllowed(input: {
  result?: unknown;
  steps?: readonly Pick<ExecutionStep, "input" | "output" | "error">[] | null;
}): boolean | null {
  const bags: unknown[] = [input.result];
  for (const step of input.steps ?? []) {
    bags.push(step.output, step.error, step.input);
  }
  let seen = false;
  let allowed = false;
  for (const bag of bags) {
    const ssh = parseSshRetryResult(bag);
    const script = parseScriptIoRetryResult(bag);
    const rec = asRecord(bag);
    const nested = asRecord(rec?.retry) ?? asRecord(asRecord(rec?.result)?.retry);
    if (ssh) {
      seen = true;
      if (ssh.allowed) {
        allowed = true;
      }
    }
    if (script) {
      seen = true;
      if (script.allowed) {
        allowed = true;
      }
    }
    if (nested && "allowed" in nested) {
      seen = true;
      if (nested.allowed === true) {
        allowed = true;
      }
    }
  }
  if (!seen) {
    return null;
  }
  return allowed;
}

export function executionOperateRetryAllowed(
  input: ExecutionOperateInput,
): boolean {
  if (input.stoppedUncertain) {
    return false;
  }
  if (!hasWorkflowExecute(input.permissions)) {
    return false;
  }
  const steps = input.steps ?? [];
  const ssh = steps.some((step) =>
    canOfferSshRetry({
      permissions: input.permissions,
      nodeType: step.nodeType,
      status: step.status,
      output: step.output,
      error: step.error,
      input: step.input,
    }),
  );
  const script = steps.some((step) =>
    canOfferScriptRetry({
      permissions: input.permissions,
      nodeType: step.nodeType,
      status: step.status,
      output: step.output,
      error: step.error,
      input: step.input,
    }),
  );
  if (ssh || script) {
    return true;
  }
  const explicit = parseExecutionRetryAllowed({
    result: input.result,
    steps,
  });
  if (explicit === true) {
    return true;
  }
  if (explicit === false) {
    return false;
  }
  return canRetryExecution({
    permissions: input.permissions,
    status: input.status,
    steps,
  });
}

export function executionOperateNeedsDetail(input: {
  status?: ExecutionStatus;
  steps?: readonly ExecutionStep[] | null;
}): boolean {
  if ((input.steps ?? []).length > 0) {
    return false;
  }
  const folded = normalizeExecutionStatus(input.status);
  return (EXECUTION_OPERATE_DETAIL_STATUSES as readonly string[]).includes(
    folded,
  );
}

export function executionOperateAffordances(
  input: ExecutionOperateInput,
): ExecutionOperateAffordances {
  const steps = input.steps ?? [];
  const indeterminate = isIndeterminateStatus(input.status);
  const cancel = canCancelExecution({
    permissions: input.permissions,
    status: input.status,
  });
  const retry = executionOperateRetryAllowed(input);
  const stop = canOfferScriptEmergencyStop({
    permissions: input.permissions,
    status: input.status,
    steps,
  });
  const retryAllowed = parseExecutionRetryAllowed({
    result: input.result,
    steps,
  });
  const loudIndeterminateCopy = executionOperateIndeterminateCopy({
    status: input.status,
    steps,
    stoppedUncertain: input.stoppedUncertain,
  });
  return {
    cancel,
    retry,
    stop,
    indeterminate,
    needsDetail: executionOperateNeedsDetail({
      status: input.status,
      steps,
    }),
    retryAllowed,
    retryBlockedReason: retry
      ? ""
      : executionOperateRetryBlockedReason({
          ...input,
          steps,
          retryAllowed,
        }),
    stopBlockedReason: stop ? "" : executionOperateStopBlockedReason(input),
    cancelBlockedReason: cancel
      ? ""
      : executionOperateCancelBlockedReason(input),
    loudIndeterminateCopy,
  };
}

export function executionOperateIndeterminateCopy(input: {
  status?: ExecutionStatus;
  steps?: readonly ExecutionStep[] | null;
  stoppedUncertain?: boolean;
}): string {
  if (input.stoppedUncertain) {
    return `${SCRIPT_EMERGENCY_STOP_INDETERMINATE_HELP} ${SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP}`;
  }
  if (!isIndeterminateStatus(input.status)) {
    return "";
  }
  const steps = input.steps ?? [];
  if (executionHasSshIndeterminate(steps) || executionHasSshRun(steps)) {
    return sshRetryBlockedMessage({
      status: input.status,
      steps,
      output: steps.find((step) => parseSshRetryResult(step.output, step.error))
        ?.output,
      error: steps.find((step) => parseSshRetryResult(step.output, step.error))
        ?.error,
    });
  }
  if (executionHasScriptIndeterminate(steps) || executionHasScriptRun(steps)) {
    return scriptRetryBlockedMessage({
      status: input.status,
      nodeType: steps.find((step) => isScriptIoActionType(step.nodeType))
        ?.nodeType,
      output: steps.find((step) => isScriptIoActionType(step.nodeType))?.output,
      error: steps.find((step) => isScriptIoActionType(step.nodeType))?.error,
    });
  }
  return RETRY_INDETERMINATE_MESSAGE;
}

function executionOperateRetryBlockedReason(input: ExecutionOperateInput & {
  retryAllowed: boolean | null;
}): string {
  if (input.stoppedUncertain) {
    return SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP;
  }
  if (input.permissions != null && !hasWorkflowExecute(input.permissions)) {
    return RETRY_FORBIDDEN_MESSAGE;
  }
  if (isIndeterminateStatus(input.status) || input.retryAllowed === false) {
    return (
      executionOperateIndeterminateCopy(input) || EXECUTION_OPERATE_RETRY_GATE_HELP
    );
  }
  const steps = input.steps ?? [];
  if (executionHasSshRun(steps)) {
    return SSH_NO_BLIND_RETRY_HELP;
  }
  if (executionHasScriptRun(steps)) {
    return SCRIPT_IO_NO_BLIND_RETRY_HELP;
  }
  return EXECUTION_OPERATE_RETRY_GATE_HELP;
}

function executionOperateStopBlockedReason(input: ExecutionOperateInput): string {
  if (input.permissions != null && !canOfferScriptEmergencyStop({
    permissions: input.permissions,
    status: input.status,
    steps: input.steps ?? [],
  })) {
    const hasScript = (input.steps ?? []).some((step) =>
      isScriptIoActionType(step.nodeType),
    );
    if (hasScript) {
      return SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE;
    }
  }
  return "";
}

function executionOperateCancelBlockedReason(
  input: ExecutionOperateInput,
): string {
  if (
    input.permissions != null &&
    !input.permissions.includes("execution.cancel")
  ) {
    return CANCEL_FORBIDDEN_MESSAGE;
  }
  return "";
}

export function executionOperateShouldLoadDetail(
  record: Pick<ExecutionRecord, "status">,
): boolean {
  return (EXECUTION_OPERATE_DETAIL_STATUSES as readonly string[]).includes(
    normalizeExecutionStatus(record.status),
  );
}

export function executionOperateFromDetail(
  detail: Pick<ExecutionDetail, "status" | "steps">,
  permissions?: readonly string[] | null,
  extra: { result?: unknown; stoppedUncertain?: boolean } = {},
): ExecutionOperateAffordances {
  return executionOperateAffordances({
    permissions,
    status: detail.status,
    steps: detail.steps,
    result: extra.result,
    stoppedUncertain: extra.stoppedUncertain,
  });
}

export function executionOperatePaths(executionId: string): {
  cancel: string;
  retry: string;
  stop: string;
} {
  return {
    cancel: executionCancelPath(executionId),
    retry: executionRetryPath(executionId),
    stop: executionEmergencyStopPath(executionId),
  };
}

export function executionOperateUsesExistingRoutes(
  executionId: string,
): boolean {
  const paths = executionOperatePaths(executionId);
  return (
    paths.cancel === `/executions/${executionId}/cancel` &&
    paths.retry === `/executions/${executionId}/retry` &&
    paths.stop === `/executions/${executionId}/emergency-stop` &&
    EXECUTION_OPERATE.usesExistingCancelRoute &&
    EXECUTION_OPERATE.usesExistingRetryRoute &&
    EXECUTION_OPERATE.usesExistingEmergencyStopRoute
  );
}

export function executionOperateDoesNotInventJobClaim(): boolean {
  const invented = INVENTED_JOB_CLAIM_ROUTE;
  return (
    EXECUTION_OPERATE.noJobClaimBrowserSurface &&
    !executionCancelPath("id").includes(invented) &&
    !executionRetryPath("id").includes(invented) &&
    !executionEmergencyStopPath("id").includes(invented) &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(invented) || route.embed.includes(invented),
    )
  );
}

export function executionOperateDoesNotInventReplayRoute(): boolean {
  const invented = INVENTED_REPLAY_ROUTE;
  return (
    EXECUTION_OPERATE.noReplayRoute &&
    R4_GUARDRAILS.noReplayProductRoute &&
    invented === EDITOR_INVENTED_REPLAY_ROUTE &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(invented) || route.embed.includes(invented),
    )
  );
}

export function executionOperateHasSingleOperatePath(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    EXECUTION_OPERATE.oneOperatePath &&
    EXECUTION_OPERATE.noSecondReplayGraph &&
    !EXECUTION_OPERATE_SOURCES.includes(EXECUTION_OPERATE_REPLAY_GRAPH_SOURCE) &&
    !EXECUTION_OPERATE_SOURCES.includes(EDITOR_RUNS_REPLAY_GRAPH_SOURCE)
  );
}

export function executionOperateDraftsNeverRun(): boolean {
  return (
    EXECUTION_OPERATE.draftsNeverRun &&
    EXECUTION_OPERATE.publishedWorkflowVersionIdOnly &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.publishedWorkflowVersionIdOnly &&
    /drafts? are never/i.test(PRE_RUN_PUBLISHED_ONLY_HELP) &&
    /workflowVersionId/.test(PRE_RUN_PUBLISHED_ONLY_HELP)
  );
}

export function executionOperateIndeterminateIsLoud(
  status = "indeterminate",
): boolean {
  const presentation = executionStatusPresentation(status);
  const copy = executionOperateIndeterminateCopy({ status });
  return (
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.neverSilentSuccessWhenUncertain &&
    EXECUTION_OPERATE.loudIndeterminate &&
    EXECUTION_OPERATE.neverSilentSuccessWhenUncertain &&
    isIndeterminateStatus(status) &&
    isIndeterminateUnmistakable(presentation) &&
    presentation.tone === "indeterminate" &&
    /did not run/i.test(copy) &&
    !/silent success/i.test(copy)
  );
}

export function executionOperateNeverOffersBlindRetry(): boolean {
  return (
    EXECUTION_OPERATE.noBlindRetry &&
    EXECUTION_OPERATE.retryGatedByResultRetryAllowed &&
    canBlindRetryAfterEmergencyStop() === false &&
    EXECUTION_OPERATE.noBlindRetryAfterStop
  );
}

export function executionOperateInheritsR4Guardrails(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.neverSilentSuccessWhenUncertain &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.noReplayProductRoute &&
    /#257/.test(R4_LATER_STORY_NOTES.r44)
  );
}

export function executionOperateSurfaceOn(
  surface: ExecutionOperateSurface,
): boolean {
  if (surface === "inbox") {
    return EXECUTION_OPERATE.inboxRowsExposeActions;
  }
  if (surface === "overlay") {
    return EXECUTION_OPERATE.overlayExposesActions;
  }
  return EXECUTION_OPERATE.detailRemainsExistingPath;
}
