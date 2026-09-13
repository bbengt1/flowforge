/**
 * UXL.4: Peak-end operate endings.
 *
 * Relates to #291 / Part of #287. Keep #291 open.
 *
 * Chloe UI only. Densify existing operate endings in place (D6) on
 * the Runs overlay, `/executions` inbox, NDV last-run, and
 * activation after Test run / Start published. Inherit the R4
 * operate path: overlay-on-this-canvas **or** `/executions/{id}` —
 * not both graphs. No `/replay`. No server compare.
 *
 * After Start published or Test run, the editor ends on the Runs
 * overlay for that run (remembered-open satellite), not only a toast.
 * Fail → jump to the node (R4.3). `indeterminate` stays icon + text
 * + explanation on overlay and inbox. Waiting → decide stays on
 * overlay and inbox (R4.5). Success is explicit and distinct from
 * `indeterminate`. Cancel / retry / stop remain on the same path
 * (R4.4). Inbox is not a second replay graph. Open execution still
 * goes to `/executions/{id}`.
 *
 * Out of scope: UXL.5–8, inventing a second ExecutionReplay on
 * inbox, silent success toast as the only ending.
 */

import { isExecutionAwaitingApproval } from "./approval.ts";
import { DOHERTY_PENDING_CHROME } from "./doherty-pending-chrome.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { EDITOR_NDV_RUN_IO } from "./editor-ndv-run-io.ts";
import {
  EDITOR_RUNS,
  EDITOR_RUNS_DETAIL_PATH,
  INVENTED_REPLAY_ROUTE,
  editorRunOpenHref,
  editorRunsHasSingleOperatePath,
  editorRunsIndeterminateIsIconAndText,
  rememberRunsOpen,
} from "./editor-runs.ts";
import { EDITOR_TOPBAR_CHUNKING } from "./editor-topbar-chunking.ts";
import { EDITOR_WORKING_MEMORY } from "./editor-working-memory.ts";
import {
  EXECUTION_INBOX,
  EXECUTION_INBOX_DETAIL_PATH,
  R4_GUARDRAILS,
  executionInboxIndeterminateIsLoud,
  executionInboxHasSingleOperatePath,
} from "./execution-inbox.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import { EXECUTION_DECIDE } from "./execution-decide.ts";
import { EXECUTION_OPERATE } from "./execution-operate.ts";
import {
  executionStatusPresentation,
  isIndeterminateStatus,
  normalizeExecutionStatus,
} from "./execution.ts";
import { workflowEditorHref } from "./product-home.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

export const UXL4_STORY = 291;
export const UXL4_EPIC = 287;
export const UXL4_KEEP_STORY_OPEN = true;
export const UXL4_ID = "UXL.4-peak-end-endings" as const;

export const UXL4_BRIEF = "docs/architecture/flowforge-ux-laws.md";

export const PEAK_END_RUN_STORAGE_KEY = "flowforge.editor.peak-end-run.v1";

export type PeakEndGesture = "start" | "test-run";

export type PeakEndKind =
  | "success"
  | "failed"
  | "indeterminate"
  | "waiting"
  | "running"
  | "canceled"
  | "queued";

export type PeakEndHandoff = {
  workflowId: string;
  executionId: string;
};

export const PEAK_END_GESTURES = ["start", "test-run"] as const satisfies readonly PeakEndGesture[];

export const PEAK_END_KINDS = [
  "success",
  "failed",
  "indeterminate",
  "waiting",
  "running",
  "canceled",
  "queued",
] as const satisfies readonly PeakEndKind[];

export const PEAK_END_LABELS = {
  success: "Run succeeded.",
  failed: "Run failed — jumped to the node.",
  indeterminate: `Indeterminate — ${INDETERMINATE_STATUS_HELP}`,
  waiting: "Waiting — decide the bound approval. Resume is decide.",
  running: "Run is in progress on this canvas.",
  canceled: "Run canceled.",
  queued: "Run queued — watching on this canvas.",
} as const satisfies Record<PeakEndKind, string>;

export const PEAK_END_INBOX_LABELS = {
  success: "Succeeded — completed successfully.",
  failed: "Failed — open execution to inspect.",
  indeterminate: "Indeterminate — do not assume the action did not run.",
  waiting: "Waiting — decide the bound approval. Resume is decide.",
  running: "Running.",
  canceled: "Canceled.",
  queued: "Queued.",
} as const satisfies Record<PeakEndKind, string>;

export const PEAK_END_NDV_LABELS = {
  success: "Last run succeeded.",
  failed: "Last run failed — jumped to the node.",
  indeterminate: INDETERMINATE_STATUS_HELP,
  waiting: "Waiting on approval. Decide the bound approval — resume is decide.",
  running: "Last run is still in progress.",
  canceled: "Last run was canceled.",
  queued: "Last run is queued.",
} as const satisfies Record<PeakEndKind, string>;

export const PEAK_END_HEADLINES = {
  success: "Run succeeded",
  failed: "Run failed",
  indeterminate: "Indeterminate",
  waiting: "Waiting — decide",
  running: "On this canvas",
  canceled: "Run canceled",
  queued: "On this canvas",
} as const satisfies Record<PeakEndKind, string>;

export const PEAK_END_OPERATE = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritUxl1TopBarGroups: true,
  inheritUxl2WorkingMemory: true,
  inheritUxl3DohertyPending: true,
  inheritR42OverlaySatellite: true,
  inheritR43FailJumpsToNode: true,
  inheritR44CancelRetryStop: true,
  inheritR45WaitingDecide: true,
  d6MigrateInPlace: true,
  afterStartOrTestRunOpenOverlay: true,
  rememberedOpenSatellite: true,
  notOnlyAToast: true,
  failJumpsToNode: true,
  loudIndeterminateOnOverlayAndInbox: true,
  waitingDecideOnOverlayAndInbox: true,
  successExplicitAndDistinctFromIndeterminate: true,
  cancelRetryStopStayOnSamePath: true,
  inboxIsNotSecondReplayGraph: true,
  openExecutionGoesToExecutionsId: true,
  oneReplayPath: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  noAppsApiChanges: true,
  noReplayRoute: true,
  noSecondExecutionReplayOnInbox: true,
  noSilentSuccessToastOnly: true,
  uxl5ThroughUxl8OutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const PEAK_END_OPERATE_HELP =
  "After Start published or Test run, the editor ends on the Runs overlay for that run (remembered-open satellite), not only a toast. Fail jumps to the node. Indeterminate stays icon + text + explanation on overlay and inbox. Waiting → decide stays on overlay and inbox. Success is explicit and distinct from indeterminate. Cancel / retry / stop remain on the same path. Open execution still goes to /executions/{id}. Inbox is not a second replay graph.";

export const PEAK_END_OPERATE_SOURCES = [
  "src/lib/peak-end-operate-endings.ts",
  "src/components/chrome/PeakEndEnding.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/workflows/LastRunIoPanel.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/home/WorkflowHome.tsx",
] as const;

export const INVENTED_PEAK_END_SURFACES = [
  "ExecutionReplay",
  "PeakEndReplayGraph",
  "/replay",
  "inventInboxReplay",
] as const;

export function peakEndKind(
  status?: string,
  waiting = false,
): PeakEndKind {
  if (isIndeterminateStatus(status)) {
    return "indeterminate";
  }
  if (waiting || isExecutionAwaitingApproval(status)) {
    return "waiting";
  }
  const folded = normalizeExecutionStatus(status);
  if (folded === "succeeded") {
    return "success";
  }
  if (folded === "failed") {
    return "failed";
  }
  if (folded === "canceled") {
    return "canceled";
  }
  if (folded === "queued" || folded === "pinned") {
    return "queued";
  }
  return "running";
}

export function peakEndLabel(
  kind: PeakEndKind,
  surface: "overlay" | "inbox" | "ndv" = "overlay",
): string {
  if (surface === "inbox") {
    return PEAK_END_INBOX_LABELS[kind];
  }
  if (surface === "ndv") {
    return PEAK_END_NDV_LABELS[kind];
  }
  return PEAK_END_LABELS[kind];
}

export function peakEndHeadline(kind: PeakEndKind): string {
  return PEAK_END_HEADLINES[kind];
}

export function peakEndSurfaceClassName(kind: PeakEndKind): string {
  switch (kind) {
    case "indeterminate":
      return "border-2 border-amber-700 bg-amber-50";
    case "waiting":
      return "border-2 border-indigo-700 bg-indigo-50";
    case "failed":
      return "border-2 border-rose-700 bg-rose-50";
    case "success":
      return "border-2 border-emerald-700 bg-emerald-50";
    case "canceled":
      return "border border-zinc-400 bg-zinc-50";
    default:
      return "border border-teal-800 bg-teal-50";
  }
}

export function peakEndTextClassName(kind: PeakEndKind): string {
  switch (kind) {
    case "indeterminate":
      return "text-amber-950";
    case "waiting":
      return "text-indigo-950";
    case "failed":
      return "text-rose-950";
    case "success":
      return "text-emerald-950";
    default:
      return "text-zinc-800";
  }
}

export function peakEndShouldOpenOverlay(ok: boolean): boolean {
  return ok && PEAK_END_OPERATE.afterStartOrTestRunOpenOverlay;
}

export function peakEndEditorHref(workflowId: string): string {
  return workflowEditorHref(workflowId);
}

export function peakEndOpenExecutionHref(
  executionId: string,
  workflowId?: string,
): string {
  return editorRunOpenHref(executionId, workflowId);
}

let memoryHandoff: PeakEndHandoff | null = null;

export function parsePeakEndHandoff(
  raw: string | null | undefined,
): PeakEndHandoff | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PeakEndHandoff>;
    const workflowId = parsed.workflowId?.trim() ?? "";
    const executionId = parsed.executionId?.trim() ?? "";
    if (!workflowId || !executionId) {
      return null;
    }
    return { workflowId, executionId };
  } catch {
    return null;
  }
}

function writePeakEndStorage(input: PeakEndHandoff): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.setItem(
      PEAK_END_RUN_STORAGE_KEY,
      JSON.stringify({
        workflowId: input.workflowId,
        executionId: input.executionId,
      }),
    );
  } catch {
    // Private mode / quota — in-memory handoff still works in-process.
  }
}

function readPeakEndStorage(): PeakEndHandoff | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }
  try {
    return parsePeakEndHandoff(sessionStorage.getItem(PEAK_END_RUN_STORAGE_KEY));
  } catch {
    return null;
  }
}

function clearPeakEndStorage(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.removeItem(PEAK_END_RUN_STORAGE_KEY);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function rememberPeakEndOverlay(input: PeakEndHandoff): void {
  const handoff = {
    workflowId: input.workflowId.trim(),
    executionId: input.executionId.trim(),
  };
  if (!handoff.workflowId || !handoff.executionId) {
    return;
  }
  memoryHandoff = handoff;
  rememberRunsOpen(true);
  writePeakEndStorage(handoff);
}

export function consumePeakEndOverlay(workflowId: string): string | null {
  const scoped = workflowId.trim();
  if (!scoped) {
    return null;
  }
  const stored = readPeakEndStorage();
  const handoff =
    stored?.workflowId === scoped
      ? stored
      : memoryHandoff?.workflowId === scoped
        ? memoryHandoff
        : null;
  if (!handoff) {
    return null;
  }
  memoryHandoff = null;
  clearPeakEndStorage();
  rememberRunsOpen(true);
  return handoff.executionId;
}

export function peakEndSuccessIsDistinctFromIndeterminate(): boolean {
  const success = executionStatusPresentation("succeeded");
  const uncertain = executionStatusPresentation("indeterminate");
  return (
    PEAK_END_OPERATE.successExplicitAndDistinctFromIndeterminate &&
    peakEndKind("succeeded") === "success" &&
    peakEndKind("indeterminate") === "indeterminate" &&
    (PEAK_END_LABELS.success as string) !== PEAK_END_LABELS.indeterminate &&
    !/indeterminate/i.test(PEAK_END_LABELS.success) &&
    /indeterminate/i.test(PEAK_END_LABELS.indeterminate) &&
    /succeed/i.test(PEAK_END_LABELS.success) &&
    success.tone === "succeeded" &&
    uncertain.tone === "indeterminate" &&
    success.icon !== uncertain.icon &&
    success.label !== uncertain.label
  );
}

export function peakEndNeverSilentSuccessWhenUncertain(status?: string): boolean {
  const kind = peakEndKind(status);
  if (isIndeterminateStatus(status)) {
    return kind === "indeterminate" && !/succeed/i.test(peakEndLabel(kind));
  }
  return kind !== "indeterminate" || !/succeed/i.test(peakEndLabel(kind));
}

export function peakEndOpenStaysExecutionsId(): boolean {
  const open = peakEndOpenExecutionHref(
    "33333333-3333-4333-8333-333333333333",
    "11111111-1111-4111-8111-111111111111",
  );
  return (
    PEAK_END_OPERATE.openExecutionGoesToExecutionsId &&
    open.startsWith("/executions/") &&
    !open.includes(INVENTED_REPLAY_ROUTE) &&
    EDITOR_RUNS_DETAIL_PATH === "/executions/{id}" &&
    EXECUTION_INBOX_DETAIL_PATH === "/executions/{id}"
  );
}

export function peakEndInboxIsNotSecondReplay(source: string): boolean {
  return (
    PEAK_END_OPERATE.inboxIsNotSecondReplayGraph &&
    PEAK_END_OPERATE.noSecondExecutionReplayOnInbox &&
    EXECUTION_INBOX.noInboxReplayGraph &&
    !peakEndInventedSecondReplay(source)
  );
}

export function peakEndInventedSecondReplay(source: string): boolean {
  return INVENTED_PEAK_END_SURFACES.some((token) => {
    if (token === "ExecutionReplay") {
      return (
        source.includes('from "@/components/executions/ExecutionReplay"') ||
        source.includes("from \"@/components/executions/ExecutionReplay\"") ||
        source.includes("<ExecutionReplay")
      );
    }
    return source.includes(token);
  });
}

export function peakEndHoldsHardLines(): boolean {
  return (
    PEAK_END_OPERATE.yamlIsSourceOfTruth &&
    PEAK_END_OPERATE.draftsNeverRun &&
    PEAK_END_OPERATE.vaultDisplayNameUuidOnly &&
    PEAK_END_OPERATE.adv021ChromeFromSessionEmbedOnly &&
    PEAK_END_OPERATE.adv024MembershipIsolationStayGrantGated &&
    PEAK_END_OPERATE.oneReplayPath &&
    PEAK_END_OPERATE.loudIndeterminateOnOverlayAndInbox &&
    PEAK_END_OPERATE.failClosedCatalogs &&
    PEAK_END_OPERATE.notAnN8nClone &&
    PEAK_END_OPERATE.noReplayRoute &&
    PEAK_END_OPERATE.noAppsApiChanges &&
    PEAK_END_OPERATE.noSilentSuccessToastOnly &&
    EDITOR_CHROME.draftsCannotStart &&
    EDITOR_CHROME.invalidYamlNeverGuessesGraph &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization &&
    editorRunsHasSingleOperatePath() &&
    executionInboxHasSingleOperatePath() &&
    peakEndOpenStaysExecutionsId() &&
    peakEndSuccessIsDistinctFromIndeterminate()
  );
}

export function peakEndInheritsPriorStories(): boolean {
  return (
    PEAK_END_OPERATE.inheritUxl1TopBarGroups &&
    PEAK_END_OPERATE.inheritUxl2WorkingMemory &&
    PEAK_END_OPERATE.inheritUxl3DohertyPending &&
    PEAK_END_OPERATE.inheritR42OverlaySatellite &&
    PEAK_END_OPERATE.inheritR43FailJumpsToNode &&
    PEAK_END_OPERATE.inheritR44CancelRetryStop &&
    PEAK_END_OPERATE.inheritR45WaitingDecide &&
    EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers &&
    EDITOR_WORKING_MEMORY.editingADraftInWords &&
    DOHERTY_PENDING_CHROME.loudIndeterminate &&
    DOHERTY_PENDING_CHROME.noInventedIndeterminateSuccess &&
    EDITOR_RUNS.rememberedOpen &&
    EDITOR_RUNS.noSecondReplayCanvas &&
    EDITOR_NDV_RUN_IO.failuresJumpToNode &&
    EXECUTION_OPERATE.inboxRowsExposeActions &&
    EXECUTION_OPERATE.overlayExposesActions &&
    EXECUTION_DECIDE.inboxRowsExposeDecide &&
    EXECUTION_DECIDE.overlayExposesDecide &&
    editorRunsIndeterminateIsIconAndText() &&
    executionInboxIndeterminateIsLoud() &&
    R4_GUARDRAILS.oneOperatePath &&
    R4_GUARDRAILS.loudIndeterminate
  );
}

export function peakEndEndsOnOverlay(source: string): boolean {
  return (
    source.includes("rememberPeakEndOverlay") ||
    source.includes("consumePeakEndOverlay") ||
    source.includes("endOperateOnOverlay") ||
    (source.includes("rememberRunsOpen(true)") &&
      source.includes("selectRun("))
  );
}

export function peakEndShowsExplicitEnding(source: string): boolean {
  return (
    source.includes("data-peak-end") ||
    source.includes("PeakEndEnding") ||
    source.includes("peakEndKind") ||
    source.includes("PEAK_END_LABELS")
  );
}
