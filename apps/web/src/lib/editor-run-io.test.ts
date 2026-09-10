import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDITOR_RUN_IO,
  EDITOR_RUN_IO_DETAIL_PATH,
  EDITOR_RUN_IO_LOGS_PATH,
  EDITOR_RUN_IO_SOURCES,
  EDITOR_RUN_NO_STEP_HELP,
  EDITOR_RUN_OVERLAY_HELP,
  EDITOR_RUN_OVERLAY_KEYBOARD_HELP,
  INVENTED_REPLAY_ROUTE,
  UX11_EPIC,
  UX11_KEEP_STORY_OPEN,
  UX11_STORY,
  editorRunCurrentNodeId,
  editorRunDetailPath,
  editorRunIndeterminateIsLoud,
  editorRunIoDoesNotInventReplayRoute,
  editorRunIoForNode,
  editorRunIoText,
  editorRunIoUsesExistingDetailRoute,
  editorRunLogsPath,
  editorRunOpsHref,
  editorRunOverlayAnnouncement,
  editorRunOverlayGraph,
  editorRunShouldPoll,
  editorRunWorkspaceHref,
  executionDetailExposesRedactedStepIo,
} from "./editor-run-io.ts";
import { INDETERMINATE_STATUS_HELP } from "./execution-contract.ts";
import { overlayExecutionOnGraph } from "./execution-replay.ts";
import type { ExecutionDetail, ExecutionStep } from "./execution-types.ts";
import type { WorkflowGraph } from "./workflow-graph.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const STEP_ID = "44444444-4444-4444-8444-444444444444";

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: STEP_ID,
    executionId: EXECUTION_ID,
    nodeId: "apply",
    nodeType: "kubernetes.apply",
    attempt: 1,
    status: "succeeded",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:01:00.000Z",
    createdAt: "2026-09-09T01:00:00.000Z",
    input: { dryRun: false },
    output: { token: "[redacted]", applied: true },
    error: null,
    fencingToken: 1,
    workerId: "worker-1",
    leaseId: "lease-1",
    ...overrides,
  };
}

function detail(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "Deploy API",
    workflowSlug: "deploy-api",
    workflowVersionId: VERSION_ID,
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
    input: { secret: "[redacted]" },
    policySnapshot: null,
    permittedActions: [],
    pins: [],
    steps: [step()],
    jobs: [],
    auditEvents: [],
    artifacts: [],
    legalHold: false,
    ...overrides,
  };
}

function graph(): WorkflowGraph {
  return {
    name: "Deploy API",
    description: "",
    nodes: [
      {
        id: "apply",
        type: "kubernetes.apply",
        name: "Apply",
        with: {},
        inputs: [],
        outputs: [],
        state: "valid",
        startLine: 1,
      },
      {
        id: "notify",
        type: "http.request",
        name: "Notify",
        with: {},
        inputs: [],
        outputs: [],
        state: "valid",
        startLine: 8,
      },
    ],
    edges: [],
    triggers: [],
  };
}

describe("UX.11 editor last-run I/O overlay", () => {
  it("keeps #206 open and cites epic #195", () => {
    assert.equal(UX11_STORY, 206);
    assert.equal(UX11_EPIC, 195);
    assert.equal(UX11_KEEP_STORY_OPEN, true);
  });

  it("overlays existing replay helpers on the same editor graph", () => {
    assert.equal(EDITOR_RUN_IO.sameCanvasOverlay, true);
    assert.equal(EDITOR_RUN_IO.noSecondReplayGraph, true);
    assert.equal(EDITOR_RUN_IO.noExecutionReplayMount, true);
    assert.equal(
      EDITOR_RUN_IO_SOURCES.includes("src/components/executions/ExecutionReplay.tsx"),
      false,
    );
    const base = graph();
    const steps = [step({ status: "indeterminate" })];
    const overlaid = editorRunOverlayGraph(base, steps);
    assert.deepEqual(
      overlaid,
      overlayExecutionOnGraph(base, steps, { waitingApprovalNodeIds: [] }),
    );
    assert.equal(overlaid.nodes[0]?.state, "indeterminate");
    assert.equal(overlaid.nodes[1]?.state, "valid");
    assert.match(EDITOR_RUN_OVERLAY_HELP, /overlays this draft graph/);
    assert.match(EDITOR_RUN_OVERLAY_KEYBOARD_HELP, /overlays the focused run/);
  });

  it("uses GET /executions/{id} step I/O and does not invent /replay", () => {
    assert.equal(EDITOR_RUN_IO_DETAIL_PATH, "/executions/{id}");
    assert.equal(EDITOR_RUN_IO_LOGS_PATH, "/executions/{id}/steps/{stepId}/logs");
    assert.equal(editorRunDetailPath(EXECUTION_ID), `/executions/${EXECUTION_ID}`);
    assert.equal(
      editorRunLogsPath(EXECUTION_ID, STEP_ID),
      `/executions/${EXECUTION_ID}/steps/${STEP_ID}/logs`,
    );
    assert.equal(editorRunIoUsesExistingDetailRoute(), true);
    assert.equal(editorRunIoDoesNotInventReplayRoute(), true);
    assert.equal(INVENTED_REPLAY_ROUTE, "/replay");
    assert.equal(EDITOR_RUN_IO.jonnyNeededForStepIo, false);
    assert.equal(executionDetailExposesRedactedStepIo(detail()), true);
    assert.equal(
      executionDetailExposesRedactedStepIo(detail({ steps: [] })),
      false,
    );
  });

  it("shows redacted inspector I/O and keeps indeterminate loud", () => {
    const io = editorRunIoForNode(
      detail({
        steps: [
          step({
            status: "indeterminate",
            output: { kubeconfig: "[redacted]", applied: true },
            input: { token: "[redacted]" },
          }),
        ],
      }),
      "apply",
      { logs: { stepId: STEP_ID, lines: ["token: [redacted]"], text: "token: [redacted]", offset: 0, nextOffset: 1, truncated: false, byteCount: 18, maxBytes: 8192 } },
    );
    assert.equal(io.missingStep, false);
    assert.equal(io.indeterminate, true);
    assert.match(io.outputText, /\[redacted\]/);
    assert.match(io.inputText, /\[redacted\]/);
    assert.match(io.logsText, /\[redacted\]/);
    const text = editorRunIoText(io);
    assert.match(text, /\[redacted\]/);
    assert.match(text, /indeterminate/i);
    assert.equal(text.includes("-----BEGIN"), false);
    assert.equal(text.includes("should-not-leak"), false);
    assert.equal(editorRunIndeterminateIsLoud(), true);
    assert.match(io.indeterminateHelp, /Do not assume the action did not run/);
    assert.equal(io.indeterminateHelp, INDETERMINATE_STATUS_HELP);

    const missing = editorRunIoForNode(detail(), "notify");
    assert.equal(missing.missingStep, true);
    assert.match(
      editorRunOverlayAnnouncement({ nodeId: "notify", io: missing }),
      new RegExp(EDITOR_RUN_NO_STEP_HELP),
    );
    assert.match(
      editorRunOverlayAnnouncement({
        nodeId: "apply",
        nodeName: "Apply",
        nodeType: "kubernetes.apply",
        io,
      }),
      /indeterminate/i,
    );
  });

  it("keeps workspace /executions as the ops inbox and never drafts execute", () => {
    assert.equal(EDITOR_RUN_IO.workspaceExecutionsRemainsOpsInbox, true);
    assert.equal(EDITOR_RUN_IO.opsDeepLinkRemainsAvailable, true);
    assert.equal(EDITOR_RUN_IO.noDraftExecute, true);
    assert.equal(editorRunWorkspaceHref(), "/executions");
    assert.equal(editorRunWorkspaceHref(true), "/embed/v1/executions");
    assert.equal(
      editorRunOpsHref(EXECUTION_ID, WORKFLOW_ID),
      `/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(
      editorRunOpsHref(EXECUTION_ID, WORKFLOW_ID, true),
      `/embed/v1/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(editorRunShouldPoll("running"), true);
    assert.equal(editorRunShouldPoll("queued"), true);
    assert.equal(editorRunShouldPoll("succeeded"), false);
    assert.equal(editorRunShouldPoll("indeterminate"), false);
    assert.equal(editorRunCurrentNodeId([step({ status: "running" })]), "apply");
  });
});
