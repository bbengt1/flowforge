import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXECUTION_UPSTREAM_COLLECTION,
  IDEMPOTENCY_REPLAY_MESSAGE,
  executionEventsPath,
  executionHistoryHref,
  executionJobsPath,
  executionPath,
  executionStepsPath,
  listExecutionsPath,
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
  isIndeterminateStatus,
  isSecretFieldName,
  parseExecutionDetail,
  parseExecutionList,
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
    correlationId: "corr-16-characters",
    idempotencyKey: "deploy-prod-1",
    reused: false,
    requestedBy: "operator-chloe",
    triggerId: "",
    ...overrides,
  };
}

describe("execution contract adapter", () => {
  it("builds list query params and nested GET paths under /executions", () => {
    assert.equal(listExecutionsPath(), "/executions");
    assert.equal(
      listExecutionsPath({
        workflowId: WORKFLOW_ID,
        status: "indeterminate",
        startedAfter: "2026-09-01T00:00:00.000Z",
        startedBefore: "2026-09-09T00:00:00.000Z",
      }),
      `/executions?workflowId=${WORKFLOW_ID}&status=indeterminate&startedAfter=2026-09-01T00%3A00%3A00.000Z&startedBefore=2026-09-09T00%3A00%3A00.000Z`,
    );
    assert.equal(executionPath(EXECUTION_ID), `/executions/${EXECUTION_ID}`);
    assert.equal(
      executionStepsPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/steps`,
    );
    assert.equal(
      executionJobsPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/jobs`,
    );
    assert.equal(
      executionEventsPath(EXECUTION_ID),
      `/executions/${EXECUTION_ID}/events`,
    );
    assert.equal(
      executionHistoryHref(EXECUTION_ID, WORKFLOW_ID),
      `/executions/${EXECUTION_ID}?workflowId=${WORKFLOW_ID}`,
    );
  });

  it("retargets /api/v1/executions when the upstream collection changes", () => {
    assert.equal(EXECUTION_UPSTREAM_COLLECTION, "executions");
    assert.equal(
      retargetExecutionApiPath("/api/v1/executions"),
      "/api/v1/executions",
    );
    assert.equal(
      retargetExecutionApiPath(`/api/v1/executions/${EXECUTION_ID}/events`),
      `/api/v1/executions/${EXECUTION_ID}/events`,
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
  it("treats unexpected secret fields as bugs to strip", () => {
    assert.equal(isSecretFieldName("kubeconfig"), true);
    assert.equal(isSecretFieldName("privateKey"), true);
    assert.equal(isSecretFieldName("output"), true);
    assert.equal(isSecretFieldName("secret"), true);
    assert.equal(isSecretFieldName("correlationId"), false);
    assert.equal(isSecretFieldName("idempotencyKey"), false);
    assert.equal(isSecretFieldName("fencingToken"), false);
    assert.equal(isSecretFieldName("workflowVersionId"), false);

    const strippedKeys: string[] = [];
    const cleaned = stripSecretFields(
      {
        id: EXECUTION_ID,
        kubeconfig: "apiVersion: v1",
        output: { token: "super-secret-token" },
        outputRedacted: { result: "ok" },
      },
      strippedKeys,
    ) as Record<string, unknown>;
    assert.equal(cleaned.kubeconfig, undefined);
    assert.equal(cleaned.output, undefined);
    assert.deepEqual(cleaned.outputRedacted, { result: "ok" });
    assert.ok(strippedKeys.some((key) => key.includes("kubeconfig")));
    assert.ok(strippedKeys.some((key) => key.includes("output")));
  });

  it("parses list/detail and never renders unredacted secrets", () => {
    const list = parseExecutionList({
      items: [
        {
          id: EXECUTION_ID,
          workflowId: WORKFLOW_ID,
          workflowName: "rollout",
          workflowVersionId: VERSION_ID,
          workflowVersionNumber: 3,
          workflowDigest: "sha256:abcdef0123456789",
          status: "indeterminate",
          startedAt: "2026-09-09T01:00:00.000Z",
          finishedAt: "2026-09-09T01:02:00.000Z",
          correlationId: "corr-16-characters",
          idempotencyKey: "deploy-prod-1",
          reused: true,
          secret: "should-not-leak",
          kubeconfig: "apiVersion: v1\nkind: Config",
        },
      ],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.status, "indeterminate");
    assert.equal(list[0]?.reused, true);

    const rendered = executionListText(list);
    assert.match(rendered, /indeterminate/);
    assert.match(rendered, /corr-16-characters/);
    assert.match(rendered, /deploy-prod-1/);
    assert.match(rendered, /v3/);
    assert.equal(rendered.includes("should-not-leak"), false);
    assert.equal(rendered.includes("kind: Config"), false);
    assert.equal(rendered.includes("apiVersion"), false);

    const rows = executionListDisplay(list);
    assert.equal(rows[0]?.indeterminate, true);
    assert.equal(rows[0]?.reused, true);

    const detail = parseExecutionDetail({
      id: EXECUTION_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      workflowName: "rollout",
      status: "failed",
      correlationId: "corr-16-characters",
      token: "bearer-secret",
      steps: [
        {
          id: "step-1",
          nodeId: "apply",
          nodeType: "kubernetes.apply",
          status: "indeterminate",
          output: { kubeconfig: "cluster-admin" },
          outputRedacted: { applied: true },
        },
      ],
      jobs: [{ id: "job-1", status: "lost-lease", workerId: "worker-a" }],
      events: [
        {
          id: "evt-1",
          action: "execution.started",
          outcome: "ok",
          details: { password: "hunter2" },
          detailsRedacted: { reason: "lease-lost" },
        },
      ],
    });
    assert.ok(detail);
    const view = executionDetailDisplay(detail as ExecutionDetail);
    assert.equal(view.steps[0]?.status, "indeterminate");
    const text = executionDetailText(detail as ExecutionDetail);
    assert.match(text, /lease-lost/);
    assert.match(text, /applied/);
    assert.equal(text.includes("bearer-secret"), false);
    assert.equal(text.includes("cluster-admin"), false);
    assert.equal(text.includes("hunter2"), false);
  });

  it("surfaces indeterminate distinctly and filters by workflow/status/time", () => {
    assert.equal(isIndeterminateStatus("indeterminate"), true);
    assert.equal(isIndeterminateStatus("failed"), false);
    assert.equal(executionStatusLabel("cancelled"), "canceled");

    const items = [
      sampleRecord(),
      sampleRecord({
        id: "44444444-4444-4444-8444-444444444444",
        status: "indeterminate",
        workflowId: "55555555-5555-4555-8555-555555555555",
        startedAt: "2026-09-01T00:00:00.000Z",
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
    assert.equal(
      filterExecutionList(items, {
        startedAfter: "2026-09-08T00:00:00.000Z",
      }).length,
      1,
    );
  });

  it("surfaces idempotent replay copy when the API reused a run", () => {
    const reused = sampleRecord({ reused: true });
    const view = executionDetailDisplay({
      ...reused,
      inputRedacted: { dryRun: true },
      steps: [],
      jobs: [],
      events: [],
    });
    assert.equal(view.reusedMessage, IDEMPOTENCY_REPLAY_MESSAGE);
    assert.match(executionListText([reused]), /did not start a second/);
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
    assert.equal(
      isExecutionForbidden({
        type: "urn:flowforge:problem:not-found",
        title: "Not Found",
        status: 404,
        detail: "missing",
        instance: "/api/v1/executions",
        code: "not-found",
        request_id: "req-id-16charsxx",
      }),
      false,
    );
  });
});
