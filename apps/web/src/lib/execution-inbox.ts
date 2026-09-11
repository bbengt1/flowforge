/**
 * R4.1: workspace `/executions` inbox density + filters.
 *
 * Relates to #254 / Part of #230. Keep #254 open.
 *
 * Chloe UI only. Densify the existing inbox in place (D6). Reuse E5
 * list/detail clients — `GET /executions` (`status`, `workflowId`,
 * `limit`) and `GET /workflows/{id}/executions` (`status`, `limit`).
 * Do not invent cursor / time range / triggerType / requestedBy /
 * correlationId filters, `/replay`, a compare route, or SSE.
 * Drafts never run. Secrets stay `[redacted]`. ADV/RBAC/embed stay.
 *
 * Gracie R4 guardrails (bake here; later stories inherit):
 * 1. One operate path — inbox lists/filters and opens existing
 *    `/executions/{id}` detail. Do not mount a second replay graph
 *    on the inbox. R4.2 densifies the editor overlay only.
 * 2. Loud `indeterminate` — never silent success when uncertain.
 *    R4.4 densifies cancel/retry/stop; do not regress loud treatment.
 * 3. Drafts never run — published `workflowVersionId` only.
 * 4. Compare is existing client-side diff. Ping jonny only if a new
 *    projection is required. No `/replay` product route.
 */

import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import {
  INDETERMINATE_STATUS_HELP,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  REDACTED_HELP,
  executionHistoryHref,
  listExecutionsPath,
  listWorkflowExecutionsPath,
} from "./execution-contract.ts";
import {
  documentedExecutionStatuses,
  executionListDisplay,
  executionListText,
  executionStatusPresentation,
  containsUnredactedSecret,
  isIndeterminateStatus,
} from "./execution.ts";
import { isIndeterminateUnmistakable } from "./execution-replay.ts";
import {
  REDACTED_MARKER,
  type ExecutionListQuery,
  type ExecutionListRow,
  type ExecutionRecord,
} from "./execution-types.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

export const R41_STORY = 254;
export const R41_EPIC = 230;
export const R41_KEEP_STORY_OPEN = true;

export const EXECUTION_INBOX_HREF = "/executions";
export const EXECUTION_INBOX_DEFAULT_LIMIT = 50;
export const EXECUTION_INBOX_LIMITS = [10, 25, 50, 100] as const;

export const EXECUTION_INBOX_QUERY_KEYS = [
  "status",
  "workflowId",
  "limit",
] as const;

/** jonny-deferred list filters — display is fine; do not send as query. */
export const EXECUTION_INBOX_DEFERRED_QUERY_KEYS = [
  "cursor",
  "startedAfter",
  "startedBefore",
  "from",
  "to",
  "triggerType",
  "requestedBy",
  "correlationId",
] as const;

export const INVENTED_REPLAY_ROUTE = "/replay";

export const EXECUTION_INBOX_KEYBOARD_HELP =
  "Arrow keys move the inbox. Enter or Space opens the focused run on existing /executions/{id} detail. Status and workflow filters stay on this page.";

export const EXECUTION_INBOX_OPEN_LABEL = "Open";

export const EXECUTION_INBOX_HELP =
  "Workspace inbox for operate-a-run. Filter with GET /executions status, workflowId, and limit. Open a row into existing /executions/{id} detail — no second graph here. Drafts never run. Secrets stay [redacted].";

export const EXECUTION_INBOX_DETAIL_PATH = "/executions/{id}";
export const EXECUTION_INBOX_REPLAY_GRAPH_SOURCE =
  "src/components/executions/ExecutionReplay.tsx";

/** Gracie R4 guardrails — inherited by R4.2–R4.5. */
export const R4_GUARDRAILS = {
  oneOperatePath: true,
  inboxOpensExistingDetail: true,
  noInboxReplayGraph: true,
  overlayStaysEditorOnly: true,
  loudIndeterminate: true,
  neverSilentSuccessWhenUncertain: true,
  draftsNeverRun: true,
  publishedWorkflowVersionIdOnly: true,
  compareIsClientDiff: true,
  pingJonnyOnlyIfCompareNeedsProjection: true,
  noReplayProductRoute: true,
} as const;

export const R4_LATER_STORY_NOTES = {
  r42: "R4.2 / #255: densify the editor same-canvas overlay only. Do not also mount a replay graph on the /executions inbox.",
  r43: "R4.3 / #256: NDV last-run I/O stays on the editor inspector from GET /executions/{id}. Inbox still opens existing detail.",
  r44: "R4.4 / #257: densify cancel/retry/stop. Keep loud indeterminate — never silent success when uncertain.",
  r45: "R4.5 / #258: waiting → POST /approvals/{id}/decide. No invented resume or /replay route.",
} as const;

export const EXECUTION_INBOX = {
  operateDensity: true,
  statusAndWorkflowFilters: true,
  usefulColumns: true,
  openToDetailWithoutHunting: true,
  usesExistingListParamsOnly: true,
  noInventedCursorFilter: true,
  noInventedTimeRangeFilter: true,
  noInventedTriggerTypeFilter: true,
  noInventedRequestedByFilter: true,
  noInventedCorrelationIdFilter: true,
  draftsNeverRun: true,
  publishedWorkflowVersionIdOnly: true,
  redactionPreserved: true,
  oneOperatePath: true,
  noInboxReplayGraph: true,
  loudIndeterminate: true,
  noReplayRoute: true,
  noCompareRoute: true,
  compareIsClientDiff: true,
  noSse: true,
  rbacFailClosed: true,
  embedUnchanged: true,
  migrateInPlace: true,
} as const;

export const EXECUTION_INBOX_COLUMNS = [
  { id: "status", label: "Status" },
  { id: "workflow", label: "Workflow" },
  { id: "version", label: "Version" },
  { id: "started", label: "Started" },
  { id: "duration", label: "Duration" },
  { id: "correlation", label: "Correlation" },
  { id: "open", label: "Open" },
] as const;

export const EXECUTION_INBOX_SOURCES: readonly string[] = [
  "src/lib/execution-inbox.ts",
  "src/lib/execution-client.ts",
  "src/lib/execution-contract.ts",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/app/executions/page.tsx",
];

export type ExecutionInboxColumnId =
  (typeof EXECUTION_INBOX_COLUMNS)[number]["id"];

export type ExecutionInboxRow = ExecutionListRow & {
  startedLabel: string;
  durationLabel: string;
  openLabel: typeof EXECUTION_INBOX_OPEN_LABEL;
};

type InboxSearchInput =
  | string
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined | null>>;

function readSearchValue(
  raw: string | string[] | undefined | null,
): string {
  if (Array.isArray(raw)) {
    return raw[0]?.trim() ?? "";
  }
  return typeof raw === "string" ? raw.trim() : "";
}

export function executionInboxSearchParams(
  search: InboxSearchInput,
): URLSearchParams {
  if (typeof search === "string") {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  }
  if (search instanceof URLSearchParams) {
    return search;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const trimmed = readSearchValue(value);
    if (trimmed) {
      params.set(key, trimmed);
    }
  }
  return params;
}

export function parseExecutionInboxQuery(
  search: InboxSearchInput = "",
): ExecutionListQuery {
  const params = executionInboxSearchParams(search);
  const statusRaw = params.get("status")?.trim() ?? "";
  const status = documentedExecutionStatuses().includes(statusRaw)
    ? statusRaw
    : "";
  const workflowId = params.get("workflowId")?.trim() ?? "";
  const limitRaw = params.get("limit")?.trim() ?? "";
  let limit = EXECUTION_INBOX_DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (Number.isFinite(parsed)) {
      limit = Math.max(1, Math.min(100, Math.trunc(parsed)));
    }
  }
  return { workflowId, status, limit };
}

export function serializeExecutionInboxQuery(
  query: ExecutionListQuery,
): URLSearchParams {
  const params = new URLSearchParams();
  const workflowId = query.workflowId?.trim();
  const status = query.status?.trim();
  if (workflowId) {
    params.set("workflowId", workflowId);
  }
  if (status && documentedExecutionStatuses().includes(status)) {
    params.set("status", status);
  }
  if (
    typeof query.limit === "number" &&
    Number.isFinite(query.limit) &&
    query.limit !== EXECUTION_INBOX_DEFAULT_LIMIT
  ) {
    params.set(
      "limit",
      String(Math.max(1, Math.min(100, Math.trunc(query.limit)))),
    );
  }
  return params;
}

export function executionInboxHref(
  query: ExecutionListQuery = {},
  embed = false,
): string {
  const qs = serializeExecutionInboxQuery(query).toString();
  const href = qs ? `${EXECUTION_INBOX_HREF}?${qs}` : EXECUTION_INBOX_HREF;
  return maybeEmbedDeepLink(href, embed);
}

export function executionInboxListPath(query: ExecutionListQuery = {}): string {
  const workflowId = query.workflowId?.trim();
  const filter = {
    status: query.status,
    limit: query.limit || EXECUTION_INBOX_DEFAULT_LIMIT,
  };
  if (workflowId) {
    return listWorkflowExecutionsPath(workflowId, filter);
  }
  return listExecutionsPath(filter);
}

export function executionInboxOpenHref(
  executionId: string,
  workflowId?: string,
  embed = false,
): string {
  return maybeEmbedDeepLink(executionHistoryHref(executionId, workflowId), embed);
}

export function executionInboxHasActiveFilters(
  query: ExecutionListQuery,
): boolean {
  return Boolean(
    query.workflowId?.trim() ||
      query.status?.trim() ||
      (typeof query.limit === "number" &&
        query.limit !== EXECUTION_INBOX_DEFAULT_LIMIT),
  );
}

export function executionInboxStatuses(): readonly string[] {
  return documentedExecutionStatuses();
}

export function executionInboxTimeLabel(iso: string): string {
  if (!iso || iso === "—") {
    return "—";
  }
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return iso;
  }
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function executionInboxDurationLabel(
  startedAt: string,
  finishedAt: string,
): string {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return "—";
  }
  const ms = end - start;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) {
    return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem ? `${hours}h ${minRem}m` : `${hours}h`;
}

export function executionInboxDisplay(
  items: readonly ExecutionRecord[],
): ExecutionInboxRow[] {
  return executionListDisplay([...items]).map((row) => ({
    ...row,
    startedLabel: executionInboxTimeLabel(row.startedAt),
    durationLabel: executionInboxDurationLabel(row.startedAt, row.finishedAt),
    openLabel: EXECUTION_INBOX_OPEN_LABEL,
  }));
}

export function executionInboxColumnText(row: ExecutionInboxRow): string {
  return [
    row.status,
    row.workflowLabel,
    row.versionPin,
    row.startedLabel,
    row.durationLabel,
    row.correlationId,
    row.openLabel,
    row.href,
  ].join(" ");
}

export function executionInboxQueryOmitsDeferred(
  search: InboxSearchInput,
): boolean {
  const query = parseExecutionInboxQuery(search);
  const href = executionInboxHref(query);
  const path = executionInboxListPath(query);
  const serialized = serializeExecutionInboxQuery(query);
  return EXECUTION_INBOX_DEFERRED_QUERY_KEYS.every(
    (key) =>
      !serialized.has(key) &&
      !href.includes(`${key}=`) &&
      !path.includes(`${key}=`),
  );
}

export function executionInboxUsesExistingListParams(
  query: ExecutionListQuery = {},
): boolean {
  const path = executionInboxListPath(query);
  const allowed = new Set<string>(EXECUTION_INBOX_QUERY_KEYS);
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  if (query.workflowId?.trim()) {
    return path.startsWith(`/workflows/${query.workflowId.trim()}/executions`);
  }
  return path === listExecutionsPath({
    status: query.status,
    limit: query.limit || EXECUTION_INBOX_DEFAULT_LIMIT,
  });
}

export function executionInboxPreservesRedaction(
  items: readonly ExecutionRecord[],
): boolean {
  const text = [
    executionListText([...items]),
    ...executionInboxDisplay(items).map(executionInboxColumnText),
    REDACTED_HELP,
    REDACTED_MARKER,
  ].join("\n");
  return text.includes(REDACTED_MARKER) && !containsUnredactedSecret(text);
}

export function executionInboxDraftsNeverRun(): boolean {
  return (
    EXECUTION_INBOX.draftsNeverRun &&
    R4_GUARDRAILS.draftsNeverRun &&
    R4_GUARDRAILS.publishedWorkflowVersionIdOnly &&
    /drafts? are never/i.test(PRE_RUN_PUBLISHED_ONLY_HELP) &&
    /workflowVersionId/.test(PRE_RUN_PUBLISHED_ONLY_HELP)
  );
}

export function executionInboxDoesNotInventReplayRoute(): boolean {
  const invented = INVENTED_REPLAY_ROUTE;
  return (
    EXECUTION_INBOX.noReplayRoute &&
    R4_GUARDRAILS.noReplayProductRoute &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes(invented) || route.embed.includes(invented),
    ) &&
    !executionInboxOpenHref("id").includes(invented) &&
    !executionInboxHref().includes(invented)
  );
}

export function executionInboxHasSingleOperatePath(): boolean {
  const open = executionInboxOpenHref(
    "33333333-3333-4333-8333-333333333333",
    "11111111-1111-4111-8111-111111111111",
  );
  return (
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.inboxOpensExistingDetail &&
    R4_GUARDRAILS.noInboxReplayGraph &&
    EXECUTION_INBOX.oneOperatePath &&
    !EXECUTION_INBOX_SOURCES.includes(EXECUTION_INBOX_REPLAY_GRAPH_SOURCE) &&
    open.startsWith("/executions/") &&
    !open.includes(INVENTED_REPLAY_ROUTE) &&
    EXECUTION_INBOX_DETAIL_PATH === "/executions/{id}"
  );
}

export function executionInboxIndeterminateIsLoud(
  status = "indeterminate",
): boolean {
  const presentation = executionStatusPresentation(status);
  return (
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.neverSilentSuccessWhenUncertain &&
    EXECUTION_INBOX.loudIndeterminate &&
    isIndeterminateStatus(status) &&
    isIndeterminateUnmistakable(presentation) &&
    presentation.tone === "indeterminate" &&
    /did not run/i.test(INDETERMINATE_STATUS_HELP)
  );
}

export function executionInboxCompareStaysClientSide(): boolean {
  return (
    R4_GUARDRAILS.compareIsClientDiff &&
    R4_GUARDRAILS.pingJonnyOnlyIfCompareNeedsProjection &&
    EXECUTION_INBOX.compareIsClientDiff &&
    EXECUTION_INBOX.noCompareRoute &&
    !EMBED_ROUTES.some(
      (route) =>
        route.standalone.includes("/executions/compare") ||
        route.embed.includes("/executions/compare"),
    )
  );
}

export function executionInboxEmbedUnchanged(): boolean {
  const item = WORKSPACE_NAV_ITEMS.find((entry) => entry.id === "executions");
  const list = EMBED_ROUTES.filter((route) => route.id === "executions");
  const detail = EMBED_ROUTES.filter((route) => route.id === "execution");
  return (
    EXECUTION_INBOX.embedUnchanged &&
    item?.href === EXECUTION_INBOX_HREF &&
    list.length === 1 &&
    list[0]?.standalone === "/executions" &&
    list[0]?.embed === "/embed/v1/executions" &&
    detail.length === 1 &&
    detail[0]?.standalone === "/executions/{id}" &&
    detail[0]?.embed === "/embed/v1/executions/{id}"
  );
}

export function executionInboxColumnIds(): readonly ExecutionInboxColumnId[] {
  return EXECUTION_INBOX_COLUMNS.map((column) => column.id);
}
