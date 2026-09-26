import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INDETERMINATE_STATUS_HELP,
  RETRY_INDETERMINATE_MESSAGE,
} from "./execution-contract.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvalWaitControls,
  gateStepFailureCopy,
  buildPreRunReview,
  canStartPublishedRun,
  canvasStateFromExecutionStatus,
  compareContainsPlaintextSecret,
  compareRedactedExecutions,
  currentReplayNodeId,
  executionErrorNavLinks,
  formatDuration,
  historyKeyAction,
  indeterminatePresentation,
  indeterminateReplayAnnouncement,
  isDraftRunSelection,
  isIndeterminateUnmistakable,
  overlayExecutionOnGraph,
  parseTriggerInput,
  projectPinnedVersionGraph,
  publishedRunVersions,
  replayNodeStateLabel,
  replayStepViews,
  retryBlockedForIndeterminate,
  waitingApprovalNodeIds,
  sideEffectWarnings,
  stepDurationMs,
  summaryFromPublishedYaml,
} from "./execution-replay.ts";
import { executionStatusPresentation } from "./execution.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import type { ExecutionDetail, ExecutionRecord, ExecutionStep } from "./execution-types.ts";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML } from "./workflow.ts";
import {
  canvasNodeStateDescription,
  canvasNodeStateIcon,
  canvasNodeStateLabel,
} from "./workflow-graph.ts";
import type { WorkflowCatalog, WorkflowVersion } from "./workflow-types.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_EXECUTION_ID = "44444444-4444-4444-8444-444444444444";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  rules: {
    triggersAreWorkflowLevel: true,
    graphNodesExcludeTriggers: true,
  },
  triggers: [{ type: "manual", phase: "core" }],
  nodes: [
    {
      type: "data.set",
      phase: "core",
      outputs: [{ name: "result", kind: "object" }],
    },
    {
      type: "flow.stop",
      phase: "core",
      inputs: [{ name: "input", kind: "any" }],
    },
    {
      type: "kubernetes.apply",
      phase: "core",
      policy: { sideEffects: true },
    },
  ],
};

function sampleVersion(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: VERSION_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 3,
    definitionYaml: STARTER_WORKFLOW_YAML,
    digest: "sha256:abcdef0123456789",
    publishNote: "ship it",
    publishedAt: "2026-09-09T01:00:00.000Z",
    ...overrides,
  };
}

function sampleRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowName: "rollout",
    workflowSlug: "rollout",
    workflowVersionId: VERSION_ID,
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
    triggerId: "manual",
    input: { dryRun: true },
    policySnapshot: { revision: 1 },
    permittedActions: [],
    ...overrides,
  };
}

function sampleStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    executionId: EXECUTION_ID,
    nodeId: "seed",
    nodeType: "data.set",
    attempt: 1,
    status: "succeeded",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:00:02.000Z",
    createdAt: "2026-09-09T01:00:00.000Z",
    input: { value: { status: "ready" } },
    output: { result: { status: "ready" } },
    error: null,
    fencingToken: null,
    workerId: "",
    leaseId: "",
    ...overrides,
  };
}

function sampleDetail(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    ...sampleRecord(),
    pins: [],
    steps: [sampleStep()],
    jobs: [],
    auditEvents: [],
    artifacts: [],
    legalHold: false,
    ...overrides,
  };
}

describe("indeterminate presentation", () => {
  it("is unmistakable with icon and text, not color alone", () => {
    const presentation = indeterminatePresentation("indeterminate");
    assert.equal(presentation.icon, "⚠");
    assert.equal(presentation.label, "Indeterminate");
    assert.equal(isIndeterminateUnmistakable(presentation), true);
    assert.match(presentation.description, /Do not assume/);
    const announcement = indeterminateReplayAnnouncement("indeterminate");
    assert.match(announcement, /⚠/);
    assert.match(announcement, /Indeterminate/);
    assert.match(announcement, /not verified/);
    assert.equal(announcement.includes(INDETERMINATE_STATUS_HELP.split(".")[0] ?? ""), true);
  });
});

describe("retry blocked for indeterminate", () => {
  it("never offers retry for indeterminate execution or step", () => {
    assert.equal(
      retryBlockedForIndeterminate({
        executionStatus: "indeterminate",
        steps: [{ status: "indeterminate", nodeType: "data.set" }],
      }),
      true,
    );
    assert.equal(
      retryBlockedForIndeterminate({
        executionStatus: "failed",
        stepStatus: "indeterminate",
        nodeType: "data.set",
      }),
      true,
    );
    assert.equal(
      retryBlockedForIndeterminate({
        executionStatus: "failed",
        stepStatus: "failed",
        nodeType: "data.set",
      }),
      false,
    );
    assert.match(RETRY_INDETERMINATE_MESSAGE, /Do not assume the action did not run/);
  });
});

describe("pre-run published-only", () => {
  it("rejects drafts and only builds a body with workflowVersionId", () => {
    const versions = [sampleVersion()];
    assert.equal(isDraftRunSelection("draft"), true);
    assert.equal(isDraftRunSelection(VERSION_ID), false);
    assert.deepEqual(
      publishedRunVersions([{ ...sampleVersion(), id: "draft" }, sampleVersion()]).map(
        (item) => item.id,
      ),
      [VERSION_ID],
    );

    const draft = canStartPublishedRun({
      versions,
      selectedVersionId: "draft",
    });
    assert.equal(draft.ok, false);
    assert.equal(draft.body, null);
    assert.match(draft.reason, /Drafts/);

    const missing = canStartPublishedRun({
      versions,
      selectedVersionId: OTHER_VERSION_ID,
    });
    assert.equal(missing.ok, false);

    const ok = canStartPublishedRun({
      versions,
      selectedVersionId: VERSION_ID,
      extras: { idempotencyKey: "deploy-prod-1", input: { dryRun: true } },
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.body, {
      workflowVersionId: VERSION_ID,
      idempotencyKey: "deploy-prod-1",
      input: { dryRun: true },
    });
    assert.equal(JSON.stringify(ok.body).includes("draft"), false);
  });

  it("builds a pre-run review with digest, trigger, targets, and side effects", () => {
    const version = sampleVersion({
      summary: {
        apiVersion: "flowforge/v1",
        name: "validate-example",
        triggers: [{ id: "manual", type: "manual" }],
        nodes: [
          { id: "seed", type: "data.set", name: "Seed value" },
          { id: "apply", type: "kubernetes.apply", name: "Apply rollout" },
        ],
        edges: [],
        outputs: [],
      },
    });
    const review = buildPreRunReview({
      version,
      versions: [version],
      selectedVersionId: VERSION_ID,
      pins: [
        {
          kind: "cluster_target",
          resourceId: "77777777-7777-4777-8777-777777777777",
          versionId: "88888888-8888-4888-8888-888888888888",
          versionNumber: 2,
          digest: "sha256:target",
          name: "prod-cluster",
        },
      ],
      triggerInput: { ticket: "OPS-1", token: "hunter2" },
      evaluation: {
        decision: "allow",
        dispatchAllowed: true,
        evaluationId: "eval-1",
        workflowVersionId: VERSION_ID,
        workflowDigest: version.digest,
        operation: "workflow.execute",
        requirements: [],
        approvals: [],
        denied: [],
      },
      catalog,
    });
    assert.equal(review.published, true);
    assert.equal(review.canStart, true);
    assert.equal(review.digest, "sha256:abcdef0123456789");
    assert.equal(review.versionLabel, "v3");
    assert.equal(review.triggers[0]?.type, "manual");
    assert.equal(review.environment.includes("prod-cluster"), true);
    assert.equal((review.triggerInput as { ticket?: string }).ticket, "OPS-1");
    assert.equal("token" in (review.triggerInput as object), false);
    assert.ok(review.sideEffectWarnings.some((item) => /kubernetes.apply/.test(item)));
    assert.equal(sideEffectWarnings([{ type: "data.set" }], catalog).length, 0);
  });

  it("rejects non-object trigger JSON and strips secrets", () => {
    assert.equal(parseTriggerInput("").ok, true);
    assert.equal(parseTriggerInput("[1]").ok, false);
    const parsed = parseTriggerInput('{"dryRun":true,"password":"hunter2"}');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { dryRun: true });
    assert.ok(parsed.strippedKeys.includes("password"));
  });
});

describe("graph replay overlay", () => {
  it("projects pinned published YAML and overlays step status", () => {
    const graph = projectPinnedVersionGraph({
      yaml: STARTER_WORKFLOW_YAML,
      catalog,
    });
    assert.ok(graph);
    const overlaid = overlayExecutionOnGraph(graph, [
      sampleStep({ nodeId: "seed", status: "succeeded" }),
      sampleStep({
        id: "99999999-9999-4999-8999-999999999999",
        nodeId: "done",
        nodeType: "flow.stop",
        status: "indeterminate",
      }),
    ]);
    assert.equal(overlaid.nodes.find((node) => node.id === "seed")?.state, "succeeded");
    assert.equal(overlaid.nodes.find((node) => node.id === "done")?.state, "indeterminate");
    assert.equal(
      currentReplayNodeId([
        sampleStep({ nodeId: "seed", status: "succeeded" }),
        sampleStep({ nodeId: "done", status: "indeterminate" }),
      ]),
      "done",
    );
    assert.equal(canvasStateFromExecutionStatus("awaiting_approval"), "approval-required");
    assert.equal(stepDurationMs(sampleStep()), 2000);
    assert.equal(formatDuration(2000), "2.0 s");
  });

  it("shows skipped, pending, and blocked on the graph instead of Valid", () => {
    const graph = projectPinnedVersionGraph({
      yaml: STARTER_WORKFLOW_YAML,
      catalog,
    });
    assert.ok(graph);
    const overlaid = overlayExecutionOnGraph(graph, [
      sampleStep({ nodeId: "seed", status: "skipped" }),
      sampleStep({
        id: "99999999-9999-4999-8999-999999999999",
        nodeId: "done",
        nodeType: "flow.stop",
        status: "pending",
      }),
    ]);
    const skipped = overlaid.nodes.find((node) => node.id === "seed");
    const pending = overlaid.nodes.find((node) => node.id === "done");
    assert.equal(skipped?.state, "skipped");
    assert.equal(pending?.state, "pending");
    assert.equal(canvasStateFromExecutionStatus("blocked"), "blocked");
    for (const state of ["skipped", "pending", "blocked"] as const) {
      const label = replayNodeStateLabel(state);
      assert.match(label, new RegExp(canvasNodeStateLabel(state)));
      assert.equal(label.includes("Valid"), false);
      assert.equal(label.includes("✓"), false);
      assert.equal(canvasNodeStateIcon(state), executionStatusPresentation(state).icon);
      assert.notEqual(canvasNodeStateIcon(state), canvasNodeStateIcon("valid"));
      assert.notEqual(canvasNodeStateIcon(state), canvasNodeStateIcon("succeeded"));
      assert.notEqual(canvasNodeStateIcon(state), canvasNodeStateIcon("failed"));
      assert.notEqual(canvasNodeStateIcon(state), canvasNodeStateIcon("running"));
      assert.equal(
        canvasNodeStateDescription(state),
        executionStatusPresentation(state).description,
      );
    }
    assert.equal(
      executionErrorNavLinks({
        steps: [sampleStep({ nodeId: "seed", status: "skipped" })],
      }).some((link) => link.tone === "failed"),
      false,
    );
  });

  it("shows a pending step as Not reached when the run failed", () => {
    const graph = projectPinnedVersionGraph({
      yaml: STARTER_WORKFLOW_YAML,
      catalog,
    });
    assert.ok(graph);
    const pending = sampleStep({ nodeId: "seed", status: "pending" });
    const held = overlayExecutionOnGraph(
      graph,
      [pending],
      {
        runStatus: "failed",
        jobs: [
          {
            executionStepId: pending.id,
            status: "blocked",
          },
        ],
      },
    );
    const node = held.nodes.find((item) => item.id === "seed");
    assert.equal(node?.state, "not-reached");
    assert.equal(canvasNodeStateLabel("not-reached"), "Not reached");
    assert.equal(replayNodeStateLabel("not-reached").includes("Valid"), false);
    assert.equal(replayNodeStateLabel("not-reached").includes("✓"), false);
    assert.equal(canvasNodeStateIcon("not-reached"), "–");
    assert.match(canvasNodeStateDescription("not-reached"), /inputs were ready/);
    assert.match(canvasNodeStateDescription("not-reached"), /release it/);
    const stillPending = overlayExecutionOnGraph(graph, [pending], {
      runStatus: "running",
      jobs: [{ executionStepId: pending.id, status: "blocked" }],
    });
    assert.equal(
      stillPending.nodes.find((item) => item.id === "seed")?.state,
      "pending",
    );
    const queued = sampleStep({
      id: "99999999-9999-4999-8999-999999999999",
      nodeId: "done",
      status: "queued",
    });
    const fromJob = overlayExecutionOnGraph(graph, [queued], {
      runStatus: "failed",
      jobs: [{ executionStepId: queued.id, status: "blocked" }],
    });
    assert.equal(
      fromJob.nodes.find((item) => item.id === "done")?.state,
      "not-reached",
    );
    const skipped = overlayExecutionOnGraph(
      graph,
      [sampleStep({ nodeId: "seed", status: "skipped" })],
      { runStatus: "failed" },
    );
    assert.equal(
      skipped.nodes.find((item) => item.id === "seed")?.state,
      "skipped",
    );
  });

  it("never projects invalid YAML as a guessed graph", () => {
    assert.equal(summaryFromPublishedYaml(INVALID_WORKFLOW_YAML), null);
    assert.equal(
      projectPinnedVersionGraph({
        yaml: INVALID_WORKFLOW_YAML,
        catalog,
      }),
      null,
    );
  });
});

describe("compare redaction", () => {
  it("diffs redacted summaries and never keeps plaintext secrets", () => {
    const left = sampleDetail({
      input: { dryRun: true, token: "hunter2" },
      policySnapshot: { revision: 1, kubeconfig: "-----BEGIN FAKE-----" },
    });
    const right = sampleDetail({
      ...sampleRecord({
        id: OTHER_EXECUTION_ID,
        workflowVersionId: OTHER_VERSION_ID,
        workflowDigest: "sha256:ffffffffffff",
        status: "failed",
      }),
      input: { dryRun: false, token: "hunter2" },
      policySnapshot: { revision: 2 },
      steps: [
        sampleStep({
          status: "failed",
          output: { password: "should-not-leak" },
        }),
      ],
    });
    const result = compareRedactedExecutions(left, right);
    assert.equal(result.redacted, true);
    assert.equal(result.digestMatch, false);
    assert.equal(result.equal, false);
    assert.ok(result.changes.some((change) => change.path === "status"));
    assert.ok(result.changes.some((change) => change.path === "input.dryRun"));
    assert.equal(compareContainsPlaintextSecret(result, "hunter2"), false);
    assert.equal(compareContainsPlaintextSecret(result, "should-not-leak"), false);
    assert.equal(compareContainsPlaintextSecret(result, "BEGIN FAKE"), false);
    assert.equal(JSON.stringify(result).includes("hunter2"), false);
  });
});

describe("keyboard and error navigation", () => {
  it("moves history focus and activates on Enter", () => {
    assert.deepEqual(historyKeyAction("ArrowDown", 0, 3), { index: 1, activate: false });
    assert.deepEqual(historyKeyAction("ArrowUp", 0, 3), { index: 0, activate: false });
    assert.deepEqual(historyKeyAction("End", 0, 3), { index: 2, activate: false });
    assert.deepEqual(historyKeyAction("Home", 2, 3), { index: 0, activate: false });
    assert.deepEqual(historyKeyAction("Enter", 1, 3), { index: 1, activate: true });
    assert.deepEqual(historyKeyAction(" ", 1, 3), { index: 1, activate: true });
  });

  it("builds keyboard-reachable error links for failed and indeterminate steps", () => {
    const links = executionErrorNavLinks({
      problem: {
        type: "urn:flowforge:problem:conflict",
        title: "Conflict",
        status: 409,
        detail: "retry rejected",
        instance: "/api/v1/executions/x/retry",
        code: "conflict",
        request_id: "conflict-req-16xx",
      },
      steps: [
        sampleStep({ nodeId: "seed", status: "failed" }),
        sampleStep({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          nodeId: "done",
          status: "indeterminate",
        }),
      ],
    });
    assert.equal(links[0]?.href, "#execution-errors");
    assert.ok(links.some((link) => link.href === "#replay-node-seed"));
    assert.ok(links.some((link) => /Indeterminate/.test(link.label)));
    assert.ok(links.some((link) => /Failed/.test(link.label)));
  });
});

describe("approval wait is durable in E10.3", () => {
  it("enables durable wait and keeps resume as decide", () => {
    const controls = approvalWaitControls();
    assert.equal(controls.waitEnabled, true);
    assert.equal(controls.resumeEnabled, false);
    assert.match(controls.waitHelp, /survives/);
    assert.match(controls.resumeHelp, /decide/);
  });
});

function gateApproval(status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    status,
    binding: {
      workflowVersionId: VERSION_ID,
      workflowVersionDigest: "",
      targetId: "",
      targetKind: "",
      targetName: "",
      targetVersionId: "",
      targetDigest: "",
      policyResourceId: "",
      policyRevisionId: "",
      policyRevisionNumber: null,
      policyDigest: "",
      operation: "deploy",
      nodeId: "seed",
      nodeName: "Gate",
      expiresAt: "",
      bindingFingerprint: "",
    },
    validity: {
      current: status === "pending",
      reason: status === "pending" ? "pending" : "",
      changedFields: [],
      currentBinding: null,
    },
    requestedBy: "",
    requestedAt: "",
    decidedBy: "",
    decidedAt: "",
    note: "",
    workflowId: WORKFLOW_ID,
    workflowName: "Deploy",
    executionId: EXECUTION_ID,
    executionStatus: "",
    approverRole: "approver",
    permittedActions: ["approve", "reject"],
  };
}

describe("terminal runs do not look like they are waiting on approval", () => {
  it("keeps a canceled gate on its step status when an approval is still pending", () => {
    const graph = projectPinnedVersionGraph({
      yaml: STARTER_WORKFLOW_YAML,
      catalog,
    });
    assert.ok(graph);
    const steps = [sampleStep({ nodeId: "seed", status: "canceled", nodeType: "flow.approval" })];
    const waiting = waitingApprovalNodeIds([gateApproval("pending")], "canceled");
    assert.deepEqual(waiting, []);
    const overlaid = overlayExecutionOnGraph(graph, steps, {
      waitingApprovalNodeIds: ["seed"],
      runStatus: "canceled",
    });
    assert.equal(overlaid.nodes.find((node) => node.id === "seed")?.state, "canceled");
    assert.equal(
      overlaid.nodes.find((node) => node.id === "seed")?.state === "approval-required",
      false,
    );
    const views = replayStepViews(steps, {
      waitingApprovalNodeIds: ["seed"],
      runStatus: "canceled",
    });
    assert.equal(views[0]?.waiting, false);
    assert.equal(views[0]?.presentation.label, "Canceled");
    assert.equal(currentReplayNodeId([], ["seed"], "canceled"), null);
    assert.equal(currentReplayNodeId([], ["seed"], "running"), "seed");
  });

  it("does the same for a failed run and a deleted workflow", () => {
    const graph = projectPinnedVersionGraph({
      yaml: STARTER_WORKFLOW_YAML,
      catalog,
    });
    assert.ok(graph);
    const steps = [
      sampleStep({
        nodeId: "seed",
        status: "awaiting_approval",
        nodeType: "flow.approval",
      }),
    ];
    for (const runStatus of ["failed", "canceled"]) {
      const overlaid = overlayExecutionOnGraph(graph, steps, {
        waitingApprovalNodeIds: waitingApprovalNodeIds(
          [gateApproval("pending")],
          runStatus,
        ),
        runStatus,
      });
      const state = overlaid.nodes.find((node) => node.id === "seed")?.state;
      assert.equal(state === "approval-required", false, runStatus);
      const views = replayStepViews(steps, {
        waitingApprovalNodeIds: ["seed"],
        runStatus,
      });
      assert.equal(views[0]?.waiting, false, runStatus);
    }
    const deleted = overlayExecutionOnGraph(graph, steps, {
      waitingApprovalNodeIds: ["seed"],
      runStatus: "failed",
    });
    assert.equal(
      deleted.nodes.find((node) => node.id === "seed")?.state === "approval-required",
      false,
    );
  });

  it("uses generic failed wording for an unknown gate error code", () => {
    const generic = executionStatusPresentation("failed").description;
    const unknown = "approver-requirement-changed";
    const explosive: { code?: string } = {};
    Object.defineProperty(explosive, "code", {
      get() {
        throw new Error("unknown code blew up");
      },
    });
    const cases = [
      { code: unknown },
      { code: "workflow_deleted" },
      { code: { nested: true } },
      null,
      "not-an-object",
      explosive,
    ];
    for (const error of cases) {
      const copy = gateStepFailureCopy({
        nodeType: "flow.approval",
        status: "failed",
        error,
      });
      assert.equal(copy, generic);
      assert.equal(copy?.includes(unknown), false);
      assert.equal(copy?.includes("workflow_deleted"), false);
    }
    assert.equal(
      gateStepFailureCopy({
        nodeType: "flow.approval",
        status: "waiting",
        error: { code: unknown },
      }),
      null,
    );
    assert.equal(
      gateStepFailureCopy({
        nodeType: "data.set",
        status: "failed",
        error: { code: unknown },
      }),
      null,
    );
    const views = replayStepViews(
      [
        sampleStep({
          nodeId: "gate",
          nodeType: "flow.approval",
          status: "failed",
          error: { code: unknown, message: "pinned approver changed" },
        }),
      ],
      { runStatus: "failed" },
    );
    assert.equal(views[0]?.failureText, generic);
    assert.equal(views[0]?.presentation.label, "Failed");
    assert.equal(views[0]?.failureText?.includes(unknown), false);
    const detail = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../components/executions/ExecutionDetail.tsx"),
      "utf8",
    );
    const replay = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../components/executions/ExecutionReplay.tsx"),
      "utf8",
    );
    assert.match(detail, /gateStepFailureCopy\(step\)/);
    assert.match(replay, /selected\.failureText/);
  });

  it("treats a closed approval as not waiting on a live run", () => {
    assert.deepEqual(waitingApprovalNodeIds([gateApproval("canceled")], "running"), []);
    assert.deepEqual(
      waitingApprovalNodeIds([gateApproval("pending")], "running"),
      ["seed"],
    );
  });
});
