/**
 * UXL.3: Doherty-safe pending chrome.
 *
 * Relates to #290 / Part of #287. Keep #290 open.
 *
 * Chloe UI only. Densify existing pending/busy chrome in place (D6)
 * on Editor, NDV, Runs, vault, and `/embed/v1`. No websocket. Existing
 * requests only. Perceived <400ms chrome — never skip fail-closed
 * waits.
 *
 * Save draft, Publish, Test run, Start published, vault test/rotate,
 * and catalog load show pending immediately, then success or error.
 * Canvas stays interactive while those requests run.
 *
 * Fail-closed waits stay visible waits: missing `session.embed` is
 * still an alert (ADV-021); catalog 403 / empty still fail closed;
 * invalid YAML still does not draw a guessed graph. Host `?tenant=` /
 * `?workbench=` stay display-only. No invented progress that claims a
 * run succeeded when status is `indeterminate`.
 *
 * Out of scope: UXL.4–UXL.8, inventing SSE, weakening ADV fail-closed,
 * silent success on indeterminate.
 */

import { EDITOR_LIBRARY } from "./editor-library.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import { isIndeterminateStatus } from "./execution.ts";
import { ENGINE_CATALOG_UNAVAILABLE_HELP } from "./catalog-fail-closed.ts";
import { EDITOR_WORKING_MEMORY } from "./editor-working-memory.ts";
import { EDITOR_TOPBAR_CHUNKING } from "./editor-topbar-chunking.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import { CREDENTIAL_DETAIL_HELP } from "./credential-detail.ts";

export const UXL3_STORY = 290;
export const UXL3_EPIC = 287;
export const UXL3_KEEP_STORY_OPEN = true;
export const UXL3_ID = "UXL.3-doherty-pending" as const;

export const UXL3_BRIEF = "docs/internal/flowforge-ux-laws.md";

export const DOHERTY_PERCEIVED_MS = 400;

export type DohertyGesture =
  | "save"
  | "publish"
  | "test-run"
  | "start"
  | "catalog"
  | "vault-test"
  | "vault-rotate";

export type DohertyPhase =
  | "idle"
  | "pending"
  | "success"
  | "error"
  | "indeterminate";

export type DohertyChrome = {
  gesture: DohertyGesture | null;
  phase: DohertyPhase;
};

export const DOHERTY_GESTURES = [
  "save",
  "publish",
  "test-run",
  "start",
  "catalog",
  "vault-test",
  "vault-rotate",
] as const satisfies readonly DohertyGesture[];

export const DOHERTY_IDLE: DohertyChrome = {
  gesture: null,
  phase: "idle",
};

export const DOHERTY_LABELS = {
  save: {
    pending: "Saving draft…",
    success: "Draft saved.",
    error: "Draft was not saved.",
  },
  publish: {
    pending: "Publishing…",
    success: "Published.",
    error: "Publish failed.",
  },
  "test-run": {
    pending: "Starting test run…",
    success: "Test run started.",
    error: "Test run did not start.",
  },
  start: {
    pending: "Starting published version…",
    success: "Published version started.",
    error: "Published version did not start.",
  },
  catalog: {
    pending: "Loading catalog…",
    success: "Catalog loaded.",
    error: ENGINE_CATALOG_UNAVAILABLE_HELP,
  },
  "vault-test": {
    pending: "Testing credential…",
    success: "Credential test finished.",
    error: "Credential test failed.",
  },
  "vault-rotate": {
    pending: "Rotating credential…",
    success: "Credential rotated.",
    error: "Credential was not rotated.",
  },
} as const satisfies Record<
  DohertyGesture,
  { pending: string; success: string; error: string }
>;

export const DOHERTY_INDETERMINATE_START =
  `Start accepted — run status is indeterminate. ${INDETERMINATE_STATUS_HELP}`;

export const DOHERTY_PENDING_CHROME = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritUxl1TopBarGroups: true,
  inheritUxl2WorkingMemory: true,
  d6MigrateInPlace: true,
  pendingImmediatelyThenSuccessOrError: true,
  perceivedChromeUnder400ms: true,
  canvasStaysInteractive: true,
  noWebsocket: true,
  existingRequestsOnly: true,
  failClosedWaitsStayVisible: true,
  missingSessionEmbedIsAlert: true,
  catalog403FailsClosed: true,
  emptyCatalogFailsClosed: true,
  invalidYamlNeverGuessesGraph: true,
  hostQueryDisplayOnly: true,
  noOptimisticWorkspaceSwitchFromQuery: true,
  noInventedIndeterminateSuccess: true,
  loudIndeterminate: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  oneReplayPath: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  noAppsApiChanges: true,
  uxl4ThroughUxl8OutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const DOHERTY_PENDING_CHROME_HELP =
  "Save draft, Publish, Test run, Start published, vault test/rotate, and catalog load show pending immediately, then success or error. Canvas stays interactive. Fail-closed waits stay visible: missing session.embed is an alert; catalog 403 / empty fail closed; invalid YAML does not guess a graph. Host ?tenant= / ?workbench= stay display-only. No invented progress that claims a run succeeded when status is indeterminate.";

export const DOHERTY_PENDING_CHROME_SOURCES = [
  "src/lib/doherty-pending-chrome.ts",
  "src/components/chrome/DohertyStatus.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
  "src/components/workflows/ActionLibrary.tsx",
  "src/components/workflows/RunControl.tsx",
  "src/components/workflows/ManualStartPanel.tsx",
  "src/components/workflows/LastRunIoPanel.tsx",
  "src/components/credentials/CredentialDetail.tsx",
  "src/components/embed/EmbedChrome.tsx",
] as const;

export const DOHERTY_REQUEST_PENDING_KEYS = [
  "save",
  "publish",
  "test-run",
  "run",
  "catalog",
  "test",
  "rotate",
] as const;

export const INVENTED_RUN_SUCCESS_COPY = [
  "Run succeeded",
  "Test run succeeded",
  "Execution succeeded",
  "succeeded while indeterminate",
] as const;

export const INVENTED_DOHERTY_SURFACES = [
  "DohertyProgressBar",
  "EventSource",
  "new WebSocket",
  "inventSse",
] as const;

export const DOHERTY_HOST_QUERY_SWITCH_TOKENS = [
  'searchParams.get("tenant")',
  "searchParams.get('tenant')",
  'searchParams.get("workbench")',
  "searchParams.get('workbench')",
  "switchWorkspace(host",
  "setCurrent(hostQuery",
  "optimisticWorkspaceSwitch",
] as const;

export function dohertyBegin(gesture: DohertyGesture): DohertyChrome {
  return { gesture, phase: "pending" };
}

export function dohertyFinish(
  gesture: DohertyGesture,
  ok: boolean,
  executionStatus?: string,
): DohertyChrome {
  if (
    ok &&
    (gesture === "start" || gesture === "test-run") &&
    isIndeterminateStatus(executionStatus)
  ) {
    return { gesture, phase: "indeterminate" };
  }
  return { gesture, phase: ok ? "success" : "error" };
}

export function dohertyFeedbackLabel(
  gesture: DohertyGesture,
  phase: DohertyPhase,
): string {
  if (phase === "idle") {
    return "";
  }
  if (phase === "indeterminate") {
    return DOHERTY_INDETERMINATE_START;
  }
  return DOHERTY_LABELS[gesture][phase];
}

export function dohertyChromeLabel(chrome: DohertyChrome): string {
  if (!chrome.gesture || chrome.phase === "idle") {
    return "";
  }
  return dohertyFeedbackLabel(chrome.gesture, chrome.phase);
}

export function dohertyStatusRole(
  phase: DohertyPhase,
): "status" | "alert" | undefined {
  if (phase === "idle") {
    return undefined;
  }
  return phase === "error" ? "alert" : "status";
}

export function dohertyStatusClassName(phase: DohertyPhase): string {
  switch (phase) {
    case "error":
      return "text-xs text-[var(--ff-danger)]";
    case "indeterminate":
      return "text-xs font-medium text-[var(--ff-danger)]";
    case "pending":
      return "text-xs text-[var(--ff-muted)]";
    case "success":
      return "text-xs text-[var(--ff-text)]";
    default:
      return "text-xs text-[var(--ff-muted)]";
  }
}

export function dohertyRequestBlocksCanvas(
  pending: string | null | undefined,
): boolean {
  if (!pending) {
    return false;
  }
  return !(DOHERTY_REQUEST_PENDING_KEYS as readonly string[]).includes(pending);
}

export function dohertyCanvasPendingIsValidationOnly(source: string): boolean {
  const start = source.indexOf("<WorkflowCanvas");
  if (start < 0) {
    return false;
  }
  const slice = source.slice(start, start + 900);
  return (
    slice.includes('pending={status === "pending"}') &&
    !slice.includes("pending={pending")
  );
}

export function dohertyLabelClaimsRunSucceeded(label: string): boolean {
  return /succeed/i.test(label);
}

export function dohertyInventedProgress(source: string): boolean {
  return INVENTED_DOHERTY_SURFACES.some((token) => source.includes(token));
}

export function dohertyOptimisticHostQuerySwitch(source: string): boolean {
  return DOHERTY_HOST_QUERY_SWITCH_TOKENS.some((token) => source.includes(token));
}

export function dohertyVisibleFailClosedWait(source: string): boolean {
  return (
    source.includes('role="alert"') &&
    (source.includes("EMBED_CHROME_MISSING_SESSION_MESSAGE") ||
      source.includes("missingEmbed") ||
      source.includes("session.embed"))
  );
}

export function dohertyHoldsHardLines(): boolean {
  return (
    DOHERTY_PENDING_CHROME.yamlIsSourceOfTruth &&
    DOHERTY_PENDING_CHROME.draftsNeverRun &&
    DOHERTY_PENDING_CHROME.vaultDisplayNameUuidOnly &&
    DOHERTY_PENDING_CHROME.adv021ChromeFromSessionEmbedOnly &&
    DOHERTY_PENDING_CHROME.adv024MembershipIsolationStayGrantGated &&
    DOHERTY_PENDING_CHROME.oneReplayPath &&
    DOHERTY_PENDING_CHROME.loudIndeterminate &&
    DOHERTY_PENDING_CHROME.failClosedCatalogs &&
    DOHERTY_PENDING_CHROME.notAnN8nClone &&
    DOHERTY_PENDING_CHROME.invalidYamlNeverGuessesGraph &&
    DOHERTY_PENDING_CHROME.hostQueryDisplayOnly &&
    DOHERTY_PENDING_CHROME.noInventedIndeterminateSuccess &&
    DOHERTY_PENDING_CHROME.canvasStaysInteractive &&
    DOHERTY_PENDING_CHROME.noAppsApiChanges &&
    EDITOR_CHROME.invalidYamlNeverGuessesGraph &&
    EDITOR_CHROME.draftsCannotStart &&
    EDITOR_LIBRARY.catalog403FailsClosed &&
    EDITOR_LIBRARY.emptyCatalogFailsClosed &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization
  );
}

export function dohertyInheritsPriorStories(): boolean {
  return (
    DOHERTY_PENDING_CHROME.inheritUxl1TopBarGroups &&
    DOHERTY_PENDING_CHROME.inheritUxl2WorkingMemory &&
    DOHERTY_PENDING_CHROME.inheritR7HardLine &&
    EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers &&
    EDITOR_WORKING_MEMORY.editingADraftInWords &&
    EDITOR_WORKING_MEMORY.testRunCopyNamesPublishThenStart &&
    CREDENTIAL_DETAIL_HELP.includes("display-name + UUID")
  );
}

export function dohertyShowsImmediatePending(source: string): boolean {
  return (
    source.includes("dohertyBegin") ||
    source.includes("setDoherty") ||
    source.includes("Saving…") ||
    source.includes("Publishing…") ||
    source.includes("Starting…") ||
    source.includes("Testing…") ||
    source.includes("Rotating…") ||
    source.includes("Loading…") ||
    source.includes("DOHERTY_LABELS") ||
    source.includes("dohertyFeedbackLabel")
  );
}
