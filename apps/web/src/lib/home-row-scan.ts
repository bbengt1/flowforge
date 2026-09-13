/**
 * UXL.5: Home row scan order.
 *
 * Relates to #292 / Part of #287. Keep #292 open.
 *
 * Chloe UI only. Densify `/workflows` list + cards in place (D6).
 * Inherit R6.2 home activation (D2 compose; drafts never look live;
 * query drawers still work and are not the activation lesson) and
 * UXL.2 wording. No folder/search/archive API. No invented activation
 * drawer or resource.
 *
 * Serial Position: scan ends are **activation** and **last run**.
 * Cognitive Load / Occam: do not grow a fourth “activation drawer.”
 * Last run surfaces waiting / indeterminate when those joins already
 * exist. Row actions keep Open editor, Test run, Start published.
 * Test run still mints a published test version (D5). No Developer
 * fixtures on the empty or populated home list.
 *
 * Out of scope: UXL.6–8, inventing activation drawers, API list
 * projection unless already present.
 */

import { isExecutionAwaitingApproval } from "./approval.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import { EDITOR_WORKING_MEMORY } from "./editor-working-memory.ts";
import { D5_HARD_LINE, EDITOR_TEST_RUN } from "./editor-test-run.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import {
  executionStatusPresentation,
  isIndeterminateStatus,
} from "./execution.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import {
  HOME_ACTIVATION,
  HOME_ACTIVATION_COLUMN_ID,
  WORKFLOW_HOME_LIST_COLUMNS,
} from "./home-activation.ts";
import {
  PEAK_END_OPERATE,
  peakEndKind,
  peakEndLabel,
  type PeakEndKind,
} from "./peak-end-operate-endings.ts";
import { workflowHomeRowActions } from "./product-home.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

export const UXL5_STORY = 292;
export const UXL5_EPIC = 287;
export const UXL5_KEEP_STORY_OPEN = true;
export const UXL5_ID = "UXL.5-home-row-scan" as const;

export const UXL5_BRIEF = "docs/architecture/flowforge-ux-laws.md";

export const HOME_ROW_SCAN_LEAD = HOME_ACTIVATION_COLUMN_ID;
export const HOME_ROW_SCAN_TRAIL = "lastRun" as const;

export const HOME_ROW_LAST_RUN_COLUMN_ID = HOME_ROW_SCAN_TRAIL;

export const HOME_ROW_SCAN_HELP =
  "Scan ends are activation and last run. Activation is the activation path — not a fourth drawer. Last run stays loud for waiting and indeterminate when those joins already exist. Home ?start= / ?webhooks= / ?schedules= drawers still work; they are not the activation lesson.";

export const HOME_ROW_SCAN_NEVER_LABEL = "Never run";
export const HOME_ROW_SCAN_UNKNOWN_LABEL = "—";

export const HOME_ROW_REQUIRED_ACTIONS = [
  "Open editor",
  "Test run",
  "Start published",
] as const;

export const HOME_ROW_DEVELOPER_FIXTURE_TOKENS = [
  "loadDeveloperYaml",
  "onLoadStarter",
  "onLoadInvalid",
  "STARTER_WORKFLOW_YAML",
  "INVALID_WORKFLOW_YAML",
  "EDITOR_YAML_DEVELOPER_DISCLOSURE",
] as const;

export const HOME_ROW_INVENTED_DRAWERS = [
  "?activation=",
  "activation=drawer",
  "ActivationDrawer",
  "fourthActivationDrawer",
] as const;

export const HOME_ROW_SCAN = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritR62HomeActivation: true,
  inheritUxl2Wording: true,
  inheritUxl4PeakEnd: true,
  d6MigrateInPlace: true,
  scanLeadIsActivation: true,
  scanTrailIsLastRun: true,
  waitingIndeterminateWhenAlreadyJoined: true,
  filtersDoNotGrowFourthActivationDrawer: true,
  homeQueryDrawersStillWork: true,
  queryDrawersAreNotActivationLesson: true,
  rowActionsKeepOpenEditorTestRunStartPublished: true,
  testRunMintsPublishedTestVersion: true,
  noDeveloperFixturesOnHomeEmptyOrPopulated: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  draftsNeverLookLive: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  oneReplayPath: true,
  loudIndeterminate: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  noNewActivationResource: true,
  noInventedActivationDrawer: true,
  noAppsApiChanges: true,
  noFolderSearchArchiveApi: true,
  noListProjectionUnlessPresent: true,
  uxl6ThroughUxl8OutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const HOME_ROW_SCAN_SOURCES = [
  "src/lib/home-row-scan.ts",
  "src/lib/home-activation.ts",
  "src/lib/workflow-home.ts",
  "src/components/home/HomeActivationStatus.tsx",
  "src/components/home/HomeLastRunStatus.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export type HomeRowScanColumnId =
  (typeof WORKFLOW_HOME_LIST_COLUMNS)[number]["id"];

export type HomeLastRunKind = PeakEndKind | "never" | "unknown";

export type HomeLastRunPresentation = {
  kind: HomeLastRunKind;
  label: string;
  icon: string;
  help: string;
  loud: boolean;
};

export function homeRowScanColumnIds(): readonly HomeRowScanColumnId[] {
  return WORKFLOW_HOME_LIST_COLUMNS.map((column) => column.id);
}

export function homeRowScanEnds(): {
  lead: HomeRowScanColumnId | undefined;
  trail: HomeRowScanColumnId | undefined;
} {
  const ids = homeRowScanColumnIds();
  return {
    lead: ids[0],
    trail: ids[ids.length - 1],
  };
}

export function homeRowScanEndsPrioritizeActivationAndLastRun(): boolean {
  const ends = homeRowScanEnds();
  return (
    ends.lead === HOME_ROW_SCAN_LEAD &&
    ends.trail === HOME_ROW_SCAN_TRAIL &&
    HOME_ROW_SCAN.scanLeadIsActivation &&
    HOME_ROW_SCAN.scanTrailIsLastRun
  );
}

export function homeLastRunIsWaiting(
  last: Pick<ExecutionRecord, "id" | "status"> | null | undefined,
  approvals: readonly ApprovalRequest[] = [],
): boolean {
  if (!last) {
    return false;
  }
  if (isExecutionAwaitingApproval(last.status)) {
    return true;
  }
  return approvals.some(
    (item) => item.executionId === last.id && item.status === "pending",
  );
}

export function homeLastRunIsIndeterminate(
  status: string | null | undefined,
): boolean {
  return isIndeterminateStatus(status ?? undefined);
}

export function homeLastRunPresentation(input: {
  status: string | null;
  known: boolean;
  waiting?: boolean;
  indeterminate?: boolean;
}): HomeLastRunPresentation {
  if (!input.known) {
    return {
      kind: "unknown",
      label: HOME_ROW_SCAN_UNKNOWN_LABEL,
      icon: "•",
      help: "Last run was not joined.",
      loud: false,
    };
  }
  if (!input.status) {
    return {
      kind: "never",
      label: HOME_ROW_SCAN_NEVER_LABEL,
      icon: "○",
      help: "No execution has started for this workflow.",
      loud: false,
    };
  }
  const waiting = input.waiting === true;
  const kind = peakEndKind(
    input.indeterminate ? "indeterminate" : input.status,
    waiting,
  );
  const status = executionStatusPresentation(
    kind === "waiting" ? "waiting" : input.status,
  );
  const loud = kind === "indeterminate" || kind === "waiting";
  const label = loud ? peakEndLabel(kind, "inbox") : status.label;
  const help =
    kind === "indeterminate"
      ? INDETERMINATE_STATUS_HELP
      : kind === "waiting"
        ? peakEndLabel(kind, "inbox")
        : status.description;
  return {
    kind,
    label,
    icon: status.icon,
    help,
    loud,
  };
}

export function homeRowKeepsRequiredActions(source: string): boolean {
  return HOME_ROW_REQUIRED_ACTIONS.every((label) => source.includes(label));
}

export function homeRowTeachesActivationDrawer(source: string): boolean {
  return HOME_ROW_INVENTED_DRAWERS.some((token) => source.includes(token));
}

export function homeRowShowsDeveloperFixtures(source: string): boolean {
  return HOME_ROW_DEVELOPER_FIXTURE_TOKENS.some((token) => source.includes(token));
}

export function homeRowQueryDrawersStillWork(source: string): boolean {
  return (
    source.includes("MANUAL_START_QUERY") &&
    source.includes("WEBHOOK_TRIGGER_QUERY") &&
    source.includes("SCHEDULE_TRIGGER_QUERY") &&
    source.includes("setStartWorkflowId") &&
    source.includes("setWebhookWorkflowId") &&
    source.includes("setScheduleWorkflowId")
  );
}

export function homeRowTestRunMintsPublishedVersion(): boolean {
  return (
    HOME_ROW_SCAN.testRunMintsPublishedTestVersion &&
    EDITOR_TEST_RUN.inheritD5HardLine &&
    D5_HARD_LINE.neverRunUnsavedDraftBuffer &&
    D5_HARD_LINE.oneGestureMintsPublishedTestVersionThenStarts &&
    EDITOR_WORKING_MEMORY.testRunCopyNamesPublishThenStart
  );
}

export function homeRowHoldsHardLines(): boolean {
  return (
    HOME_ROW_SCAN.yamlIsSourceOfTruth &&
    HOME_ROW_SCAN.draftsNeverRun &&
    HOME_ROW_SCAN.draftsNeverLookLive &&
    HOME_ROW_SCAN.vaultDisplayNameUuidOnly &&
    HOME_ROW_SCAN.adv021ChromeFromSessionEmbedOnly &&
    HOME_ROW_SCAN.adv024MembershipIsolationStayGrantGated &&
    HOME_ROW_SCAN.oneReplayPath &&
    HOME_ROW_SCAN.loudIndeterminate &&
    HOME_ROW_SCAN.failClosedCatalogs &&
    HOME_ROW_SCAN.notAnN8nClone &&
    HOME_ROW_SCAN.noNewActivationResource &&
    HOME_ROW_SCAN.noInventedActivationDrawer &&
    HOME_ROW_SCAN.noAppsApiChanges &&
    HOME_ACTIVATION.draftsNeverLookLive &&
    HOME_ACTIVATION.doNotTeachThreeDrawers &&
    HOME_ACTIVATION.homeDrawersStillWork &&
    EDITOR_CHROME.draftsCannotStart &&
    PEAK_END_OPERATE.loudIndeterminateOnOverlayAndInbox &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1
  );
}

export function homeRowInheritsPriorStories(): boolean {
  return (
    HOME_ROW_SCAN.inheritR62HomeActivation &&
    HOME_ROW_SCAN.inheritUxl2Wording &&
    HOME_ROW_SCAN.inheritUxl4PeakEnd &&
    HOME_ACTIVATION.inheritR6Confirmation &&
    HOME_ACTIVATION.composeEnablePlusVersionPin &&
    HOME_ACTIVATION.densifyHomeListInPlace &&
    EDITOR_WORKING_MEMORY.homeColumnMatchesEditor &&
    EDITOR_WORKING_MEMORY.inheritR62HomeColumn &&
    PEAK_END_OPERATE.waitingDecideOnOverlayAndInbox &&
    workflowHomeRowActions({
      published: true,
      workflowId: "11111111-1111-4111-8111-111111111111",
      capabilities: {
        canExecute: true,
        canPublish: true,
        canViewWebhooks: true,
        canViewSchedules: true,
        canSeeLastRun: true,
      },
    }).testRun === true
  );
}
