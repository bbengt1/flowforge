/**
 * R4.3: NDV redacted last-run I/O density.
 *
 * Relates to #256 / Part of #230. Keep #256 open.
 *
 * Chloe UI only. Densify UX.11 last-run I/O in place (D6) to
 * operate-a-run density. Context is the overlay-selected run or the
 * latest published run (`GET /workflows/{id}/executions?limit=1` +
 * `GET /executions/{id}` step `input` / `output` / `error`, already
 * redacted, plus `…/steps/{stepId}/logs`). Failures jump to the node.
 * Full run detail stays `/executions/{id}`. Do not mount
 * ExecutionReplay in the NDV. Drafts never run. No invented step
 * payload shapes — if I/O is missing, document the gap (jonny
 * standby). No cancel/retry (R4.4), waiting→decide (R4.5), SSE, or
 * `/replay`. Inherit Gracie R4 guardrails from execution-inbox.ts.
 */

import { EMBED_ROUTES } from "./embed-contract.ts";
import {
  EDITOR_RUN_IO,
  EDITOR_RUN_IO_DETAIL_PATH,
  EDITOR_RUN_IO_LOGS_PATH,
  EDITOR_RUN_NO_STEP_HELP,
  editorRunIoForNode,
  editorRunIoIsSafe,
  editorRunIoText,
  editorRunOpsHref,
  executionDetailExposesRedactedStepIo,
  type EditorLastRunIo,
} from "./editor-run-io.ts";
import { editorRunsCanList } from "./editor-runs.ts";
import {
  R4_GUARDRAILS,
  R4_LATER_STORY_NOTES,
  executionInboxDurationLabel,
  executionInboxTimeLabel,
} from "./execution-inbox.ts";
import {
  INDETERMINATE_STATUS_HELP,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  REDACTED_HELP,
  listWorkflowExecutionsPath,
} from "./execution-contract.ts";
import {
  containsUnredactedSecret,
  executionStatusPresentation,
  isIndeterminateStatus,
} from "./execution.ts";
import {
  executionErrorNavLinks,
  formatDuration,
  isDraftRunSelection,
  isIndeterminateUnmistakable,
  stepDurationMs,
  type ExecutionErrorNavLink,
} from "./execution-replay.ts";
import {
  REDACTED_MARKER,
  type ExecutionDetail,
  type ExecutionLogSlice,
  type ExecutionRecord,
  type ExecutionStep,
} from "./execution-types.ts";

export const R43_STORY = 256;
export const R43_EPIC = 230;
export const R43_KEEP_STORY_OPEN = true;

export const NDV_RUN_IO_PANEL = "last-run" as const;
export const NDV_RUN_IO_DETAIL_PATH = EDITOR_RUN_IO_DETAIL_PATH;
export const NDV_RUN_IO_LOGS_PATH = EDITOR_RUN_IO_LOGS_PATH;
export const NDV_RUN_IO_LATEST_LIST_LIMIT = 1;
export const INVENTED_REPLAY_ROUTE = "/replay";
export const NDV_RUN_IO_REPLAY_GRAPH_SOURCE =
  "src/components/executions/ExecutionReplay.tsx";

export type NdvRunIoContextSource = "overlay" | "latest";

export const EDITOR_NDV_RUN_IO = {
  operateDensity: true,
  selectedNodeStepIo: true,
  contextFromOverlayOrLatest: true,
  overlaySelectionWins: true,
  latestPublishedRunFallback: true,
  failuresJumpToNode: true,
  redactedMarkerHonored: true,
  noPlaintextSecrets: true,
  noSecretField: true,
  noExpressionLanguage: true,
  noPinData: true,
  noDraftExecute: true,
  publishedWorkflowVersionIdOnly: true,
  noSecondExecutionReplay: true,
  noInventedStepPayloadShapes: true,
  usesExistingExecutionDetail: true,
  usesExistingStepLogs: true,
  usesExistingLatestList: true,
  fullRunDetailRemainsExecutionsId: true,
  loudIndeterminate: true,
  noCancelRetryDensify: true,
  noWaitingDecideDensify: true,
  noSse: true,
  noReplayRoute: true,
  jonnyNeededForStepIo: false,
  migrateInPlace: true,
} as const;

export const NDV_RUN_IO_OPERATE_HELP =
  "Redacted last-run step I/O for this node at operate density. Context is the overlay-selected run or the latest published run. Failures jump to the node. Full run detail stays on /executions/{id}. Drafts never run.";

export const NDV_RUN_IO_LATEST_HELP =
  "Showing the latest published run. Select a run in Runs to overlay it on this canvas.";

export const NDV_RUN_IO_OVERLAY_HELP =
  "Showing the overlay-selected run. Matching steps stay highlighted on this canvas.";

export const NDV_RUN_IO_NO_RUN_HELP =
  "No published run is in context yet. Start a published version — drafts never execute.";

export const NDV_RUN_IO_JUMP_HELP =
  "Failures and indeterminate steps jump to the node on this canvas.";

export const NDV_RUN_IO_PAYLOAD_GAP_HELP =
  "This step has no redacted input, output, or error on GET /executions/{id}. Do not invent a step payload shape. jonny standby.";

export const NDV_RUN_IO_JUMP_LABEL = "Jump to node";

export const NDV_RUN_IO_RAIL_SOURCES = [
  "src/lib/editor-ndv-run-io.ts",
  "src/lib/editor-run-io.ts",
  "src/components/workflows/LastRunIoPanel.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
] as const;

export type NdvRunIoView = {
  source: NdvRunIoContextSource | null;
  sourceLabel: string;
  help: string;
  executionId: string;
  workflowVersionLabel: string;
  runStatus: string;
  startedLabel: string;
  durationLabel: string;
  opsHref: string | null;
  io: EditorLastRunIo | null;
  stepMeta: string;
  jumpLinks: ExecutionErrorNavLink[];
  payloadGap: boolean;
  empty: boolean;
  noPublishedRun: boolean;
};

export function ndvRunIoContextSource(
  overlayId?: string | null,
  latestId?: string | null,
): NdvRunIoContextSource | null {
  if (overlayId?.trim()) {
    return "overlay";
  }
  if (latestId?.trim()) {
    return "latest";
  }
  return null;
}

export function ndvRunIoContextId(
  overlayId?: string | null,
  latestId?: string | null,
): string | null {
  const overlay = overlayId?.trim() || "";
  if (overlay) {
    return overlay;
  }
  const latest = latestId?.trim() || "";
  return latest || null;
}

export function ndvLatestRunListPath(workflowId: string): string {
  return listWorkflowExecutionsPath(workflowId, {
    limit: NDV_RUN_IO_LATEST_LIST_LIMIT,
  });
}

export function pickLatestPublishedRun(
  items: readonly ExecutionRecord[],
): ExecutionRecord | null {
  const published = items.filter((item) => ndvRunIsPublished(item));
  if (published.length === 0) {
    return null;
  }
  return published.reduce((best, item) => {
    const bestAt = best.startedAt || best.createdAt || "";
    const nextAt = item.startedAt || item.createdAt || "";
    return nextAt > bestAt ? item : best;
  });
}

export function ndvRunIsPublished(
  record: Pick<ExecutionRecord, "workflowVersionId">,
): boolean {
  const versionId = record.workflowVersionId?.trim() ?? "";
  return Boolean(versionId) && !isDraftRunSelection(versionId);
}

export function ndvRunIoCanLoad(
  permissions: readonly string[] | null | undefined,
): boolean {
  return editorRunsCanList(permissions);
}

export function ndvRunIoStepPayloadGap(
  step: ExecutionStep | null | undefined,
): boolean {
  if (!step) {
    return false;
  }
  return step.input == null && step.output == null && step.error == null;
}

export function ndvRunIoJumpLinks(
  detail: ExecutionDetail | null | undefined,
): ExecutionErrorNavLink[] {
  if (!detail) {
    return [];
  }
  return executionErrorNavLinks({ steps: detail.steps }).filter(
    (link) => Boolean(link.nodeId) && link.tone !== "problem",
  );
}

export function ndvRunIoJumpTarget(
  link: ExecutionErrorNavLink,
): string | null {
  return link.nodeId?.trim() || null;
}

export function ndvRunIoForSelectedNode(
  detail: ExecutionDetail,
  nodeId: string,
  options: {
    waitingApprovalNodeIds?: readonly string[];
    logs?: ExecutionLogSlice | null;
  } = {},
): EditorLastRunIo {
  return editorRunIoForNode(detail, nodeId, options);
}

export function ndvRunIoView(input: {
  detail?: ExecutionDetail | null;
  nodeId?: string | null;
  source?: NdvRunIoContextSource | null;
  logs?: ExecutionLogSlice | null;
  waitingApprovalNodeIds?: readonly string[];
  embed?: boolean;
}): NdvRunIoView {
  const detail = input.detail ?? null;
  const source = input.source ?? null;
  const nodeId = input.nodeId?.trim() || "";
  const io =
    detail && nodeId
      ? ndvRunIoForSelectedNode(detail, nodeId, {
          waitingApprovalNodeIds: input.waitingApprovalNodeIds,
          logs: input.logs,
        })
      : null;
  const payloadGap = ndvRunIoStepPayloadGap(io?.step);
  return {
    source,
    sourceLabel:
      source === "overlay"
        ? "Overlay run"
        : source === "latest"
          ? "Latest published run"
          : "No run in context",
    help: detail
      ? source === "latest"
        ? NDV_RUN_IO_LATEST_HELP
        : NDV_RUN_IO_OVERLAY_HELP
      : NDV_RUN_IO_NO_RUN_HELP,
    executionId: detail?.id ?? "",
    workflowVersionLabel: ndvRunIoVersionLabel(detail),
    runStatus: io?.status || detail?.status || "",
    startedLabel: detail ? executionInboxTimeLabel(detail.startedAt) : "—",
    durationLabel: detail
      ? executionInboxDurationLabel(detail.startedAt, detail.finishedAt)
      : "—",
    opsHref: detail
      ? editorRunOpsHref(detail.id, detail.workflowId, input.embed)
      : null,
    io,
    stepMeta: ndvRunIoStepMeta(io),
    jumpLinks: ndvRunIoJumpLinks(detail),
    payloadGap,
    empty: detail == null,
    noPublishedRun: detail == null,
  };
}

export function ndvRunIoVersionLabel(
  detail: Pick<
    ExecutionDetail,
    "workflowVersionNumber" | "workflowVersionId"
  > | null,
): string {
  if (!detail) {
    return "";
  }
  if (detail.workflowVersionNumber != null) {
    return `published v${detail.workflowVersionNumber}`;
  }
  return detail.workflowVersionId ? "published version" : "";
}

export function ndvRunIoStepMeta(io: EditorLastRunIo | null): string {
  if (!io?.step) {
    return "";
  }
  const duration = formatDuration(stepDurationMs(io.step));
  const type = io.step.nodeType || "node";
  return `${type} · attempt ${io.step.attempt} · duration ${duration}`;
}

export function ndvRunIoText(view: NdvRunIoView): string {
  return [
    view.sourceLabel,
    view.help,
    view.executionId,
    view.workflowVersionLabel,
    view.runStatus,
    view.stepMeta,
    view.io ? editorRunIoText(view.io) : "",
    ...view.jumpLinks.map((link) => link.label),
    view.payloadGap ? NDV_RUN_IO_PAYLOAD_GAP_HELP : "",
    REDACTED_MARKER,
    REDACTED_HELP,
  ].join("\n");
}

export function ndvRunIoPreservesRedaction(view: NdvRunIoView): boolean {
  const text = ndvRunIoText(view);
  if (containsUnredactedSecret(text)) {
    return false;
  }
  if (view.io && !view.io.missingStep && !view.payloadGap) {
    return editorRunIoIsSafe(editorRunIoText(view.io));
  }
  return text.includes(REDACTED_MARKER);
}

export function ndvRunIoAnnouncement(input: {
  nodeName?: string | null;
  nodeType?: string | null;
  nodeId: string;
  view: NdvRunIoView;
}): string {
  const title = input.nodeName?.trim() || input.nodeId;
  const type = input.nodeType?.trim();
  const head = type ? `Selected ${title} (${type}).` : `Selected ${title}.`;
  if (input.view.empty) {
    return `${head} ${NDV_RUN_IO_NO_RUN_HELP}`;
  }
  if (!input.view.io) {
    return `${head} Inspector shows redacted last-run I/O when a node is selected.`;
  }
  if (input.view.io.missingStep) {
    return `${head} ${EDITOR_RUN_NO_STEP_HELP}`;
  }
  if (input.view.payloadGap) {
    return `${head} ${NDV_RUN_IO_PAYLOAD_GAP_HELP}`;
  }
  if (input.view.io.indeterminate) {
    return `${head} Last run step is indeterminate. ${INDETERMINATE_STATUS_HELP}`;
  }
  return `${head} Inspector shows redacted last-run step I/O at operate density.`;
}

export function ndvRunIoIndeterminateIsLoud(status = "indeterminate"): boolean {
  const presentation = executionStatusPresentation(status);
  return (
    R4_GUARDRAILS.loudIndeterminate &&
    EDITOR_NDV_RUN_IO.loudIndeterminate &&
    isIndeterminateStatus(status) &&
    isIndeterminateUnmistakable(presentation) &&
    Boolean(presentation.icon.trim()) &&
    /indeterminate/i.test(presentation.label)
  );
}

export function ndvRunIoDraftsNeverRun(): boolean {
  return (
    EDITOR_NDV_RUN_IO.noDraftExecute &&
    EDITOR_NDV_RUN_IO.publishedWorkflowVersionIdOnly &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.publishedWorkflowVersionIdOnly &&
    /drafts? are never/i.test(PRE_RUN_PUBLISHED_ONLY_HELP) &&
    /workflowVersionId/.test(PRE_RUN_PUBLISHED_ONLY_HELP)
  );
}

export function ndvRunIoHasSingleOperatePath(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    EDITOR_NDV_RUN_IO.fullRunDetailRemainsExecutionsId &&
    EDITOR_NDV_RUN_IO.noSecondExecutionReplay &&
    EDITOR_RUN_IO.noExecutionReplayMount &&
    !(NDV_RUN_IO_RAIL_SOURCES as readonly string[]).includes(
      NDV_RUN_IO_REPLAY_GRAPH_SOURCE,
    ) &&
    NDV_RUN_IO_DETAIL_PATH === "/executions/{id}"
  );
}

export function ndvRunIoDoesNotInventReplayRoute(): boolean {
  return (
    EDITOR_NDV_RUN_IO.noReplayRoute &&
    R4_GUARDRAILS.noReplayProductRoute &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(INVENTED_REPLAY_ROUTE) ||
        route.embed.includes(INVENTED_REPLAY_ROUTE),
    ) &&
    !NDV_RUN_IO_DETAIL_PATH.includes(INVENTED_REPLAY_ROUTE)
  );
}

export function ndvRunIoUsesExistingRoutes(workflowId: string): boolean {
  const latest = ndvLatestRunListPath(workflowId);
  return (
    EDITOR_NDV_RUN_IO.usesExistingExecutionDetail &&
    EDITOR_NDV_RUN_IO.usesExistingStepLogs &&
    EDITOR_NDV_RUN_IO.usesExistingLatestList &&
    latest === `/workflows/${workflowId}/executions?limit=1` &&
    NDV_RUN_IO_DETAIL_PATH === "/executions/{id}" &&
    NDV_RUN_IO_LOGS_PATH === "/executions/{id}/steps/{stepId}/logs"
  );
}

export function ndvRunIoInheritsR4Guardrails(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.overlayStaysEditorOnly &&
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.compareIsClientDiff &&
    R4_GUARDRAILS.noReplayProductRoute &&
    /#256/.test(R4_LATER_STORY_NOTES.r43)
  );
}

export function ndvRunIoDocumentsPayloadGap(
  detail?: ExecutionDetail | null,
): boolean {
  if (!detail) {
    return (
      EDITOR_NDV_RUN_IO.noInventedStepPayloadShapes &&
      Boolean(NDV_RUN_IO_PAYLOAD_GAP_HELP.trim())
    );
  }
  if (detail.steps.length === 0) {
    return true;
  }
  if (executionDetailExposesRedactedStepIo(detail)) {
    return !EDITOR_NDV_RUN_IO.jonnyNeededForStepIo;
  }
  return EDITOR_NDV_RUN_IO.noInventedStepPayloadShapes;
}

export function ndvRunIoEmbedRoutesUnchanged(): boolean {
  const list = EMBED_ROUTES.filter((route) => route.id === "executions");
  const detail = EMBED_ROUTES.filter((route) => route.id === "execution");
  return (
    list.length === 1 &&
    list[0]?.standalone === "/executions" &&
    list[0]?.embed === "/embed/v1/executions" &&
    detail.length === 1 &&
    detail[0]?.standalone === "/executions/{id}" &&
    detail[0]?.embed === "/embed/v1/executions/{id}"
  );
}
