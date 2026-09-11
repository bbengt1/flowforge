import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_NDV_RUN_IO,
  INVENTED_REPLAY_ROUTE,
  NDV_RUN_IO_DETAIL_PATH,
  NDV_RUN_IO_JUMP_HELP,
  NDV_RUN_IO_JUMP_LABEL,
  NDV_RUN_IO_LATEST_HELP,
  NDV_RUN_IO_LATEST_LIST_LIMIT,
  NDV_RUN_IO_LOGS_PATH,
  NDV_RUN_IO_NO_RUN_HELP,
  NDV_RUN_IO_OPERATE_HELP,
  NDV_RUN_IO_OVERLAY_HELP,
  NDV_RUN_IO_PANEL,
  NDV_RUN_IO_PAYLOAD_GAP_HELP,
  NDV_RUN_IO_RAIL_SOURCES,
  NDV_RUN_IO_REPLAY_GRAPH_SOURCE,
  R43_EPIC,
  R43_KEEP_STORY_OPEN,
  R43_STORY,
  ndvLatestRunListPath,
  ndvRunIoAnnouncement,
  ndvRunIoCanLoad,
  ndvRunIoContextId,
  ndvRunIoContextSource,
  ndvRunIoDocumentsPayloadGap,
  ndvRunIoDoesNotInventReplayRoute,
  ndvRunIoDraftsNeverRun,
  ndvRunIoEmbedRoutesUnchanged,
  ndvRunIoForSelectedNode,
  ndvRunIoHasSingleOperatePath,
  ndvRunIoIndeterminateIsLoud,
  ndvRunIoInheritsR4Guardrails,
  ndvRunIoJumpLinks,
  ndvRunIoJumpTarget,
  ndvRunIoPreservesRedaction,
  ndvRunIoStepPayloadGap,
  ndvRunIoUsesExistingRoutes,
  ndvRunIoView,
  ndvRunIsPublished,
  pickLatestPublishedRun,
} from "./editor-ndv-run-io.ts";
import { R4_GUARDRAILS, R4_LATER_STORY_NOTES } from "./execution-inbox.ts";
import { EDITOR_RUN_NO_STEP_HELP } from "./editor-run-io.ts";
import type { ExecutionDetail, ExecutionRecord, ExecutionStep } from "./execution-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const LATEST_ID = "55555555-5555-4555-8555-555555555555";
const STEP_ID = "44444444-4444-4444-8444-444444444444";

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

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

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
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
    ...overrides,
  };
}

function detail(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    ...record(),
    pins: [],
    steps: [step()],
    jobs: [],
    auditEvents: [],
    artifacts: [],
    legalHold: false,
    ...overrides,
  };
}

describe("R4.3 NDV last-run I/O operate density", () => {
  it("keeps #256 open and cites epic #230", () => {
    assert.equal(R43_STORY, 256);
    assert.equal(R43_EPIC, 230);
    assert.equal(R43_KEEP_STORY_OPEN, true);
    assert.equal(ndvRunIoInheritsR4Guardrails(), true);
    assert.equal(R4_GUARDRAILS.overlayStaysEditorOnly, true);
    assert.match(R4_LATER_STORY_NOTES.r43, /#256/);
    assert.equal(NDV_RUN_IO_PANEL, "last-run");
    assert.match(NDV_RUN_IO_OPERATE_HELP, /operate density/);
    assert.match(NDV_RUN_IO_OPERATE_HELP, /\/executions\/\{id\}/);
    assert.match(NDV_RUN_IO_JUMP_HELP, /jump to the node/);
  });

  it("takes overlay selection over latest published run", () => {
    assert.equal(EDITOR_NDV_RUN_IO.contextFromOverlayOrLatest, true);
    assert.equal(EDITOR_NDV_RUN_IO.overlaySelectionWins, true);
    assert.equal(EDITOR_NDV_RUN_IO.latestPublishedRunFallback, true);
    assert.equal(ndvRunIoContextSource(EXECUTION_ID, LATEST_ID), "overlay");
    assert.equal(ndvRunIoContextId(EXECUTION_ID, LATEST_ID), EXECUTION_ID);
    assert.equal(ndvRunIoContextSource(null, LATEST_ID), "latest");
    assert.equal(ndvRunIoContextId("", LATEST_ID), LATEST_ID);
    assert.equal(ndvRunIoContextSource(null, null), null);
    assert.equal(ndvLatestRunListPath(WORKFLOW_ID), `/workflows/${WORKFLOW_ID}/executions?limit=1`);
    assert.equal(NDV_RUN_IO_LATEST_LIST_LIMIT, 1);
    assert.equal(
      pickLatestPublishedRun([
        record({
          id: LATEST_ID,
          startedAt: "2026-09-10T01:00:00.000Z",
          createdAt: "2026-09-10T01:00:00.000Z",
        }),
        record({ workflowVersionId: "draft" }),
      ])?.id,
      LATEST_ID,
    );
    assert.equal(pickLatestPublishedRun([record({ workflowVersionId: "" })]), null);
    assert.equal(ndvRunIsPublished(record()), true);
    assert.equal(ndvRunIsPublished(record({ workflowVersionId: "draft" })), false);
    assert.match(NDV_RUN_IO_LATEST_HELP, /latest published run/);
    assert.match(NDV_RUN_IO_OVERLAY_HELP, /overlay-selected run/);
    assert.match(NDV_RUN_IO_NO_RUN_HELP, /drafts never execute/i);
  });

  it("shows operate-density redacted step I/O and jumps failures to the node", () => {
    const failed = detail({
      status: "failed",
      steps: [
        step({
          status: "failed",
          error: { message: "apply failed", token: "[redacted]" },
          output: { kubeconfig: "[redacted]" },
        }),
        step({
          id: "66666666-6666-4666-8666-666666666666",
          nodeId: "notify",
          nodeType: "http.request",
          status: "indeterminate",
          input: { token: "[redacted]" },
          output: null,
        }),
      ],
    });
    const view = ndvRunIoView({
      detail: failed,
      nodeId: "apply",
      source: "overlay",
      logs: {
        stepId: STEP_ID,
        lines: ["token: [redacted]"],
        text: "token: [redacted]",
        offset: 0,
        nextOffset: 1,
        truncated: false,
        byteCount: 18,
        maxBytes: 8192,
      },
    });
    assert.equal(view.source, "overlay");
    assert.equal(view.sourceLabel, "Overlay run");
    assert.equal(view.io?.missingStep, false);
    assert.match(view.stepMeta, /kubernetes.apply/);
    assert.match(view.stepMeta, /attempt 1/);
    assert.match(view.io?.inputText ?? "", /dryRun/);
    assert.match(view.io?.outputText ?? "", /\[redacted\]/);
    assert.match(view.io?.errorText ?? "", /\[redacted\]/);
    assert.equal(ndvRunIoPreservesRedaction(view), true);
    const jumps = ndvRunIoJumpLinks(failed);
    assert.equal(jumps.length, 2);
    assert.equal(ndvRunIoJumpTarget(jumps[0]!), "apply");
    assert.equal(ndvRunIoJumpTarget(jumps[1]!), "notify");
    assert.equal(NDV_RUN_IO_JUMP_LABEL, "Jump to node");
    assert.match(
      ndvRunIoAnnouncement({
        nodeId: "apply",
        nodeName: "Apply",
        nodeType: "kubernetes.apply",
        view,
      }),
      /operate density/,
    );

    const missing = ndvRunIoView({ detail: failed, nodeId: "plan", source: "latest" });
    assert.equal(missing.io?.missingStep, true);
    assert.match(
      ndvRunIoAnnouncement({ nodeId: "plan", view: missing }),
      new RegExp(EDITOR_RUN_NO_STEP_HELP),
    );
    assert.equal(ndvRunIoForSelectedNode(failed, "notify").nodeId, "notify");
  });

  it("documents a step I/O payload gap instead of inventing shapes", () => {
    const gap = detail({
      steps: [step({ input: null, output: null, error: null })],
    });
    assert.equal(ndvRunIoStepPayloadGap(gap.steps[0]), true);
    assert.equal(ndvRunIoStepPayloadGap(null), false);
    const view = ndvRunIoView({ detail: gap, nodeId: "apply", source: "latest" });
    assert.equal(view.payloadGap, true);
    assert.match(NDV_RUN_IO_PAYLOAD_GAP_HELP, /jonny standby/);
    assert.equal(EDITOR_NDV_RUN_IO.noInventedStepPayloadShapes, true);
    assert.equal(EDITOR_NDV_RUN_IO.jonnyNeededForStepIo, false);
    assert.equal(ndvRunIoDocumentsPayloadGap(detail()), true);
    assert.equal(ndvRunIoDocumentsPayloadGap(gap), true);
    assert.match(
      ndvRunIoAnnouncement({ nodeId: "apply", view }),
      /jonny standby/,
    );
  });

  it("keeps one operate path, loud indeterminate, and drafts never run", () => {
    assert.equal(ndvRunIoHasSingleOperatePath(), true);
    assert.equal(ndvRunIoDoesNotInventReplayRoute(), true);
    assert.equal(ndvRunIoDraftsNeverRun(), true);
    assert.equal(ndvRunIoIndeterminateIsLoud(), true);
    assert.equal(ndvRunIoUsesExistingRoutes(WORKFLOW_ID), true);
    assert.equal(ndvRunIoEmbedRoutesUnchanged(), true);
    assert.equal(INVENTED_REPLAY_ROUTE, "/replay");
    assert.equal(NDV_RUN_IO_DETAIL_PATH, "/executions/{id}");
    assert.equal(NDV_RUN_IO_LOGS_PATH, "/executions/{id}/steps/{stepId}/logs");
    assert.equal(EDITOR_NDV_RUN_IO.noSecondExecutionReplay, true);
    assert.equal(EDITOR_NDV_RUN_IO.noCancelRetryDensify, true);
    assert.equal(EDITOR_NDV_RUN_IO.noWaitingDecideDensify, true);
    assert.equal(EDITOR_NDV_RUN_IO.noSse, true);
    assert.equal(EDITOR_NDV_RUN_IO.noPinData, true);
    assert.equal(EDITOR_NDV_RUN_IO.noSecretField, true);
    assert.equal(EDITOR_NDV_RUN_IO.noExpressionLanguage, true);
    assert.equal(
      (NDV_RUN_IO_RAIL_SOURCES as readonly string[]).includes(
        NDV_RUN_IO_REPLAY_GRAPH_SOURCE,
      ),
      false,
    );
    const loud = ndvRunIoView({
      detail: detail({
        steps: [step({ status: "indeterminate", output: { token: "[redacted]" } })],
      }),
      nodeId: "apply",
      source: "overlay",
    });
    assert.equal(loud.io?.indeterminate, true);
    assert.match(
      ndvRunIoAnnouncement({ nodeId: "apply", view: loud }),
      /indeterminate/i,
    );
    const empty = ndvRunIoView({});
    assert.equal(empty.noPublishedRun, true);
    assert.match(
      ndvRunIoAnnouncement({ nodeId: "apply", view: empty }),
      /drafts never execute/i,
    );
    assert.equal(ndvRunIoCanLoad(null), false);
    assert.equal(ndvRunIoCanLoad(["workflow.view"]), false);
    assert.equal(ndvRunIoCanLoad(["execution.view"]), true);
  });

  it("densifies LastRunIoPanel in place and does not mount ExecutionReplay", () => {
    const panel = source("components/workflows/LastRunIoPanel.tsx");
    const inspector = source("components/workflows/EditorInspector.tsx");
    const operator = source("components/workflows/WorkflowOperator.tsx");
    assert.match(panel, /data-ndv-run-io/);
    assert.match(panel, /NDV_RUN_IO_OPERATE_HELP|ndvRunIoView/);
    assert.match(panel, /NDV_RUN_IO_JUMP_LABEL|onJumpNode/);
    assert.match(panel, /\[redacted\]/);
    assert.doesNotMatch(panel, /ExecutionReplay/);
    assert.doesNotMatch(panel, /SecretField/);
    assert.doesNotMatch(panel, /EventSource|text\/event-stream/);
    assert.doesNotMatch(panel, /pin-data|pinData/);
    assert.match(inspector, /data-ndv-panel="last-run"/);
    assert.match(inspector, /onJumpNode/);
    assert.doesNotMatch(inspector, /ExecutionReplay/);
    assert.match(operator, /pickLatestPublishedRun|loadLatestPublishedRun|latestNonce/);
    assert.match(operator, /source: runIoSource|"latest"/);
    assert.match(operator, /runIoSource === "overlay"/);
    assert.doesNotMatch(operator, /setRunsOpen/);
  });
});
