import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_RUNS,
  EDITOR_RUNS_COLUMN_WIDTH,
  EDITOR_RUNS_COMPARE_SOURCE,
  EDITOR_RUNS_DEFAULT_OPEN,
  EDITOR_RUNS_DETAIL_PATH,
  EDITOR_RUNS_LIST_LIMIT,
  EDITOR_RUNS_OPEN_ON_FIRST_PAINT,
  EDITOR_RUNS_OPEN_STORAGE_KEY,
  EDITOR_RUNS_OPERATE_HELP,
  EDITOR_RUNS_PANEL_ID,
  EDITOR_RUNS_REPLAY_GRAPH_SOURCE,
  EDITOR_RUNS_SATELLITE_ID,
  EDITOR_RUNS_SATELLITE_LABEL,
  EDITOR_RUNS_SATELLITE_WIDTH,
  EDITOR_RUNS_SKIP_FAILED_LABEL,
  EDITOR_RUNS_SKIP_INDETERMINATE_LABEL,
  EDITOR_RUNS_SKIP_STATUSES,
  EDITOR_RUNS_SOURCES,
  EDITOR_RUN_OVERLAY_KEYBOARD_HELP,
  EDITOR_WORKSPACE_EXECUTIONS_HREF,
  INVENTED_REPLAY_ROUTE,
  R42_EPIC,
  R42_KEEP_STORY_OPEN,
  R42_STORY,
  UX6_EPIC,
  UX6_KEEP_STORY_OPEN,
  UX6_STORY,
  editorRunOpenHref,
  editorRunSkipNodeId,
  editorRunsCanList,
  editorRunsColumnIds,
  editorRunsCompareStaysClientSideAndHidden,
  editorRunsDisplay,
  editorRunsDoesNotBuryCanvas,
  editorRunsDoesNotInventReplayRoute,
  editorRunsDraftsNeverRun,
  editorRunsEmbedRoutesUnchanged,
  editorRunsFindSkipTarget,
  editorRunsHasSingleOperatePath,
  editorRunsHighlightSummary,
  editorRunsHighlightedNodeIds,
  editorRunsIndeterminateIsIconAndText,
  editorRunsInheritsR4Guardrails,
  editorRunsKeyAction,
  editorRunsKeyboardHelp,
  editorRunsListIsWorkflowScoped,
  editorRunsListPath,
  editorRunsSkipStatuses,
  editorRunsSkipTarget,
  editorRunsStatuses,
  editorRunsUsesExistingListParams,
  editorRunsWorkspaceHref,
  parseRunsOpenPreference,
  readRunsOpenPreference,
  rememberRunsOpen,
  rememberedRunsOpen,
  runsChromeMode,
  runsSatelliteLabel,
  workspaceExecutionsRemainsOpsView,
} from "./editor-runs.ts";
import { R4_GUARDRAILS, R4_LATER_STORY_NOTES } from "./execution-inbox.ts";
import { historyKeyAction } from "./execution-replay.ts";
import type { ExecutionRecord, ExecutionStep } from "./execution-types.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const FAILED_ID = "44444444-4444-4444-8444-444444444444";
const INDETERMINATE_ID = "55555555-5555-4555-8555-555555555555";

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function mockSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
      removeItem(key: string) {
        store.delete(key);
      },
    },
  });
  return store;
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "Deploy API",
    workflowSlug: "deploy-api",
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionNumber: 2,
    workflowDigest: "sha256:abcdef0123456789",
    status: "succeeded",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:02:00.000Z",
    createdAt: "2026-09-09T01:00:00.000Z",
    updatedAt: "2026-09-09T01:02:00.000Z",
    retentionUntil: "2026-12-08T01:00:00.000Z",
    correlationId: "corr-16-characters",
    idempotencyKey: "deploy-prod-1",
    replayed: false,
    requestedBy: "operator-chloe",
    triggerId: "",
    input: {},
    policySnapshot: null,
    permittedActions: [],
    ...overrides,
  };
}

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    executionId: EXECUTION_ID,
    nodeId: "apply",
    nodeType: "kubernetes.apply",
    attempt: 1,
    status: "succeeded",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:01:00.000Z",
    createdAt: "2026-09-09T01:00:00.000Z",
    input: { dryRun: false },
    output: { applied: true },
    error: null,
    fencingToken: 1,
    workerId: "worker-1",
    leaseId: "lease-1",
    ...overrides,
  };
}

describe("UX.6 editor runs drawer", () => {
  it("keeps #201 open and cites epic #195", () => {
    assert.equal(UX6_STORY, 201);
    assert.equal(UX6_EPIC, 195);
    assert.equal(UX6_KEEP_STORY_OPEN, true);
  });

  it("scopes GET to the open workflow on existing status/limit params", () => {
    assert.equal(EDITOR_RUNS.scopedToOpenWorkflow, true);
    assert.equal(EDITOR_RUNS.usesWorkflowExecutionsCollection, true);
    assert.equal(EDITOR_RUNS_PANEL_ID, "editor-runs-drawer");
    assert.equal(
      editorRunsListPath(WORKFLOW_ID, { status: "indeterminate", limit: 25 }),
      `/workflows/${WORKFLOW_ID}/executions?status=indeterminate&limit=25`,
    );
    assert.equal(editorRunsListIsWorkflowScoped(WORKFLOW_ID), true);
    assert.equal(EDITOR_RUNS_LIST_LIMIT, 50);
    assert.equal(
      editorRunsUsesExistingListParams(WORKFLOW_ID, {
        status: "failed",
        limit: 50,
      }),
      true,
    );
  });

  it("reuses the /executions listbox keys and overlays the same canvas", () => {
    assert.equal(EDITOR_RUNS.keyboardMatchesHistory, true);
    assert.equal(editorRunsKeyboardHelp(), EDITOR_RUN_OVERLAY_KEYBOARD_HELP);
    assert.deepEqual(editorRunsKeyAction("ArrowDown", 0, 3), historyKeyAction("ArrowDown", 0, 3));
    assert.deepEqual(editorRunsKeyAction("Enter", 1, 3), { index: 1, activate: true });
    assert.deepEqual(editorRunsKeyAction(" ", 1, 3), { index: 1, activate: true });
    assert.equal(
      editorRunOpenHref(EXECUTION_ID, WORKFLOW_ID),
      `/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(
      editorRunOpenHref(EXECUTION_ID, WORKFLOW_ID, true),
      `/embed/v1/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(EDITOR_RUNS.openGoesToExistingReplayRoute, false);
    assert.equal(EDITOR_RUNS.openOverlaysSameCanvas, true);
    assert.equal(EDITOR_RUNS.opsDeepLinkRemainsAvailable, true);
    assert.equal(EDITOR_RUNS.noSecondReplayCanvas, true);
    assert.equal(
      EDITOR_RUNS_SOURCES.includes(EDITOR_RUNS_REPLAY_GRAPH_SOURCE),
      false,
    );
  });

  it("keeps indeterminate as icon+text and leaves workspace /executions as the ops view", () => {
    assert.equal(editorRunsIndeterminateIsIconAndText(), true);
    assert.equal(EDITOR_RUNS.indeterminateIconAndText, true);
    const rows = editorRunsDisplay([record({ status: "indeterminate" })], true);
    assert.equal(rows[0]?.indeterminate, true);
    assert.equal(rows[0]?.status, "indeterminate");
    assert.equal(rows[0]?.startedLabel, "2026-09-09 01:00:00Z");
    assert.equal(rows[0]?.durationLabel, "2m");
    assert.equal(
      rows[0]?.href,
      `/embed/v1/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(workspaceExecutionsRemainsOpsView(), true);
    assert.equal(editorRunsWorkspaceHref(), EDITOR_WORKSPACE_EXECUTIONS_HREF);
    assert.equal(editorRunsWorkspaceHref(true), "/embed/v1/executions");
    assert.equal(
      WORKSPACE_NAV_ITEMS.find((item) => item.id === "executions")?.href,
      "/executions",
    );
    assert.equal(EDITOR_RUNS.startPublishedUsesExistingRunControl, true);
    assert.equal(EDITOR_RUNS.noDraftExecute, true);
    assert.equal(EDITOR_RUNS.noRedactedRunIoInInspector, false);
  });

  it("fails closed without execution.view and does not add embed routes", () => {
    assert.equal(editorRunsCanList(null), false);
    assert.equal(editorRunsCanList([]), false);
    assert.equal(editorRunsCanList(["workflow.view"]), false);
    assert.equal(editorRunsCanList(["execution.view"]), true);
    assert.ok(editorRunsStatuses().includes("indeterminate"));
    assert.equal(editorRunsEmbedRoutesUnchanged(), true);
    assert.equal(EDITOR_RUNS.noNewEmbedRoutes, true);
  });
});

describe("R4.2 editor runs overlay operate density", () => {
  it("keeps #255 open and cites epic #230", () => {
    assert.equal(R42_STORY, 255);
    assert.equal(R42_EPIC, 230);
    assert.equal(R42_KEEP_STORY_OPEN, true);
    assert.equal(editorRunsInheritsR4Guardrails(), true);
    assert.equal(R4_GUARDRAILS.overlayStaysEditorOnly, true);
    assert.match(R4_LATER_STORY_NOTES.r42, /#255/);
    assert.match(EDITOR_RUNS_OPERATE_HELP, /without leaving the graph/);
    assert.match(EDITOR_RUNS_OPERATE_HELP, /\/executions\/\{id\}/);
    assert.match(EDITOR_RUN_OVERLAY_KEYBOARD_HELP, /highlights matching steps/);
  });

  it("defaults closed as a satellite and never hide-by-default only", () => {
    assert.equal(EDITOR_RUNS_OPEN_ON_FIRST_PAINT, false);
    assert.equal(EDITOR_RUNS_DEFAULT_OPEN, false);
    assert.equal(EDITOR_RUNS.hiddenOnFirstPaint, false);
    assert.equal(EDITOR_RUNS.rememberedOpen, true);
    assert.equal(EDITOR_RUNS.persistentSatellite, true);
    assert.equal(EDITOR_RUNS.defaultOpen, false);
    assert.equal(EDITOR_RUNS.doesNotBuryCanvas, true);
    assert.equal(EDITOR_RUNS_COLUMN_WIDTH, "20rem");
    assert.equal(EDITOR_RUNS_SATELLITE_WIDTH, "2.75rem");
    assert.equal(EDITOR_RUNS_SATELLITE_ID, "editor-runs-satellite");
    assert.equal(runsChromeMode(true), "drawer");
    assert.equal(runsChromeMode(false), "satellite");
    assert.equal(runsSatelliteLabel(), "Runs");
    assert.equal(EDITOR_RUNS_SATELLITE_LABEL, "Runs");
    assert.equal(editorRunsDoesNotBuryCanvas(), true);
  });

  it("remembers open/closed as a non-secret 1/0 flag", () => {
    const store = mockSessionStorage();
    assert.equal(parseRunsOpenPreference(undefined), null);
    assert.equal(parseRunsOpenPreference("yes"), null);
    assert.equal(parseRunsOpenPreference("1"), true);
    assert.equal(parseRunsOpenPreference("0"), false);
    assert.equal(rememberedRunsOpen(null), false);
    assert.equal(rememberedRunsOpen(true), true);
    assert.equal(readRunsOpenPreference(), false);

    rememberRunsOpen(true);
    assert.equal(store.get(EDITOR_RUNS_OPEN_STORAGE_KEY), "1");
    assert.equal(readRunsOpenPreference(), true);

    rememberRunsOpen(false);
    assert.equal(store.get(EDITOR_RUNS_OPEN_STORAGE_KEY), "0");
    assert.equal(readRunsOpenPreference(), false);
    assert.equal(EDITOR_RUNS.preferenceStoresOpenFlagOnly, true);
    assert.equal(store.get(EDITOR_RUNS_OPEN_STORAGE_KEY)?.includes("secret"), false);
  });

  it("exposes overlay operate columns and skip-to-attention helpers", () => {
    assert.deepEqual(editorRunsColumnIds(), [
      "status",
      "version",
      "started",
      "duration",
      "open",
    ]);
    assert.deepEqual([...EDITOR_RUNS_SKIP_STATUSES], ["failed", "indeterminate"]);
    assert.deepEqual([...editorRunsSkipStatuses()], ["failed", "indeterminate"]);
    assert.equal(EDITOR_RUNS_SKIP_FAILED_LABEL, "Skip to failed");
    assert.equal(EDITOR_RUNS_SKIP_INDETERMINATE_LABEL, "Skip to indeterminate");

    const rows = editorRunsDisplay([
      record(),
      record({ id: FAILED_ID, status: "failed" }),
      record({ id: INDETERMINATE_ID, status: "indeterminate" }),
    ]);
    assert.equal(editorRunsFindSkipTarget(rows, "failed")?.id, FAILED_ID);
    assert.equal(
      editorRunsFindSkipTarget(rows, "failed", FAILED_ID)?.id,
      FAILED_ID,
    );
    assert.equal(
      editorRunsFindSkipTarget(rows, "indeterminate")?.id,
      INDETERMINATE_ID,
    );
    assert.equal(
      editorRunSkipNodeId(
        [
          step({ nodeId: "plan", status: "succeeded" }),
          step({ nodeId: "apply", status: "failed" }),
        ],
        "failed",
      ),
      "apply",
    );
    assert.equal(
      editorRunSkipNodeId(
        [step({ nodeId: "apply", status: "indeterminate" })],
        "indeterminate",
      ),
      "apply",
    );
    assert.deepEqual(
      editorRunsSkipTarget({
        status: "failed",
        selectedSteps: [step({ nodeId: "apply", status: "failed" })],
        rows,
      }),
      { kind: "node", nodeId: "apply" },
    );
    assert.deepEqual(
      editorRunsSkipTarget({
        status: "failed",
        selectedSteps: [step({ status: "succeeded" })],
        rows,
      }),
      { kind: "run", executionId: FAILED_ID },
    );
    assert.deepEqual(
      editorRunsHighlightedNodeIds(
        [step({ nodeId: "plan" }), step({ nodeId: "apply", status: "failed" })],
        ["approve"],
      ),
      ["plan", "apply", "approve"],
    );
    assert.equal(
      editorRunsHighlightSummary(2),
      "Highlighting 2 related steps on this canvas.",
    );
    assert.match(editorRunsHighlightSummary(0), /No matching steps/);
    assert.equal(EDITOR_RUNS.operateDensity, true);
    assert.equal(EDITOR_RUNS.statusFilters, true);
    assert.equal(EDITOR_RUNS.skipToFailed, true);
    assert.equal(EDITOR_RUNS.skipToIndeterminate, true);
    assert.equal(EDITOR_RUNS.sameCanvasHighlight, true);
  });

  it("keeps one operate path and does not mount a second replay graph", () => {
    assert.equal(editorRunsHasSingleOperatePath(), true);
    assert.equal(EDITOR_RUNS_DETAIL_PATH, "/executions/{id}");
    assert.equal(editorRunsDoesNotInventReplayRoute(), true);
    assert.equal(editorRunsDraftsNeverRun(), true);
    assert.equal(editorRunsCompareStaysClientSideAndHidden(), true);
    assert.equal(INVENTED_REPLAY_ROUTE, "/replay");
    assert.equal(EDITOR_RUNS.noExecutionReplayMount, true);
    assert.equal(EDITOR_RUNS.noReplayRoute, true);
    assert.equal(EDITOR_RUNS.compareNotShownInOverlay, true);
    assert.equal(EDITOR_RUNS.noSse, true);
    assert.equal(EDITOR_RUNS_SOURCES.includes(EDITOR_RUNS_COMPARE_SOURCE), false);
  });

  it("wires the same editor routes to remembered-open plus a satellite", () => {
    const drawer = source("components/workflows/EditorRunsDrawer.tsx");
    const operator = source("components/workflows/WorkflowOperator.tsx");
    const listbox = source("components/executions/ExecutionHistoryListbox.tsx");
    assert.match(drawer, /data-editor-runs="satellite"/);
    assert.match(drawer, /data-editor-runs="drawer"/);
    assert.match(drawer, /EDITOR_RUNS_SATELLITE_WIDTH/);
    assert.match(drawer, /EDITOR_RUNS_SATELLITE_ID/);
    assert.match(drawer, /EDITOR_RUNS_SKIP_FAILED_LABEL/);
    assert.match(drawer, /EDITOR_RUNS_SKIP_INDETERMINATE_LABEL/);
    assert.match(drawer, /layout="overlay"/);
    assert.doesNotMatch(drawer, /ExecutionReplay/);
    assert.doesNotMatch(drawer, /ExecutionCompare/);
    assert.doesNotMatch(drawer, /EventSource|text\/event-stream/);
    assert.match(operator, /readRunsOpenPreference/);
    assert.match(operator, /rememberRunsOpen/);
    assert.match(operator, /subscribeRunsOpenPreference/);
    assert.doesNotMatch(operator, /setRunsOpen/);
    assert.match(operator, /onHighlightNode/);
    assert.match(operator, /editorRunsHighlightedNodeIds/);
    assert.match(listbox, /layout === "overlay"/);
    assert.match(listbox, /Workflow runs/);
  });
});
