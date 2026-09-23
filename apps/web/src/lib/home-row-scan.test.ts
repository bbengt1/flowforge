import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { D5_HARD_LINE } from "./editor-test-run.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import {
  HOME_ACTIVATION,
  HOME_ACTIVATION_COLUMN_ID,
  WORKFLOW_HOME_LIST_COLUMNS,
  homeActivationColumnIsFirstClass,
} from "./home-activation.ts";
import {
  HOME_ROW_REQUIRED_ACTIONS,
  HOME_ROW_SCAN,
  HOME_ROW_SCAN_HELP,
  HOME_ROW_SCAN_LEAD,
  HOME_ROW_SCAN_SOURCES,
  HOME_ROW_SCAN_TRAIL,
  UXL5_BRIEF,
  UXL5_EPIC,
  UXL5_ID,
  UXL5_KEEP_STORY_OPEN,
  UXL5_STORY,
  homeLastRunIsIndeterminate,
  homeLastRunIsWaiting,
  homeLastRunPresentation,
  homeRowHoldsHardLines,
  homeRowInheritsPriorStories,
  homeRowKeepsRequiredActions,
  homeRowQueryDrawersStillWork,
  homeRowScanColumnIds,
  homeRowScanEnds,
  homeRowScanEndsPrioritizeActivationAndLastRun,
  homeRowShowsDeveloperFixtures,
  homeRowTeachesActivationDrawer,
  homeRowTestRunMintsPublishedVersion,
} from "./home-row-scan.ts";
import { EMPTY_WORKFLOW_HOME_FILTERS, buildWorkflowHomeItems, filterWorkflowHomeItems } from "./workflow-home.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import type { WorkflowRecord } from "./workflow-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "44444444-4444-4444-8444-444444444444";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: WORKFLOW_ID,
    slug: "ops-deploy",
    name: "Deploy app",
    status: "published",
    draftRevision: 3,
    draftDigest: "sha256:aaaa",
    latestVersionNumber: 2,
    latestVersionId: "22222222-2222-4222-8222-222222222222",
    createdBy: "chloe",
    updatedBy: "chloe",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "Deploy app",
    workflowSlug: "ops-deploy",
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionNumber: 2,
    workflowDigest: "sha256:aaaa",
    status: "succeeded",
    startedAt: "2026-09-08T00:00:00Z",
    finishedAt: "2026-09-08T00:01:00Z",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:01:00Z",
    retentionUntil: "",
    correlationId: "corr-1",
    idempotencyKey: "",
    replayed: false,
    requestedBy: "chloe",
    triggerId: "",
    input: {},
    policySnapshot: null,
    permittedActions: [],
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    status: "pending",
    workflowId: WORKFLOW_ID,
    workflowName: "Deploy app",
    requestedBy: "jonny",
    requestedAt: "2026-09-08T00:00:00Z",
    decidedBy: "",
    decidedAt: "",
    note: "",
    executionId: EXECUTION_ID,
    executionStatus: "waiting",
    approverRole: "approver",
    permittedActions: [],
    binding: {
      workflowVersionId: "22222222-2222-4222-8222-222222222222",
      workflowVersionDigest: "sha256:aaaa",
      targetId: "",
      targetKind: "",
      targetName: "",
      targetVersionId: "",
      targetDigest: "",
      policyResourceId: "",
      policyRevisionId: "",
      policyRevisionNumber: null,
      policyDigest: "",
      operation: "workflow.execute",
      nodeId: "",
      nodeName: "",
      expiresAt: "2099-01-01T00:00:00Z",
      bindingFingerprint: "fp",
    },
    validity: {
      current: true,
      reason: "pending",
      changedFields: [],
      currentBinding: null,
    },
    ...overrides,
  } as ApprovalRequest;
}

describe("UXL.5 home row scan order", () => {
  it("keeps #292 open and cites epic #287", () => {
    assert.equal(UXL5_STORY, 292);
    assert.equal(UXL5_EPIC, 287);
    assert.equal(UXL5_KEEP_STORY_OPEN, true);
    assert.equal(UXL5_ID, "UXL.5-home-row-scan");
    assert.equal(UXL5_BRIEF, "docs/internal/flowforge-ux-laws.md");
    assert.match(HOME_ROW_SCAN_HELP, /activation/);
    assert.match(HOME_ROW_SCAN_HELP, /last run/);
    assert.match(HOME_ROW_SCAN_HELP, /not a fourth drawer/);
    assert.equal(HOME_ROW_SCAN.uxl6ThroughUxl8OutOfScope, true);
    assert.equal(HOME_ROW_SCAN.jonnyNoneExpected, true);
    assert.equal(HOME_ROW_SCAN.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /scan ends/i);
  });

  it("puts activation and last run at the home scan ends", () => {
    assert.equal(HOME_ROW_SCAN_LEAD, HOME_ACTIVATION_COLUMN_ID);
    assert.equal(HOME_ROW_SCAN_TRAIL, "lastRun");
    assert.deepEqual([...homeRowScanColumnIds()], [
      "activation",
      "workflow",
      "status",
      "actions",
      "lastRun",
    ]);
    assert.deepEqual(homeRowScanEnds(), {
      lead: "activation",
      trail: "lastRun",
    });
    assert.equal(homeRowScanEndsPrioritizeActivationAndLastRun(), true);
    assert.equal(homeActivationColumnIsFirstClass(), true);
    assert.equal(WORKFLOW_HOME_LIST_COLUMNS[0]?.id, "activation");
    assert.equal(
      WORKFLOW_HOME_LIST_COLUMNS[WORKFLOW_HOME_LIST_COLUMNS.length - 1]?.id,
      "lastRun",
    );
  });

  it("surfaces waiting and indeterminate on last run from already-joined lists", () => {
    const uncertain = homeLastRunPresentation({
      status: "indeterminate",
      known: true,
      indeterminate: true,
    });
    assert.equal(uncertain.kind, "indeterminate");
    assert.equal(uncertain.loud, true);
    assert.match(uncertain.label, /indeterminate/i);
    assert.match(uncertain.help, new RegExp(INDETERMINATE_STATUS_HELP));
    assert.equal(homeLastRunIsIndeterminate("indeterminate"), true);

    const waiting = homeLastRunPresentation({
      status: "waiting",
      known: true,
      waiting: true,
    });
    assert.equal(waiting.kind, "waiting");
    assert.equal(waiting.loud, true);
    assert.match(waiting.label, /decide/i);

    const joinedWaiting = homeLastRunIsWaiting(execution({ status: "succeeded" }), [
      approval(),
    ]);
    assert.equal(joinedWaiting, true);
    assert.equal(homeLastRunIsWaiting(execution({ status: "succeeded" })), false);

    const [item] = buildWorkflowHomeItems([record()], {
      executions: [execution({ status: "indeterminate" })],
      approvals: [approval({ executionId: EXECUTION_ID })],
      lastRunKnownIds: new Set([WORKFLOW_ID]),
    });
    assert.equal(item?.lastRunIndeterminate, true);
    assert.equal(item?.lastRunWaiting, true);
    assert.equal(item?.lastRunStatus, "indeterminate");

    const waitingOnly = filterWorkflowHomeItems(
      [item!],
      { ...EMPTY_WORKFLOW_HOME_FILTERS, lastRun: "waiting" },
    );
    assert.equal(waitingOnly.length, 1);
    const uncertainOnly = filterWorkflowHomeItems(
      [item!],
      { ...EMPTY_WORKFLOW_HOME_FILTERS, lastRun: "indeterminate" },
    );
    assert.equal(uncertainOnly.length, 1);
  });

  it("densifies list + cards in place without a fourth activation drawer", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const listStatus = source("src/components/home/HomeActivationStatus.tsx");
    const lastRun = source("src/components/home/HomeLastRunStatus.tsx");
    const page = source("src/app/workflows/page.tsx");

    assert.match(home, /HomeActivationStatus/);
    assert.match(home, /HomeLastRunStatus/);
    assert.match(home, /WORKFLOW_HOME_LIST_COLUMNS/);
    assert.match(home, /data-home-row-scan/);
    assert.match(home, /HOME_ROW_SCAN_HELP/);
    assert.match(lastRun, /data-home-row-scan="trail"/);
    assert.match(listStatus, /data-home-activation="status"/);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.match(HOME_ROW_SCAN_HELP, /scan ends/i);
    assert.doesNotMatch(page, /scan ends/i);
    assert.equal(homeRowTeachesActivationDrawer(home), false);
    assert.equal(homeRowTeachesActivationDrawer(listStatus), false);
    assert.equal(HOME_ROW_SCAN.filtersDoNotGrowFourthActivationDrawer, true);
    assert.equal(HOME_ACTIVATION.doNotTeachThreeDrawers, true);
    assert.equal(home.includes("?activation="), false);
  });

  it("keeps query drawers, required row actions, D5 test-run, and no Developer fixtures", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(homeRowQueryDrawersStillWork(home), true);
    assert.equal(homeRowKeepsRequiredActions(home), true);
    assert.deepEqual([...HOME_ROW_REQUIRED_ACTIONS], [
      "Open editor",
      "Test run",
      "Start published",
    ]);
    assert.equal(homeRowTestRunMintsPublishedVersion(), true);
    assert.equal(D5_HARD_LINE.neverRunUnsavedDraftBuffer, true);
    assert.match(home, /runPublishedTestVersion/);
    assert.match(home, /testRunVersionHints/);
    assert.equal(homeRowShowsDeveloperFixtures(home), false);
    assert.equal(home.includes("loadDeveloperYaml"), false);
    assert.equal(HOME_ROW_SCAN.homeQueryDrawersStillWork, true);
    assert.equal(HOME_ROW_SCAN.queryDrawersAreNotActivationLesson, true);
    assert.equal(HOME_ROW_SCAN.noDeveloperFixturesOnHomeEmptyOrPopulated, true);
  });

  it("holds hard lines and inherits R6.2 + UXL.2 wording", () => {
    assert.equal(homeRowHoldsHardLines(), true);
    assert.equal(homeRowInheritsPriorStories(), true);
    assert.equal(HOME_ROW_SCAN.inheritR62HomeActivation, true);
    assert.equal(HOME_ROW_SCAN.inheritUxl2Wording, true);
    assert.equal(HOME_ACTIVATION.draftsNeverLookLive, true);
    assert.equal(HOME_ACTIVATION.homeDrawersStillWork, true);
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /EDITOR_WORKING_MEMORY_TEST_RUN/);
    assert.match(home, /HomeActivationStatus/);
    for (const path of HOME_ROW_SCAN_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
