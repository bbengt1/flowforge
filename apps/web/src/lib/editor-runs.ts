/**
 * UX.6 + R4.2: in-editor Runs overlay operate-a-run density.
 *
 * Relates to #255 / Part of #230. Keep #255 open.
 * Relates to #201 / Part of #195 (UX.6 drawer on the same canvas).
 *
 * Chloe UI only. Densify the existing overlay in place (D6). Reuse
 * ExecutionHistory listbox patterns, listWorkflowExecutions, and
 * GET /executions/{id} for highlight — do not mount ExecutionReplay
 * and do not invent /replay, compare/SSE routes, or list filters
 * beyond status / limit. Overlay stays a remembered-open satellite
 * (R2 pattern) and does not bury the canvas. Workspace
 * `/executions/{id}` remains the dense detail path (R4.1). Drafts
 * never run. Secrets stay [redacted]. ADV/RBAC/embed stay.
 *
 * Inherit Gracie R4 guardrails from execution-inbox.ts.
 */

import { EMBED_ROUTES } from "./embed-contract.ts";
import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import {
  R4_GUARDRAILS,
  R4_LATER_STORY_NOTES,
  executionInboxDurationLabel,
  executionInboxStatuses,
  executionInboxTimeLabel,
} from "./execution-inbox.ts";
import {
  PRE_RUN_PUBLISHED_ONLY_HELP,
  executionHistoryHref,
  listExecutionsPath,
  listWorkflowExecutionsPath,
} from "./execution-contract.ts";
import {
  executionListDisplay,
  executionStatusPresentation,
  isIndeterminateStatus,
  normalizeExecutionStatus,
} from "./execution.ts";
import {
  historyKeyAction,
  latestStepsByNode,
} from "./execution-replay.ts";
import type {
  ExecutionListRow,
  ExecutionRecord,
  ExecutionStep,
} from "./execution-types.ts";
import { EXECUTION_VIEW_PERMISSION } from "./execution-types.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

export const UX6_STORY = 201;
export const UX6_EPIC = 195;
export const UX6_KEEP_STORY_OPEN = true;

export const R42_STORY = 255;
export const R42_EPIC = 230;
export const R42_KEEP_STORY_OPEN = true;

export const EDITOR_RUNS_OPEN_ON_FIRST_PAINT = false;
export const EDITOR_RUNS_DEFAULT_OPEN = EDITOR_RUNS_OPEN_ON_FIRST_PAINT;
export const EDITOR_RUNS_COLUMN_WIDTH = "20rem";
export const EDITOR_RUNS_SATELLITE_WIDTH = "2.75rem";
export const EDITOR_RUNS_PANEL_ID = "editor-runs-drawer";
export const EDITOR_RUNS_SATELLITE_ID = "editor-runs-satellite";
export const EDITOR_RUNS_SATELLITE_LABEL = "Runs";
export const EDITOR_RUNS_OPEN_STORAGE_KEY = "flowforge.editor.runs-open.v1";
export const EDITOR_RUNS_LIST_LIMIT = 50;
export const EDITOR_WORKSPACE_EXECUTIONS_HREF = "/executions";
export const EDITOR_RUNS_DETAIL_PATH = "/executions/{id}";
export const EDITOR_RUNS_REPLAY_GRAPH_SOURCE =
  "src/components/executions/ExecutionReplay.tsx";
export const EDITOR_RUNS_COMPARE_SOURCE =
  "src/components/executions/ExecutionCompare.tsx";
export const INVENTED_REPLAY_ROUTE = "/replay";

export const EDITOR_RUNS_SKIP_STATUSES = ["failed", "indeterminate"] as const;
export type EditorRunsSkipStatus = (typeof EDITOR_RUNS_SKIP_STATUSES)[number];

export const EDITOR_RUNS_COLUMNS = [
  { id: "status", label: "Status" },
  { id: "version", label: "Version" },
  { id: "started", label: "Started" },
  { id: "duration", label: "Duration" },
  { id: "open", label: "Open" },
] as const;

export type EditorRunsColumnId = (typeof EDITOR_RUNS_COLUMNS)[number]["id"];

export type EditorRunsOverlayRow = ExecutionListRow & {
  startedLabel: string;
  durationLabel: string;
};

export type EditorRunsSkipTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "run"; executionId: string };

export type RunsChromeMode = "drawer" | "satellite";

export const EDITOR_RUNS = {
  hiddenOnFirstPaint: false,
  rememberedOpen: true,
  persistentSatellite: true,
  defaultOpen: false,
  doesNotBuryCanvas: true,
  scopedToOpenWorkflow: true,
  usesWorkflowExecutionsCollection: true,
  operateDensity: true,
  statusFilters: true,
  skipToFailed: true,
  skipToIndeterminate: true,
  sameCanvasHighlight: true,
  keyboardMatchesHistory: true,
  openGoesToExistingReplayRoute: false,
  openOverlaysSameCanvas: true,
  opsDeepLinkRemainsAvailable: true,
  noSecondReplayCanvas: true,
  noExecutionReplayMount: true,
  indeterminateIconAndText: true,
  startPublishedUsesExistingRunControl: true,
  workspaceExecutionsRemainsOpsView: true,
  noNewEmbedRoutes: true,
  noDraftExecute: true,
  publishedWorkflowVersionIdOnly: true,
  noRedactedRunIoInInspector: false,
  noReplayRoute: true,
  compareIsClientDiff: true,
  compareNotShownInOverlay: true,
  cancelRetryStopDensity: true,
  retryGatedByResultRetryAllowed: true,
  noSse: true,
  preferenceStoresOpenFlagOnly: true,
  columnWidth: EDITOR_RUNS_COLUMN_WIDTH,
  satelliteWidth: EDITOR_RUNS_SATELLITE_WIDTH,
} as const;

export const EDITOR_RUN_OVERLAY_KEYBOARD_HELP =
  "Arrow keys move through this workflow's runs. Enter or Space overlays the focused run on this canvas and highlights matching steps. Open execution still goes to /executions/{id}.";

export const EDITOR_RUNS_OPERATE_HELP =
  "Operate this workflow's runs without leaving the graph. Filter by status, skip to failed or indeterminate, and select a run to highlight matching steps on this canvas. Cancel, retry, and emergency stop use the existing E5/E8/E9 routes. Retry stays gated by result.retry.allowed. Waiting runs decide the bound approval with POST /approvals/{id}/decide — no invented resume. Open execution still goes to /executions/{id}. Drafts never run.";

export const EDITOR_RUNS_SKIP_FAILED_LABEL = "Skip to failed";
export const EDITOR_RUNS_SKIP_INDETERMINATE_LABEL = "Skip to indeterminate";

export const EDITOR_RUNS_SOURCES: readonly string[] = [
  "src/lib/editor-runs.ts",
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/executions/ExecutionStatusBadge.tsx",
  "src/components/workflows/RunControl.tsx",
  "src/components/workflows/ManualStartPanel.tsx",
  "src/lib/execution-operate.ts",
  "src/components/executions/ExecutionOperateActions.tsx",
];

const listeners = new Set<() => void>();

function emitRunsOpenPreference() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeRunsOpenPreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stored chrome flag is only "1" / "0". Anything else is treated as missing. */
export function parseRunsOpenPreference(
  raw: string | null | undefined,
): boolean | null {
  if (raw === "1") {
    return true;
  }
  if (raw === "0") {
    return false;
  }
  return null;
}

export function rememberedRunsOpen(
  stored: boolean | null,
  fallback = EDITOR_RUNS_DEFAULT_OPEN,
): boolean {
  return stored === null ? fallback : stored;
}

export function readRunsOpenPreference(): boolean {
  if (typeof sessionStorage === "undefined") {
    return EDITOR_RUNS_DEFAULT_OPEN;
  }
  try {
    return rememberedRunsOpen(
      parseRunsOpenPreference(
        sessionStorage.getItem(EDITOR_RUNS_OPEN_STORAGE_KEY),
      ),
    );
  } catch {
    return EDITOR_RUNS_DEFAULT_OPEN;
  }
}

export function rememberRunsOpen(open: boolean): void {
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(EDITOR_RUNS_OPEN_STORAGE_KEY, open ? "1" : "0");
    } catch {
      // Private mode / quota — in-memory subscribers still update.
    }
  }
  emitRunsOpenPreference();
}

/** Closed Runs overlay is still a satellite — never hide-by-default only. */
export function runsChromeMode(open: boolean): RunsChromeMode {
  return open ? "drawer" : "satellite";
}

export function runsSatelliteLabel(): string {
  return EDITOR_RUNS_SATELLITE_LABEL;
}

export function editorRunsListPath(
  workflowId: string,
  filter: { status?: string; limit?: number } = {},
): string {
  return listWorkflowExecutionsPath(workflowId, filter);
}

export function editorRunsListIsWorkflowScoped(workflowId: string): boolean {
  const path = editorRunsListPath(workflowId);
  return (
    path.startsWith(`/workflows/${workflowId}/executions`) &&
    path !== listExecutionsPath() &&
    !path.startsWith("/executions?")
  );
}

export function editorRunsUsesExistingListParams(
  workflowId: string,
  filter: { status?: string; limit?: number } = {},
): boolean {
  const path = editorRunsListPath(workflowId, {
    status: filter.status,
    limit: filter.limit || EDITOR_RUNS_LIST_LIMIT,
  });
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  for (const key of params.keys()) {
    if (key !== "status" && key !== "limit") {
      return false;
    }
  }
  return path.startsWith(`/workflows/${workflowId}/executions`);
}

export function editorRunOpenHref(
  executionId: string,
  workflowId?: string,
  embed = false,
): string {
  return maybeEmbedDeepLink(executionHistoryHref(executionId, workflowId), embed);
}

export function editorRunsWorkspaceHref(embed = false): string {
  return maybeEmbedDeepLink(EDITOR_WORKSPACE_EXECUTIONS_HREF, embed);
}

export function editorRunsDisplay(
  items: ExecutionRecord[],
  embed = false,
): EditorRunsOverlayRow[] {
  return executionListDisplay(items).map((row) => ({
    ...row,
    href: maybeEmbedDeepLink(row.href, embed),
    startedLabel: executionInboxTimeLabel(row.startedAt),
    durationLabel: executionInboxDurationLabel(row.startedAt, row.finishedAt),
  }));
}

export function editorRunsColumnIds(): readonly EditorRunsColumnId[] {
  return EDITOR_RUNS_COLUMNS.map((column) => column.id);
}

export function editorRunsKeyAction(
  key: string,
  index: number,
  length: number,
): ReturnType<typeof historyKeyAction> {
  return historyKeyAction(key, index, length);
}

export function editorRunsKeyboardHelp(): string {
  return EDITOR_RUN_OVERLAY_KEYBOARD_HELP;
}

export function editorRunsCanList(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return false;
  }
  return permissions.includes(EXECUTION_VIEW_PERMISSION);
}

export function editorRunsStatuses(): readonly string[] {
  return executionInboxStatuses();
}

export function editorRunsSkipStatuses(): readonly EditorRunsSkipStatus[] {
  return EDITOR_RUNS_SKIP_STATUSES;
}

export function editorRunsIndeterminateIsIconAndText(): boolean {
  const presentation = executionStatusPresentation("indeterminate");
  return (
    R4_GUARDRAILS.loudIndeterminate &&
    EDITOR_RUNS.indeterminateIconAndText &&
    presentation.indeterminate &&
    isIndeterminateStatus("indeterminate") &&
    Boolean(presentation.icon.trim()) &&
    /indeterminate/i.test(presentation.label) &&
    /indeterminate/i.test(presentation.description)
  );
}

export function editorRunSkipNodeId(
  steps: readonly ExecutionStep[],
  status: EditorRunsSkipStatus,
  waitingApprovalNodeIds: readonly string[] = [],
): string | null {
  const latest = [...latestStepsByNode(steps).values()];
  if (status === "indeterminate") {
    const waiting = waitingApprovalNodeIds.find((id) =>
      latest.some((step) => step.nodeId === id),
    );
    return (
      latest.find((step) => isIndeterminateStatus(step.status))?.nodeId ??
      waiting ??
      null
    );
  }
  return (
    latest.find((step) => normalizeExecutionStatus(step.status) === status)
      ?.nodeId ?? null
  );
}

export function editorRunsFindSkipTarget(
  rows: readonly ExecutionListRow[],
  status: EditorRunsSkipStatus,
  afterId?: string,
): ExecutionListRow | undefined {
  const matches = rows.filter((row) => rowMatchesSkipStatus(row, status));
  if (matches.length === 0) {
    return undefined;
  }
  if (!afterId) {
    return matches[0];
  }
  const index = matches.findIndex((row) => row.id === afterId);
  if (index === -1) {
    return matches[0];
  }
  return matches[index + 1] ?? matches[0];
}

export function editorRunsSkipTarget(input: {
  status: EditorRunsSkipStatus;
  selectedSteps?: readonly ExecutionStep[];
  waitingApprovalNodeIds?: readonly string[];
  rows: readonly ExecutionListRow[];
  selectedExecutionId?: string;
}): EditorRunsSkipTarget | null {
  if (input.selectedSteps?.length) {
    const nodeId = editorRunSkipNodeId(
      input.selectedSteps,
      input.status,
      input.waitingApprovalNodeIds,
    );
    if (nodeId) {
      return { kind: "node", nodeId };
    }
  }
  const row = editorRunsFindSkipTarget(
    input.rows,
    input.status,
    input.selectedExecutionId,
  );
  return row ? { kind: "run", executionId: row.id } : null;
}

export function editorRunsHighlightedNodeIds(
  steps: readonly ExecutionStep[],
  waitingApprovalNodeIds: readonly string[] = [],
): string[] {
  const ids = [...latestStepsByNode(steps).keys()];
  for (const id of waitingApprovalNodeIds) {
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function editorRunsHighlightSummary(count: number): string {
  if (count <= 0) {
    return "No matching steps on this draft canvas.";
  }
  if (count === 1) {
    return "Highlighting 1 related step on this canvas.";
  }
  return `Highlighting ${count} related steps on this canvas.`;
}

export function workspaceExecutionsRemainsOpsView(): boolean {
  const item = WORKSPACE_NAV_ITEMS.find((entry) => entry.id === "executions");
  return (
    item?.href === EDITOR_WORKSPACE_EXECUTIONS_HREF &&
    EDITOR_RUNS.workspaceExecutionsRemainsOpsView
  );
}

export function editorRunsEmbedRoutesUnchanged(): boolean {
  const list = EMBED_ROUTES.filter((route) => route.id === "executions");
  const detail = EMBED_ROUTES.filter((route) => route.id === "execution");
  const executionRelated = EMBED_ROUTES.filter(
    (route) => route.id === "executions" || route.id === "execution",
  );
  return (
    list.length === 1 &&
    list[0]?.standalone === "/executions" &&
    list[0]?.embed === "/embed/v1/executions" &&
    detail.length === 1 &&
    detail[0]?.standalone === "/executions/{id}" &&
    detail[0]?.embed === "/embed/v1/executions/{id}" &&
    executionRelated.length === 2
  );
}

export function editorRunsHasSingleOperatePath(): boolean {
  const open = editorRunOpenHref(
    "33333333-3333-4333-8333-333333333333",
    "11111111-1111-4111-8111-111111111111",
  );
  return (
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.overlayStaysEditorOnly &&
    EDITOR_RUNS.openOverlaysSameCanvas &&
    EDITOR_RUNS.noSecondReplayCanvas &&
    EDITOR_RUNS.noExecutionReplayMount &&
    !EDITOR_RUNS_SOURCES.includes(EDITOR_RUNS_REPLAY_GRAPH_SOURCE) &&
    open.startsWith("/executions/") &&
    !open.includes(INVENTED_REPLAY_ROUTE) &&
    EDITOR_RUNS_DETAIL_PATH === "/executions/{id}"
  );
}

export function editorRunsDraftsNeverRun(): boolean {
  return (
    EDITOR_RUNS.noDraftExecute &&
    EDITOR_RUNS.publishedWorkflowVersionIdOnly &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.publishedWorkflowVersionIdOnly &&
    /drafts? are never/i.test(PRE_RUN_PUBLISHED_ONLY_HELP) &&
    /workflowVersionId/.test(PRE_RUN_PUBLISHED_ONLY_HELP)
  );
}

export function editorRunsDoesNotInventReplayRoute(): boolean {
  return (
    EDITOR_RUNS.noReplayRoute &&
    R4_GUARDRAILS.noReplayProductRoute &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(INVENTED_REPLAY_ROUTE) ||
        route.embed.includes(INVENTED_REPLAY_ROUTE),
    ) &&
    !editorRunOpenHref("id").includes(INVENTED_REPLAY_ROUTE) &&
    !EDITOR_RUNS_DETAIL_PATH.includes(INVENTED_REPLAY_ROUTE)
  );
}

export function editorRunsCompareStaysClientSideAndHidden(): boolean {
  return (
    R4_GUARDRAILS.compareIsClientDiff &&
    EDITOR_RUNS.compareIsClientDiff &&
    EDITOR_RUNS.compareNotShownInOverlay &&
    !EDITOR_RUNS_SOURCES.includes(EDITOR_RUNS_COMPARE_SOURCE)
  );
}

export function editorRunsInheritsR4Guardrails(): boolean {
  return (
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.overlayStaysEditorOnly &&
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.compareIsClientDiff &&
    R4_GUARDRAILS.noReplayProductRoute &&
    /#255/.test(R4_LATER_STORY_NOTES.r42)
  );
}

export function editorRunsDoesNotBuryCanvas(): boolean {
  return (
    EDITOR_RUNS.doesNotBuryCanvas &&
    EDITOR_RUNS.persistentSatellite &&
    EDITOR_RUNS.defaultOpen === false &&
    EDITOR_RUNS.satelliteWidth === "2.75rem" &&
    EDITOR_RUNS.columnWidth === "20rem"
  );
}

function rowMatchesSkipStatus(
  row: ExecutionListRow,
  status: EditorRunsSkipStatus,
): boolean {
  if (status === "indeterminate") {
    return row.indeterminate || normalizeExecutionStatus(row.status) === status;
  }
  return normalizeExecutionStatus(row.status) === status;
}
