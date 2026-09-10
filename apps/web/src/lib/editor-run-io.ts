/**
 * UX.11: redacted last-run step I/O in the inspector when a run is
 * selected from the editor drawer.
 *
 * Relates to #206 / Part of #195. Keep #206 open until merge.
 *
 * Chloe UI only. Product choice: overlay existing replay helpers on the
 * **same** editor canvas (do not mount ExecutionReplay and do not
 * navigate away as the primary path). Workspace `/executions` and
 * `/executions/{id}` stay the ops inbox. Step I/O comes from existing
 * `GET /executions/{id}` (`steps[].input|output|error`, already
 * redacted) plus `GET /executions/{id}/steps/{stepId}/logs`. Do not
 * invent `/replay`. Still no draft execute. If those payloads ever
 * omit I/O, stop and ask jonny — do not invent routes.
 */

import { EMBED_ROUTES } from "./embed-contract.ts";
import {
  EDITOR_RUN_OVERLAY_KEYBOARD_HELP,
  editorRunOpenHref,
  editorRunsWorkspaceHref,
} from "./editor-runs.ts";
import {
  BOUNDED_LOG_HELP,
  INDETERMINATE_STATUS_HELP,
  REDACTED_HELP,
  executionPath,
  executionStepLogsPath,
} from "./execution-contract.ts";
import {
  boundRedactedDisplay,
  containsUnredactedSecret,
  executionStatusPresentation,
  isIndeterminateStatus,
  normalizeExecutionStatus,
  stripSecretFields,
} from "./execution.ts";
import {
  currentReplayNodeId,
  isIndeterminateUnmistakable,
  latestStepsByNode,
  overlayExecutionOnGraph,
  replayStepViews,
  waitingApprovalNodeIds,
  type ReplayStepView,
} from "./execution-replay.ts";
import { REDACTED_MARKER, type ExecutionDetail, type ExecutionLogSlice, type ExecutionStep } from "./execution-types.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import type { WorkflowGraph } from "./workflow-graph.ts";

export const UX11_STORY = 206;
export const UX11_EPIC = 195;
export const UX11_KEEP_STORY_OPEN = true;

export const EDITOR_RUN_IO_DETAIL_PATH = "/executions/{id}";
export const EDITOR_RUN_IO_LOGS_PATH = "/executions/{id}/steps/{stepId}/logs";
export const INVENTED_REPLAY_ROUTE = "/replay";

export const EDITOR_RUN_OVERLAY_HELP =
  "Step status from the selected run overlays this draft graph. Matching node ids show redacted I/O in the inspector. Workspace executions remains the ops inbox.";

export { EDITOR_RUN_OVERLAY_KEYBOARD_HELP };

export const EDITOR_RUN_NO_STEP_HELP =
  "This node has no step on the selected run. Overlay matches by node id on the current draft canvas.";

export const EDITOR_RUN_IO_PENDING_HELP = "Loading redacted last-run I/O…";

export const EDITOR_RUN_CLEAR_LABEL = "Clear run overlay";

export const EDITOR_RUN_IO = {
  sameCanvasOverlay: true,
  noSecondReplayGraph: true,
  noExecutionReplayMount: true,
  noInventedReplayRoute: true,
  usesExistingExecutionDetail: true,
  usesExistingStepLogs: true,
  inspectorShowsRedactedIo: true,
  secretsAreRedactedMarker: true,
  indeterminateStaysLoud: true,
  noDraftExecute: true,
  workspaceExecutionsRemainsOpsInbox: true,
  opsDeepLinkRemainsAvailable: true,
  jonnyNeededForStepIo: false,
} as const;

export const EDITOR_RUN_IO_SOURCES = [
  "src/lib/editor-run-io.ts",
  "src/lib/execution-replay.ts",
  "src/lib/execution-client.ts",
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/workflows/LastRunIoPanel.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
] as const;

export type EditorLastRunIo = {
  executionId: string;
  workflowId: string;
  workflowVersionId: string;
  workflowVersionNumber: number | null;
  workflowDigest: string;
  runStatus: string;
  nodeId: string;
  step: ExecutionStep | null;
  view: ReplayStepView | null;
  inputText: string;
  outputText: string;
  errorText: string;
  logsText: string;
  status: string;
  indeterminate: boolean;
  indeterminateHelp: string;
  redactedHelp: string;
  logsHelp: string;
  missingStep: boolean;
};

export function editorRunOverlayGraph(
  graph: WorkflowGraph,
  steps: readonly ExecutionStep[],
  waitingApprovalIds: readonly string[] = [],
): WorkflowGraph {
  return overlayExecutionOnGraph(graph, steps, {
    waitingApprovalNodeIds: waitingApprovalIds,
  });
}

export function editorRunWaitingNodeIds(
  approvals: readonly ApprovalRequest[] = [],
): string[] {
  return waitingApprovalNodeIds(approvals);
}

export function editorRunCurrentNodeId(
  steps: readonly ExecutionStep[],
  waitingApprovalIds: readonly string[] = [],
): string | null {
  return currentReplayNodeId(steps, waitingApprovalIds);
}

export function editorRunShouldPoll(status: string | undefined): boolean {
  const folded = normalizeExecutionStatus(status);
  return (
    folded === "queued" ||
    folded === "pinned" ||
    folded === "running" ||
    folded === "claimed"
  );
}

export function editorRunOpsHref(
  executionId: string,
  workflowId?: string,
  embed = false,
): string {
  return editorRunOpenHref(executionId, workflowId, embed);
}

export function editorRunWorkspaceHref(embed = false): string {
  return editorRunsWorkspaceHref(embed);
}

export function editorRunDetailPath(executionId: string): string {
  return executionPath(executionId);
}

export function editorRunLogsPath(executionId: string, stepId: string): string {
  return executionStepLogsPath(executionId, stepId);
}

export function editorRunIoForNode(
  detail: ExecutionDetail,
  nodeId: string,
  options: {
    waitingApprovalNodeIds?: readonly string[];
    logs?: ExecutionLogSlice | null;
  } = {},
): EditorLastRunIo {
  const latest = latestStepsByNode(detail.steps);
  const step = latest.get(nodeId) ?? null;
  const views = replayStepViews(detail.steps, {
    waitingApprovalNodeIds: options.waitingApprovalNodeIds,
  });
  const view = views.find((item) => item.nodeId === nodeId && item.step.id === step?.id)
    ?? views.find((item) => item.nodeId === nodeId)
    ?? null;
  const logsText = options.logs?.text?.trim()
    ? options.logs.text
    : "";
  return {
    executionId: detail.id,
    workflowId: detail.workflowId,
    workflowVersionId: detail.workflowVersionId,
    workflowVersionNumber: detail.workflowVersionNumber,
    workflowDigest: detail.workflowDigest,
    runStatus: detail.status,
    nodeId,
    step,
    view,
    inputText: boundRedactedDisplay(step?.input).text,
    outputText: boundRedactedDisplay(step?.output ?? step?.error).text,
    errorText: boundRedactedDisplay(step?.error).text,
    logsText: logsText || "—",
    status: step?.status ?? "",
    indeterminate: isIndeterminateStatus(step?.status),
    indeterminateHelp: INDETERMINATE_STATUS_HELP,
    redactedHelp: REDACTED_HELP,
    logsHelp: BOUNDED_LOG_HELP,
    missingStep: step == null,
  };
}

export function editorRunIoText(io: EditorLastRunIo): string {
  return [
    io.executionId,
    io.nodeId,
    io.status,
    io.inputText,
    io.outputText,
    io.errorText,
    io.logsText,
    io.indeterminate ? INDETERMINATE_STATUS_HELP : "",
    REDACTED_MARKER,
  ].join("\n");
}

export function editorRunIoIsSafe(text: string): boolean {
  return !containsUnredactedSecret(text) && text.includes(REDACTED_MARKER);
}

export function editorRunIoStripsSecrets(value: unknown): unknown {
  const strippedKeys: string[] = [];
  return stripSecretFields(value, strippedKeys);
}

export function executionDetailExposesRedactedStepIo(
  detail: ExecutionDetail,
): boolean {
  if (detail.steps.length === 0) {
    return false;
  }
  return detail.steps.some(
    (step) => step.input != null || step.output != null || step.error != null,
  );
}

export function editorRunIoUsesExistingDetailRoute(): boolean {
  return (
    editorRunDetailPath("33333333-3333-4333-8333-333333333333") ===
      "/executions/33333333-3333-4333-8333-333333333333" &&
    EDITOR_RUN_IO.usesExistingExecutionDetail &&
    !EDITOR_RUN_IO.jonnyNeededForStepIo
  );
}

export function editorRunIoDoesNotInventReplayRoute(): boolean {
  const invented = INVENTED_REPLAY_ROUTE;
  return (
    EDITOR_RUN_IO.noInventedReplayRoute &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(invented) || route.embed.includes(invented),
    ) &&
    !editorRunDetailPath("id").includes(invented) &&
    !EDITOR_RUN_IO_DETAIL_PATH.includes(invented)
  );
}

export function editorRunIndeterminateIsLoud(status = "indeterminate"): boolean {
  const presentation = executionStatusPresentation(status);
  return (
    isIndeterminateStatus(status) &&
    isIndeterminateUnmistakable(presentation) &&
    EDITOR_RUN_IO.indeterminateStaysLoud
  );
}

export function editorRunOverlayAnnouncement(input: {
  nodeName?: string | null;
  nodeType?: string | null;
  nodeId: string;
  io: EditorLastRunIo | null;
}): string {
  const title = input.nodeName?.trim() || input.nodeId;
  const type = input.nodeType?.trim();
  const head = type ? `Selected ${title} (${type}).` : `Selected ${title}.`;
  if (!input.io) {
    return `${head} Inspector shows name, with fields, pins, and credentials.`;
  }
  if (input.io.missingStep) {
    return `${head} ${EDITOR_RUN_NO_STEP_HELP}`;
  }
  if (input.io.indeterminate) {
    return `${head} Last run step is indeterminate. ${INDETERMINATE_STATUS_HELP}`;
  }
  return `${head} Inspector also shows redacted last-run I/O.`;
}
