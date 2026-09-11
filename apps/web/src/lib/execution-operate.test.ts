import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXECUTION_OPERATE,
  EXECUTION_OPERATE_CANCEL_LABEL,
  EXECUTION_OPERATE_DETAIL_STATUSES,
  EXECUTION_OPERATE_HELP,
  EXECUTION_OPERATE_REPLAY_GRAPH_SOURCE,
  EXECUTION_OPERATE_RETRY_GATE_HELP,
  EXECUTION_OPERATE_RETRY_LABEL,
  EXECUTION_OPERATE_SOURCES,
  EXECUTION_OPERATE_STOP_LABEL,
  INVENTED_JOB_CLAIM_ROUTE,
  R44_EPIC,
  R44_KEEP_STORY_OPEN,
  R44_STORY,
  executionOperateAffordances,
  executionOperateDoesNotInventJobClaim,
  executionOperateDoesNotInventReplayRoute,
  executionOperateDraftsNeverRun,
  executionOperateFromDetail,
  executionOperateHasSingleOperatePath,
  executionOperateIndeterminateIsLoud,
  executionOperateInheritsR4Guardrails,
  executionOperateNeedsDetail,
  executionOperateNeverOffersBlindRetry,
  executionOperatePaths,
  executionOperateRetryAllowed,
  executionOperateShouldLoadDetail,
  executionOperateSurfaceOn,
  executionOperateUsesExistingRoutes,
  parseExecutionRetryAllowed,
} from "./execution-operate.ts";
import { R4_GUARDRAILS, R4_LATER_STORY_NOTES } from "./execution-inbox.ts";
import type { ExecutionDetail, ExecutionRecord, ExecutionStep } from "./execution-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "44444444-4444-4444-8444-444444444444";

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "rollout",
    workflowSlug: "rollout",
    workflowVersionId: "22222222-2222-4222-8222-222222222222",
    workflowVersionNumber: 3,
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
    input: { token: "[redacted]" },
    policySnapshot: null,
    permittedActions: [],
    ...overrides,
  };
}

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: STEP_ID,
    executionId: EXECUTION_ID,
    nodeId: "set",
    nodeType: "data.set",
    attempt: 1,
    status: "failed",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:01:00.000Z",
    createdAt: "2026-09-09T01:00:00.000Z",
    input: {},
    output: null,
    error: { message: "boom" },
    fencingToken: 1,
    workerId: "worker-1",
    leaseId: "lease-1",
    ...overrides,
  };
}

function detail(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    ...record({ status: "failed" }),
    pins: [],
    steps: [step()],
    jobs: [],
    auditEvents: [],
    artifacts: [],
    legalHold: false,
    ...overrides,
  };
}

describe("R4.4 execution operate density", () => {
  it("keeps #257 open and cites epic #230", () => {
    assert.equal(R44_STORY, 257);
    assert.equal(R44_EPIC, 230);
    assert.equal(R44_KEEP_STORY_OPEN, true);
    assert.equal(executionOperateInheritsR4Guardrails(), true);
    assert.equal(R4_GUARDRAILS.loudIndeterminate, true);
    assert.match(R4_LATER_STORY_NOTES.r44, /#257/);
    assert.match(EXECUTION_OPERATE_HELP, /result\.retry\.allowed/);
    assert.match(EXECUTION_OPERATE_HELP, /\/executions\/\{id\}\/cancel/);
    assert.match(EXECUTION_OPERATE_HELP, /emergency-stop/);
    assert.match(EXECUTION_OPERATE_HELP, /never silent success/);
    assert.equal(EXECUTION_OPERATE_CANCEL_LABEL, "Cancel");
    assert.equal(EXECUTION_OPERATE_RETRY_LABEL, "Retry");
    assert.equal(EXECUTION_OPERATE_STOP_LABEL, "Stop");
    assert.ok(
      EXECUTION_OPERATE_SOURCES.includes(
        "src/components/executions/ExecutionOperateActions.tsx",
      ),
    );
  });

  it("exposes cancel on queued/running and never on indeterminate", () => {
    const running = executionOperateAffordances({
      permissions: ["execution.cancel", "workflow.execute"],
      status: "running",
    });
    assert.equal(running.cancel, true);
    assert.equal(running.retry, false);
    assert.equal(running.stop, false);

    const queued = executionOperateAffordances({
      permissions: ["execution.cancel"],
      status: "queued",
    });
    assert.equal(queued.cancel, true);

    const viewer = executionOperateAffordances({
      permissions: ["execution.view"],
      status: "running",
    });
    assert.equal(viewer.cancel, false);

    const uncertain = executionOperateAffordances({
      permissions: ["execution.cancel", "workflow.execute"],
      status: "indeterminate",
    });
    assert.equal(uncertain.cancel, false);
    assert.equal(uncertain.indeterminate, true);
    assert.match(uncertain.loudIndeterminateCopy, /did not run/i);
  });

  it("gates Retry on result.retry.allowed and never offers a blind retry", () => {
    assert.equal(
      parseExecutionRetryAllowed({
        result: { retry: { allowed: true, retrySafe: true } },
      }),
      true,
    );
    assert.equal(
      parseExecutionRetryAllowed({
        steps: [
          step({
            nodeType: "ssh.run",
            status: "indeterminate",
            output: { retry: { allowed: false } },
          }),
        ],
      }),
      false,
    );
    assert.equal(parseExecutionRetryAllowed({ steps: [step()] }), null);

    const sshAllowed = executionOperateRetryAllowed({
      permissions: ["workflow.execute"],
      status: "indeterminate",
      steps: [
        step({
          nodeType: "ssh.run",
          status: "indeterminate",
          output: { retry: { allowed: true, retrySafe: true } },
        }),
      ],
    });
    assert.equal(sshAllowed, true);

    const sshDenied = executionOperateAffordances({
      permissions: ["workflow.execute"],
      status: "indeterminate",
      steps: [
        step({
          nodeType: "ssh.run",
          status: "indeterminate",
          output: { retry: { allowed: false } },
        }),
      ],
    });
    assert.equal(sshDenied.retry, false);
    assert.equal(sshDenied.retryAllowed, false);
    assert.match(sshDenied.retryBlockedReason, /did not run|retry\.allowed/i);

    const core = executionOperateFromDetail(
      detail(),
      ["workflow.execute", "execution.cancel"],
    );
    assert.equal(core.retry, true);
    assert.equal(core.cancel, false);

    const closed = executionOperateRetryAllowed({
      permissions: ["workflow.execute"],
      status: "failed",
      steps: [step()],
      result: { retry: { allowed: false } },
    });
    assert.equal(closed, false);

    assert.equal(executionOperateNeverOffersBlindRetry(), true);
    assert.match(EXECUTION_OPERATE_RETRY_GATE_HELP, /result\.retry\.allowed/);
  });

  it("offers emergency stop only for open script runs", () => {
    const runningScript = executionOperateAffordances({
      permissions: ["script.emergencyStop"],
      status: "running",
      steps: [step({ nodeType: "script.python", status: "running" })],
    });
    assert.equal(runningScript.stop, true);
    assert.equal(runningScript.retry, false);

    const coreRunning = executionOperateAffordances({
      permissions: ["script.emergencyStop", "execution.cancel"],
      status: "running",
      steps: [step({ nodeType: "data.set", status: "running" })],
    });
    assert.equal(coreRunning.stop, false);
    assert.equal(coreRunning.cancel, true);

    const viewer = executionOperateAffordances({
      permissions: ["execution.view"],
      status: "running",
      steps: [step({ nodeType: "script.go", status: "running" })],
    });
    assert.equal(viewer.stop, false);

    const afterStop = executionOperateAffordances({
      permissions: ["workflow.execute", "script.emergencyStop"],
      status: "indeterminate",
      steps: [step({ nodeType: "script.python", status: "indeterminate" })],
      stoppedUncertain: true,
    });
    assert.equal(afterStop.retry, false);
    assert.match(afterStop.loudIndeterminateCopy, /indeterminate/i);
  });

  it("loads GET /executions/{id} before offering retry/stop from a list row", () => {
    assert.deepEqual(
      [...EXECUTION_OPERATE_DETAIL_STATUSES],
      [
        "queued",
        "claimed",
        "running",
        "failed",
        "canceled",
        "indeterminate",
      ],
    );
    assert.equal(executionOperateShouldLoadDetail(record({ status: "failed" })), true);
    assert.equal(
      executionOperateShouldLoadDetail(record({ status: "succeeded" })),
      false,
    );
    assert.equal(
      executionOperateNeedsDetail({ status: "failed", steps: [] }),
      true,
    );
    assert.equal(
      executionOperateNeedsDetail({ status: "failed", steps: [step()] }),
      false,
    );
    const listOnly = executionOperateAffordances({
      permissions: ["workflow.execute"],
      status: "failed",
    });
    assert.equal(listOnly.needsDetail, true);
    assert.equal(listOnly.retry, false);
  });

  it("reuses existing cancel/retry/stop routes and invents neither /replay nor /jobs/claim", () => {
    const paths = executionOperatePaths(EXECUTION_ID);
    assert.equal(paths.cancel, `/executions/${EXECUTION_ID}/cancel`);
    assert.equal(paths.retry, `/executions/${EXECUTION_ID}/retry`);
    assert.equal(paths.stop, `/executions/${EXECUTION_ID}/emergency-stop`);
    assert.equal(executionOperateUsesExistingRoutes(EXECUTION_ID), true);
    assert.equal(executionOperateDoesNotInventJobClaim(), true);
    assert.equal(executionOperateDoesNotInventReplayRoute(), true);
    assert.equal(executionOperateHasSingleOperatePath(), true);
    assert.equal(executionOperateDraftsNeverRun(), true);
    assert.equal(executionOperateIndeterminateIsLoud(), true);
    assert.equal(executionOperateIndeterminateIsLoud("succeeded"), false);
    assert.equal(executionOperateSurfaceOn("inbox"), true);
    assert.equal(executionOperateSurfaceOn("overlay"), true);
    assert.equal(INVENTED_JOB_CLAIM_ROUTE, "/jobs/claim");
    assert.equal(
      EXECUTION_OPERATE_SOURCES.includes(EXECUTION_OPERATE_REPLAY_GRAPH_SOURCE),
      false,
    );
    assert.equal(EXECUTION_OPERATE.noSse, true);
    assert.equal(EXECUTION_OPERATE.noWaitingDecideDensify, true);
    assert.equal(EXECUTION_OPERATE.migrateInPlace, true);
  });

  it("densifies inbox rows and the overlay in place without a second replay graph", () => {
    const actions = source("components/executions/ExecutionOperateActions.tsx");
    const inbox = source("components/executions/ExecutionHistory.tsx");
    const listbox = source("components/executions/ExecutionHistoryListbox.tsx");
    const overlay = source("components/workflows/EditorRunsDrawer.tsx");
    assert.match(actions, /data-execution-operate/);
    assert.match(actions, /cancelExecution/);
    assert.match(actions, /retryExecution/);
    assert.match(actions, /emergencyStopExecution/);
    assert.match(actions, /result\.retry\.allowed|executionOperateRetryAllowed/);
    assert.doesNotMatch(actions, /ExecutionReplay/);
    assert.doesNotMatch(actions, /\/jobs\/claim/);
    assert.doesNotMatch(actions, /\/replay/);
    assert.doesNotMatch(actions, /EventSource|text\/event-stream/);
    assert.match(inbox, /ExecutionOperateActions/);
    assert.match(inbox, /loadExecutionHistory/);
    assert.match(listbox, /operateActions|data-execution-operate/);
    assert.match(overlay, /ExecutionOperateActions/);
    assert.doesNotMatch(inbox, /ExecutionReplay/);
    assert.doesNotMatch(overlay, /ExecutionReplay/);
    assert.doesNotMatch(overlay, /\/jobs\/claim/);
    assert.equal(EXECUTION_OPERATE.inboxRowsExposeActions, true);
    assert.equal(EXECUTION_OPERATE.overlayExposesActions, true);
  });
});
