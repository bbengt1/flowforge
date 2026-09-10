/**
 * UX.6: executions drawer on the editor, scoped to the open workflow.
 *
 * Relates to #201 / Part of #195. Keep #201 open until merge.
 *
 * Chloe UI only. Reuses ExecutionHistory listbox patterns,
 * listWorkflowExecutions, and the existing `/executions/{id}` replay
 * page (embed-prefixed when mounted). No second replay canvas, no
 * apps/api changes, no UX.11 redacted run I/O, no draft execute.
 */

import { EMBED_ROUTES } from "./embed-contract.ts";
import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import {
  documentedExecutionStatuses,
  executionListDisplay,
  executionStatusPresentation,
  isIndeterminateStatus,
} from "./execution.ts";
import {
  executionHistoryHref,
  KEYBOARD_HISTORY_HELP,
  listExecutionsPath,
  listWorkflowExecutionsPath,
} from "./execution-contract.ts";
import { historyKeyAction } from "./execution-replay.ts";
import type { ExecutionListRow, ExecutionRecord } from "./execution-types.ts";
import { EXECUTION_VIEW_PERMISSION } from "./execution-types.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

export const UX6_STORY = 201;
export const UX6_EPIC = 195;
export const UX6_KEEP_STORY_OPEN = true;

export const EDITOR_RUNS_OPEN_ON_FIRST_PAINT = false;
export const EDITOR_RUNS_COLUMN_WIDTH = "22rem";
export const EDITOR_RUNS_PANEL_ID = "editor-runs-drawer";
export const EDITOR_RUNS_LIST_LIMIT = 50;
export const EDITOR_WORKSPACE_EXECUTIONS_HREF = "/executions";

export const EDITOR_RUNS = {
  hiddenOnFirstPaint: true,
  scopedToOpenWorkflow: true,
  usesWorkflowExecutionsCollection: true,
  keyboardMatchesHistory: true,
  openGoesToExistingReplayRoute: true,
  noSecondReplayCanvas: true,
  indeterminateIconAndText: true,
  startPublishedUsesExistingRunControl: true,
  workspaceExecutionsRemainsOpsView: true,
  noNewEmbedRoutes: true,
  noDraftExecute: true,
  noRedactedRunIoInInspector: true,
} as const;

export const EDITOR_RUNS_SOURCES = [
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/executions/ExecutionStatusBadge.tsx",
  "src/components/workflows/RunControl.tsx",
  "src/components/workflows/ManualStartPanel.tsx",
] as const;

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
): ExecutionListRow[] {
  return executionListDisplay(items).map((row) => ({
    ...row,
    href: maybeEmbedDeepLink(row.href, embed),
  }));
}

export function editorRunsKeyAction(
  key: string,
  index: number,
  length: number,
): ReturnType<typeof historyKeyAction> {
  return historyKeyAction(key, index, length);
}

export function editorRunsKeyboardHelp(): string {
  return KEYBOARD_HISTORY_HELP;
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
  return documentedExecutionStatuses();
}

export function editorRunsIndeterminateIsIconAndText(): boolean {
  const presentation = executionStatusPresentation("indeterminate");
  return (
    presentation.indeterminate &&
    isIndeterminateStatus("indeterminate") &&
    Boolean(presentation.icon.trim()) &&
    /indeterminate/i.test(presentation.label) &&
    /indeterminate/i.test(presentation.description)
  );
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
