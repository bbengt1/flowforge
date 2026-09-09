import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXECUTION_UPSTREAM_COLLECTION,
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_REPLAY_MESSAGE,
  executionAuditEventsPath,
  executionHistoryHref,
  executionJobsPath,
  executionPath,
  executionStepPath,
  executionStepsPath,
  listExecutionsPath,
  listWorkflowExecutionsPath,
  listWorkspaceAuditEventsPath,
  retargetCollectionPath,
  retargetExecutionApiPath,
} from "./execution-contract.ts";
import {
  canSeeExecutionsNav,
  executionDetailDisplay,
  executionDetailText,
  executionListDisplay,
  executionListText,
  executionStatusLabel,
  filterExecutionList,
  isExecutionForbidden,
  isIdempotencyConflict,
  isIndeterminateStatus,
  isSecretFieldName,
  parseExecutionDetail,
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

  it("surfaces indeterminate distinctly and filters by documented query only", () => {
    assert.equal(isIndeterminateStatus("indeterminate"), true);
    assert.equal(isIndeterminateStatus("failed"), false);
    assert.equal(executionStatusLabel("cancelled"), "canceled");

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
