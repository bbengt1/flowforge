import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANCEL_APPLIED_MESSAGE,
  CANCEL_FORBIDDEN_MESSAGE,
  CANCEL_IDEMPOTENT_MESSAGE,
  EXECUTION_CANCEL_ACTION,
  EXECUTION_API_PR,
  EXECUTION_RETRY_ROUTE_PUBLISHED,
  EXECUTION_UPSTREAM_COLLECTION,
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_REPLAY_MESSAGE,
  INDETERMINATE_STATUS_HELP,
  RETRY_INDETERMINATE_MESSAGE,
  RETRY_UNAVAILABLE_MESSAGE,
  buildCancelBody,
  buildRetryBody,
  executionAuditEventsPath,
  executionCancelPath,
  executionHistoryHref,
  executionJobsPath,
  executionPath,
  executionRetryPath,
  executionStepPath,
  executionStepRetryPath,
  executionStepsPath,
  listExecutionsPath,
  listWorkflowExecutionsPath,
  listWorkspaceAuditEventsPath,
  retargetCollectionPath,
  retargetExecutionApiPath,
  workflowExecutionCancelPath,
} from "./execution-contract.ts";
import {
  canCancelExecution,
  canRetryExecution,
  canRetryExecutionStep,
  canSeeExecutionsNav,
  isCoreRetryableStepKind,
  cancelOutcomeMessage,
  executionDetailDisplay,
  executionDetailText,
  executionListDisplay,
  executionListText,
  executionStatusLabel,
  executionStatusPresentation,
  filterExecutionList,
  isExecutionForbidden,
  isIdempotencyConflict,
  isIdempotentCancel,
  isIndeterminateStatus,
  isSecretFieldName,
  jobDispatchView,
  parseExecutionDetail,
  parseExecutionJob,
  parseExecutionList,
  startOutcomeMessage,
  stripSecretFields,
} from "./execution.ts";
import type { ExecutionDetail, ExecutionRecord } from "./execution-types.ts";

const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function sampleRecord(
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
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
    triggerId: "",
    input: { dryRun: "[redacted]" },
    policySnapshot: null,
    permittedActions: [],
    ...overrides,
  };
}

describe("execution contract adapter", () => {
  it("builds only documented #51 list query params and nested GET paths", () => {
    assert.equal(listExecutionsPath(), "/executions");
    assert.equal(
      listExecutionsPath({
        workflowId: WORKFLOW_ID,
        status: "indeterminate",
        limit: 25,
      }),
      `/executions?workflowId=${WORKFLOW_ID}&status=indeterminate&limit=25`,
    );
    assert.equal(
      listWorkflowExecutionsPath(WORKFLOW_ID, { status: "queued", limit: 10 }),
      `/workflows/${WORKFLOW_ID}/executions?status=queued&limit=10`,
    );
    assert.equal(executionPath(EXECUTION_ID), `/executions/${EXECUTION_ID}`);
    assert.equal(
      executionStepsPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/steps`,
    );
    assert.equal(
      executionStepPath(EXECUTION_ID, VERSION_ID),
      `/executions/${EXECUTION_ID}/steps/${VERSION_ID}`,
    );
    assert.equal(
      executionJobsPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/jobs`,
    );
    assert.equal(
      executionAuditEventsPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/audit-events`,
    );
    assert.equal(
      listWorkspaceAuditEventsPath({
        resourceType: "execution",
        resourceId: EXECUTION_ID,
      }),
      `/audit-events?resourceType=execution&resourceId=${EXECUTION_ID}`,
    );
    assert.equal(
      executionHistoryHref(EXECUTION_ID, WORKFLOW_ID),
      `/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
    assert.equal(
      listExecutionsPath({
        workflowId: WORKFLOW_ID,
        status: "queued",
      }).includes("startedAfter"),
      false,
    );
    assert.equal(
      executionCancelPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/${EXECUTION_CANCEL_ACTION}`,
    );
    assert.equal(
      workflowExecutionCancelPath(WORKFLOW_ID, EXECUTION_ID),
      `/workflows/${WORKFLOW_ID}/executions/${EXECUTION_ID}/cancel`,
    );
    assert.deepEqual(buildCancelBody(), {});
    assert.equal(Object.hasOwn(buildCancelBody(), "id"), false);
    assert.equal(Object.hasOwn(buildCancelBody(), "workspaceId"), false);
    assert.equal(EXECUTION_API_PR, 53);
    assert.equal(EXECUTION_RETRY_ROUTE_PUBLISHED, true);
    assert.equal(
      executionRetryPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/retry`,
    );
    assert.equal(
      executionStepRetryPath(EXECUTION_ID, VERSION_ID),
      `/executions/${EXECUTION_ID}/steps/${VERSION_ID}/retry`,
    );
    assert.deepEqual(buildRetryBody(), {});
    assert.deepEqual(buildRetryBody({ stepId: VERSION_ID }), {
      stepId: VERSION_ID,
    });
    assert.equal(Object.hasOwn(buildRetryBody(), "workspaceId"), false);
  });

  it("retargets /api/v1/executions and leaves /audit-events unchanged", () => {
    assert.equal(EXECUTION_UPSTREAM_COLLECTION, "executions");
    assert.equal(
      retargetExecutionApiPath("/api/v1/executions"),
      "/api/v1/executions",
    );
    assert.equal(
      retargetExecutionApiPath(`/api/v1/executions/${EXECUTION_ID}/audit-events`),
      `/api/v1/executions/${EXECUTION_ID}/audit-events`,
    );
    assert.equal(
      retargetExecutionApiPath("/api/v1/audit-events"),
      "/api/v1/audit-events",
    );
    assert.equal(
      retargetCollectionPath(
        `/api/v1/executions/${EXECUTION_ID}`,
        "executions",
        "workspace/executions",
      ),
      `/api/v1/workspace/executions/${EXECUTION_ID}`,
    );
    assert.equal(
      retargetExecutionApiPath(`/api/v1/executions/${EXECUTION_ID}/cancel`),
      `/api/v1/executions/${EXECUTION_ID}/cancel`,
    );
  });
});

describe("execution redaction and list/detail rendering", () => {
  it("keeps documented input/output and strips unexpected secret fields", () => {
    assert.equal(isSecretFieldName("kubeconfig"), true);
    assert.equal(isSecretFieldName("privateKey"), true);
    assert.equal(isSecretFieldName("output"), false);
    assert.equal(isSecretFieldName("input"), false);
    assert.equal(isSecretFieldName("details"), false);
    assert.equal(isSecretFieldName("secret"), true);
    assert.equal(isSecretFieldName("correlationId"), false);
    assert.equal(isSecretFieldName("idempotencyKey"), false);
    assert.equal(isSecretFieldName("replayed"), false);
    assert.equal(isSecretFieldName("fencingToken"), false);

    const strippedKeys: string[] = [];
    const cleaned = stripSecretFields(
      {
        id: EXECUTION_ID,
        kubeconfig: "apiVersion: v1",
        input: { apiKey: "[redacted]" },
        output: { result: "[redacted]", privateKey: "-----BEGIN" },
      },
      strippedKeys,
    ) as Record<string, unknown>;
    assert.equal(cleaned.kubeconfig, undefined);
    assert.deepEqual(cleaned.input, { apiKey: "[redacted]" });
    assert.deepEqual(cleaned.output, { result: "[redacted]" });
    assert.ok(strippedKeys.some((key) => key.includes("kubeconfig")));
    assert.ok(strippedKeys.some((key) => key.includes("privateKey")));
  });

  it("parses list/detail, shows [redacted], and never renders unredacted secrets", () => {
    const list = parseExecutionList({
      items: [
        {
          id: EXECUTION_ID,
          workflowId: WORKFLOW_ID,
          workflowName: "rollout",
          workflowVersionId: VERSION_ID,
          workflowDigest: "sha256:abcdef0123456789",
          status: "indeterminate",
          startedAt: "2026-09-09T01:00:00.000Z",
          finishedAt: "2026-09-09T01:02:00.000Z",
          createdAt: "2026-09-09T01:00:00.000Z",
          correlationId: "corr-16-characters",
          idempotencyKey: "deploy-prod-1",
          replayed: true,
          input: { token: "[redacted]" },
          secret: "should-not-leak",
          kubeconfig: "apiVersion: v1\nkind: Config",
        },
      ],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.status, "indeterminate");
    assert.equal(list[0]?.replayed, true);
    assert.deepEqual(list[0]?.input, { token: "[redacted]" });

    const rendered = executionListText(list);
    assert.match(rendered, /indeterminate/);
    assert.match(rendered, /corr-16-characters/);
    assert.match(rendered, /deploy-prod-1/);
    assert.match(rendered, /did not start a second/);
    assert.equal(rendered.includes("should-not-leak"), false);
    assert.equal(rendered.includes("kind: Config"), false);

    const rows = executionListDisplay(list);
    assert.equal(rows[0]?.indeterminate, true);
    assert.equal(rows[0]?.replayed, true);

    const detail = parseExecutionDetail({
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      workflowName: "rollout",
      status: "failed",
      createdAt: "2026-09-09T01:00:00.000Z",
      correlationId: "corr-16-characters",
      replayed: false,
      input: { secret: "[redacted]" },
      token: "bearer-secret",
      pins: [
        {
          kind: "cluster_target",
          resourceId: WORKFLOW_ID,
          versionId: VERSION_ID,
          versionNumber: 2,
          name: "prod",
        },
      ],
      steps: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          nodeId: "apply",
          nodeType: "kubernetes.apply",
          status: "indeterminate",
          attempt: 1,
          input: {},
          output: { kubeconfig: "[redacted]", applied: true },
          error: {},
        },
      ],
      jobs: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          status: "queued",
          executionStepId: "44444444-4444-4444-8444-444444444444",
        },
      ],
      auditEvents: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          action: "execution.started",
          outcome: "ok",
          details: { password: "[redacted]", reason: "lease-lost" },
        },
      ],
    });
    assert.ok(detail);
    const view = executionDetailDisplay(detail as ExecutionDetail);
    assert.equal(view.steps[0]?.status, "indeterminate");
    assert.equal(view.pins[0]?.name, "prod");
    assert.equal(view.auditEvents.length, 1);
    const text = executionDetailText(detail as ExecutionDetail);
    assert.match(text, /\[redacted\]/);
    assert.match(text, /lease-lost/);
    assert.match(text, /applied/);
    assert.equal(text.includes("bearer-secret"), false);
    assert.equal(text.includes("-----BEGIN"), false);
  });

  it("surfaces running/canceled/failed/indeterminate with icon+text, not color alone", () => {
    const indeterminate = executionStatusPresentation("indeterminate");
    assert.equal(indeterminate.indeterminate, true);
    assert.equal(indeterminate.icon, "⚠");
    assert.equal(indeterminate.label, "Indeterminate");
    assert.equal(indeterminate.description, INDETERMINATE_STATUS_HELP);
    assert.match(indeterminate.description, /may have occurred/);
    assert.match(indeterminate.description, /Do not assume the action did not run/);
    assert.equal(
      /the action did not (run|occur)\./i.test(indeterminate.description) &&
        !indeterminate.description.includes("Do not assume"),
      false,
    );

    const running = executionStatusPresentation("running");
    assert.equal(running.icon, "▶");
    assert.equal(running.label, "Running");
    const canceled = executionStatusPresentation("cancelled");
    assert.equal(canceled.icon, "◼");
    assert.equal(canceled.label, "Canceled");
    const failed = executionStatusPresentation("failed");
    assert.equal(failed.icon, "✕");
    assert.equal(failed.label, "Failed");

    const rendered = executionListText([
      sampleRecord({ status: "indeterminate" }),
    ]);
    assert.match(rendered, /⚠/);
    assert.match(rendered, /Indeterminate/);
    assert.match(rendered, /indeterminate/);
  });

  it("surfaces lease/claim/heartbeat metadata and gates retry to #53", () => {
    const job = parseExecutionJob({
      id: "55555555-5555-4555-8555-555555555555",
      status: "claimed",
      executionStepId: "44444444-4444-4444-8444-444444444444",
      leaseId: "lease-16",
      leaseExpiresAt: "2026-09-09T01:05:00.000Z",
      heartbeatAt: "2026-09-09T01:04:00.000Z",
      workerId: "worker-a",
      fencingToken: 7,
      attempt: 1,
    });
    assert.ok(job);
    const view = jobDispatchView(job);
    assert.equal(view.claimed, true);
    assert.equal(view.presentation.label, "Claimed");
    assert.equal(view.leaseExpiresAt, "2026-09-09T01:05:00.000Z");
    assert.equal(view.heartbeatAt, "2026-09-09T01:04:00.000Z");
    assert.equal(view.workerId, "worker-a");
    assert.equal(view.fencingToken, 7);
    assert.equal(isCoreRetryableStepKind("data.set"), true);
    assert.equal(isCoreRetryableStepKind("flow.delay"), true);
    assert.equal(isCoreRetryableStepKind("kubernetes.apply"), false);
    assert.equal(
      canRetryExecution({
        status: "failed",
        permissions: ["workflow.execute"],
        steps: [{ status: "failed", nodeType: "data.set" }],
      }),
      true,
    );
    assert.equal(
      canRetryExecution({
        status: "indeterminate",
        permissions: ["workflow.execute"],
        steps: [{ status: "indeterminate", nodeType: "data.set" }],
      }),
      false,
    );
    assert.equal(
      canRetryExecution({
        status: "failed",
        permissions: ["workflow.execute"],
        steps: [{ status: "failed", nodeType: "kubernetes.apply" }],
      }),
      false,
    );
    assert.equal(
      canRetryExecutionStep({
        permissions: ["workflow.execute"],
        executionStatus: "failed",
        stepStatus: "failed",
        nodeType: "flow.fail",
      }),
      true,
    );
    assert.equal(
      canRetryExecutionStep({
        permissions: ["workflow.execute"],
        executionStatus: "indeterminate",
        stepStatus: "failed",
        nodeType: "data.set",
      }),
      false,
    );
    assert.match(RETRY_UNAVAILABLE_MESSAGE, /data\.\* \/ flow\.\*/);
    assert.match(RETRY_INDETERMINATE_MESSAGE, /Do not assume the action did not run/);
  });

  it("authorizes cancel separately and treats a second cancel as idempotent", () => {
    assert.equal(
      canCancelExecution({
        permissions: ["execution.view"],
        status: "running",
      }),
      false,
    );
    assert.equal(
      canCancelExecution({
        permissions: ["execution.view", "execution.cancel"],
        status: "running",
      }),
      true,
    );
    assert.equal(
      canCancelExecution({
        permissions: ["execution.cancel"],
        status: "succeeded",
      }),
      false,
    );
    assert.equal(
      canCancelExecution({
        permissions: ["execution.cancel"],
        status: "queued",
      }),
      true,
    );
    assert.equal(
      canCancelExecution({
        permissions: ["execution.cancel"],
        status: "indeterminate",
      }),
      false,
    );
    assert.equal(
      canCancelExecution({
        permissions: ["execution.cancel"],
        status: "succeeded",
        permittedActions: ["cancel"],
      }),
      false,
    );
    assert.equal(
      isIdempotentCancel({ previousStatus: "canceled", status: "canceled" }),
      true,
    );
    assert.equal(
      cancelOutcomeMessage({ previousStatus: "canceled", status: "canceled" }),
      CANCEL_IDEMPOTENT_MESSAGE,
    );
    assert.equal(
      cancelOutcomeMessage({ previousStatus: "running", status: "canceled" }),
      CANCEL_APPLIED_MESSAGE,
    );
    assert.match(CANCEL_FORBIDDEN_MESSAGE, /fail-closed/);
  });

  it("surfaces indeterminate distinctly and filters by documented query only", () => {
    assert.equal(isIndeterminateStatus("indeterminate"), true);
    assert.equal(isIndeterminateStatus("failed"), false);
    assert.equal(executionStatusLabel("cancelled"), "Canceled");

    const items = [
      sampleRecord(),
      sampleRecord({
        id: "44444444-4444-4444-8444-444444444444",
        status: "indeterminate",
        workflowId: "55555555-5555-4555-8555-555555555555",
      }),
    ];
    assert.equal(
      filterExecutionList(items, { status: "indeterminate" }).length,
      1,
    );
    assert.equal(
      filterExecutionList(items, { workflowId: WORKFLOW_ID }).length,
      1,
    );
    assert.equal(filterExecutionList(items, { limit: 1 }).length, 1);
  });

  it("surfaces 201 vs 200 replay and 409 key conflict copy", () => {
    const replayed = sampleRecord({ replayed: true });
    const view = executionDetailDisplay({
      ...replayed,
      pins: [],
      steps: [],
      jobs: [],
      auditEvents: [],
    });
    assert.equal(view.replayedMessage, IDEMPOTENCY_REPLAY_MESSAGE);
    assert.equal(startOutcomeMessage(200, true), IDEMPOTENCY_REPLAY_MESSAGE);
    assert.equal(startOutcomeMessage(201, false), IDEMPOTENCY_CREATED_MESSAGE);
    assert.equal(
      isIdempotencyConflict({
        type: "urn:flowforge:problem:conflict",
        title: "Conflict",
        status: 409,
        detail: "idempotency fingerprint mismatch",
        instance: "/api/v1/workflows/x/executions",
        code: "conflict",
        request_id: "conflict-req-16xx",
      }),
      true,
    );
    assert.match(IDEMPOTENCY_CONFLICT_MESSAGE, /409/);
  });
});

describe("execution RBAC fail-closed", () => {
  it("hides nav without execution.view and treats 403 as forbidden", () => {
    assert.equal(canSeeExecutionsNav(null), true);
    assert.equal(canSeeExecutionsNav(["workflow.view"]), false);
    assert.equal(canSeeExecutionsNav(["execution.view"]), true);
    assert.equal(
      isExecutionForbidden({
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "missing execution.view",
        instance: "/api/v1/executions",
        code: "forbidden",
        request_id: "req-id-16charsxx",
      }),
      true,
    );
  });
});
