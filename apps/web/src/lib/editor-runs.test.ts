import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDITOR_RUNS,
  EDITOR_RUNS_COLUMN_WIDTH,
  EDITOR_RUNS_LIST_LIMIT,
  EDITOR_RUNS_OPEN_ON_FIRST_PAINT,
  EDITOR_RUNS_PANEL_ID,
  EDITOR_RUNS_SOURCES,
  EDITOR_RUN_OVERLAY_KEYBOARD_HELP,
  EDITOR_WORKSPACE_EXECUTIONS_HREF,
  UX6_EPIC,
  UX6_KEEP_STORY_OPEN,
  UX6_STORY,
  editorRunOpenHref,
  editorRunsCanList,
  editorRunsDisplay,
  editorRunsEmbedRoutesUnchanged,
  editorRunsIndeterminateIsIconAndText,
  editorRunsKeyAction,
  editorRunsKeyboardHelp,
  editorRunsListIsWorkflowScoped,
  editorRunsListPath,
  editorRunsStatuses,
  editorRunsWorkspaceHref,
  workspaceExecutionsRemainsOpsView,
} from "./editor-runs.ts";
import { historyKeyAction } from "./execution-replay.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";

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

describe("UX.6 editor runs drawer", () => {
  it("keeps #201 open and cites epic #195", () => {
    assert.equal(UX6_STORY, 201);
    assert.equal(UX6_EPIC, 195);
    assert.equal(UX6_KEEP_STORY_OPEN, true);
  });

  it("hides the drawer on first paint and scopes GET to the open workflow", () => {
    assert.equal(EDITOR_RUNS_OPEN_ON_FIRST_PAINT, false);
    assert.equal(EDITOR_RUNS.hiddenOnFirstPaint, true);
    assert.equal(EDITOR_RUNS.scopedToOpenWorkflow, true);
    assert.equal(EDITOR_RUNS.usesWorkflowExecutionsCollection, true);
    assert.equal(EDITOR_RUNS_COLUMN_WIDTH, "22rem");
    assert.equal(EDITOR_RUNS_PANEL_ID, "editor-runs-drawer");
    assert.equal(
      editorRunsListPath(WORKFLOW_ID, { status: "indeterminate", limit: 25 }),
      `/workflows/${WORKFLOW_ID}/executions?status=indeterminate&limit=25`,
    );
    assert.equal(editorRunsListIsWorkflowScoped(WORKFLOW_ID), true);
    assert.equal(EDITOR_RUNS_LIST_LIMIT, 50);
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
      EDITOR_RUNS_SOURCES.includes("src/components/executions/ExecutionReplay.tsx"),
      false,
    );
  });

  it("keeps indeterminate as icon+text and leaves workspace /executions as the ops view", () => {
    assert.equal(editorRunsIndeterminateIsIconAndText(), true);
    assert.equal(EDITOR_RUNS.indeterminateIconAndText, true);
    const rows = editorRunsDisplay([record({ status: "indeterminate" })], true);
    assert.equal(rows[0]?.indeterminate, true);
    assert.equal(rows[0]?.status, "indeterminate");
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
