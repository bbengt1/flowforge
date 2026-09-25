import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ApprovalClientFailure } from "./approval-client.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import {
  executionDetailDisplayedProblem,
  forbiddenPollCache,
  loadExecutionContextCache,
  loadExecutionHistoryCache,
  loadWorkspacePermissionsCache,
  mergePolledExecution,
  type ExecutionContextCache,
  type ExecutionHistoryCache,
} from "./execution-detail-query.ts";
import {
  WORKFLOW_DELETED_GRAPH_MESSAGE,
  graphReplayMessage,
  replayStepViews,
} from "./execution-replay.ts";
import type { ExecutionDetail, ExecutionStep } from "./execution-types.ts";
import { emptyDevIdentity, type DevIdentity } from "./identity-headers.ts";
import type { ProblemDetails } from "./problem.ts";
import type { WorkflowClientFailure } from "./workflow-client.ts";

const identity: DevIdentity = {
  ...emptyDevIdentity(),
  issuer: "https://issuer.example",
  subject: "user-1",
  tenantId: "tenant-1",
  workbenchKey: "bench",
};

function problem(status: number, code = "upstream-error", detail = "failed"): ProblemDetails {
  return {
    type: "urn:flowforge:problem:test",
    title: "Test",
    status,
    detail,
    instance: "/executions/exec-1",
    code,
    request_id: "req-test",
  };
}

function execution(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    id: "exec-1",
    workflowId: "wf-1",
    workflowName: "rollout",
    workflowSlug: "rollout",
    workflowVersionId: "ver-1",
    workflowVersionNumber: 3,
    workflowDigest: "sha256:abc",
    status: "running",
    startedAt: "",
    finishedAt: "",
    createdAt: "",
    updatedAt: "",
    retentionUntil: "",
    correlationId: "corr",
    idempotencyKey: "deploy-prod-1",
    replayed: false,
    requestedBy: "operator",
    triggerId: "",
    input: { dryRun: true },
    policySnapshot: null,
    permittedActions: ["execution.view"],
    pins: [],
    steps: [],
    jobs: [],
    auditEvents: [],
    artifacts: [],
    legalHold: false,
    ...overrides,
  };
}

describe("execution detail query cache", () => {
  it("strips secrets, fails closed on 403 without retry, and keeps the last detail on 5xx", async () => {
    let calls = 0;
    const loaded = await loadExecutionHistoryCache(
      identity,
      "exec-1",
      "wf-1",
      undefined,
      {
        delay: () => 0,
        loadHistory: async () => {
          calls += 1;
          return {
            ok: true,
            statusCode: 200,
            requestId: "req-ok",
            strippedKeys: [],
            execution: execution({
              input: { dryRun: true, password: "hunter2" },
            }),
          };
        },
      },
    );
    assert.equal(calls, 1);
    const input = loaded.detail?.input as { dryRun?: boolean; password?: string };
    assert.equal(input.dryRun, true);
    assert.equal(input.password, undefined);
    assert.equal(
      loaded.strippedKeys.some((key) => key.endsWith("password")),
      true,
    );

    calls = 0;
    const forbidden = await loadExecutionHistoryCache(
      identity,
      "exec-1",
      "wf-1",
      loaded,
      {
        delay: () => 0,
        loadHistory: async () => {
          calls += 1;
          return {
            ok: false,
            statusCode: 403,
            requestId: "req-403",
            forbidden: true,
            strippedKeys: [],
            problem: problem(403, "forbidden", "Bearer super-secret"),
          };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(forbidden.detail, null);
    assert.equal(forbidden.forbidden, true);
    assert.equal(forbidden.problem?.detail.includes("Bearer"), false);

    calls = 0;
    const previous: ExecutionHistoryCache = {
      ...loaded,
      detail: execution({ status: "running" }),
      problem: null,
      forbidden: false,
    };
    const outage = await loadExecutionHistoryCache(
      identity,
      "exec-1",
      "wf-1",
      previous,
      {
        delay: () => 0,
        loadHistory: async () => {
          calls += 1;
          return {
            ok: false,
            statusCode: 503,
            requestId: "req-503",
            forbidden: false,
            strippedKeys: [],
            problem: problem(503, "upstream-error", "postgres://user:password@db/app"),
          };
        },
      },
    );
    assert.equal(calls, 3);
    assert.equal(outage.detail?.status, "running");
    assert.equal(outage.problem?.detail.includes("postgres://"), false);
  });

  it("merges polls without dropping audit or artifacts the status payload omitted", () => {
    const current: ExecutionHistoryCache = {
      detail: execution({
        auditEvents: [
          {
            id: "audit-1",
            action: "execution.view",
            outcome: "allowed",
            resourceType: "execution",
            resourceId: "exec-1",
            correlationId: "corr",
            occurredAt: "",
            actorId: "user-1",
            hostContext: "",
            details: {},
          },
        ],
        artifacts: [
          {
            id: "art-1",
            executionId: "exec-1",
            executionStepId: "",
            name: "log",
            digest: "sha256:1",
            sizeBytes: 1,
            classification: "internal",
            retentionUntil: "",
            expiresAt: "",
            kind: "log",
            redacted: true,
            legalHold: false,
            deleted: false,
            deletedAt: "",
          },
        ],
      }),
      problem: null,
      forbidden: false,
      requestId: "req-1",
      strippedKeys: [],
    };
    const merged = mergePolledExecution(current, {
      execution: execution({ status: "succeeded", auditEvents: [], artifacts: [] }),
      strippedKeys: [],
      requestId: "req-poll",
    });
    assert.equal(merged.detail?.status, "succeeded");
    assert.equal(merged.detail?.auditEvents.length, 1);
    assert.equal(merged.detail?.artifacts.length, 1);
    assert.equal(merged.requestId, "req-poll");

    const hidden = forbiddenPollCache(merged, {
      problem: problem(403, "forbidden"),
      requestId: "req-deny",
    });
    assert.equal(hidden.detail, null);
    assert.equal(hidden.forbidden, true);
  });

  it("treats workspace 401 as empty permissions and keeps context when a lookup fails", async () => {
    const denied = await loadWorkspacePermissionsCache(asyncIdentity, async () => ({
      ok: false,
      statusCode: 401,
      requestId: "req-401",
      problem: problem(401, "unauthorized"),
    }));
    assert.deepEqual(denied, { permissions: [], actorUserId: "" });

    const allowed = await loadWorkspacePermissionsCache(identity, async () => ({
      ok: true,
      statusCode: 200,
      requestId: "req-200",
      data: {
        workspace: {
          id: "ws-1",
          tenant_id: "tenant-1",
          workbench_key: "bench",
          name: "Bench",
          status: "active",
        },
        tenant: {
          id: "tenant-1",
          slug: "tenant",
          name: "Tenant",
          status: "active",
        },
        principal: {
          id: "user-1",
          issuer: identity.issuer,
          external_subject: identity.subject,
          status: "active",
        },
        roles: [],
        permissions: ["execution.view"],
      },
    }));
    assert.deepEqual(allowed.permissions, ["execution.view"]);
    assert.equal(allowed.actorUserId, "user-1");

    const workflowFailure: WorkflowClientFailure = {
      ok: false,
      statusCode: 404,
      requestId: "req-miss",
      problem: problem(404, "not-found"),
      errors: [],
      conflict: false,
    };
    const approvalFailure: ApprovalClientFailure = {
      ok: false,
      statusCode: 404,
      requestId: "req-miss",
      problem: problem(404, "not-found"),
      expired: false,
      invalidated: false,
      selfApproval: false,
      strippedKeys: [],
    };
    const context = await loadExecutionContextCache(
      identity,
      "wf-1",
      "exec-1",
      "ver-1",
      previousContext(),
      {
        getVersion: async () => workflowFailure,
        fetchCatalog: async () => workflowFailure,
        listApprovals: async () => approvalFailure,
      },
    );
    assert.equal(context.version, null);
    assert.equal(context.workflowDeleted, true);
    assert.equal(context.versionProblem, null);
    assert.equal(context.catalog, null);
    assert.deepEqual(context.approvals, []);
  });

  it("renders a deleted workflow as a graph message and keeps steps", async () => {
    const approval = {
      id: "appr-1",
      status: "pending",
      executionId: "exec-1",
      binding: { nodeId: "gate" },
    } as ApprovalRequest;
    const context = await loadExecutionContextCache(
      identity,
      "wf-1",
      "exec-1",
      "ver-1",
      previousContext(),
      {
        getVersion: async () => ({
          ok: false,
          statusCode: 404,
          requestId: "req-404",
          problem: problem(404, "not-found", "workflow version not found"),
          errors: [],
          conflict: false,
        }),
        fetchCatalog: async () => ({
          ok: false,
          statusCode: 404,
          requestId: "req-cat",
          problem: problem(404, "not-found"),
          errors: [],
          conflict: false,
        }),
        listApprovals: async () => ({
          ok: true,
          statusCode: 200,
          requestId: "req-appr",
          items: [approval],
          limit: 1,
          cursor: "",
          next: "",
          strippedKeys: [],
        }),
      },
    );
    assert.equal(context.workflowDeleted, true);
    assert.equal(context.version, null);
    assert.equal(context.versionProblem, null);
    assert.equal(context.approvals[0]?.id, "appr-1");
    assert.equal(
      executionDetailDisplayedProblem({ historyProblem: null, context }),
      null,
    );

    const detail = execution({
      status: "waiting",
      steps: [step({ nodeId: "gate", status: "waiting", nodeType: "flow.approval" })],
    });
    const views = replayStepViews(detail.steps, { runStatus: detail.status });
    assert.equal(views.length, 1);
    assert.equal(views[0]?.nodeId, "gate");
    assert.equal(views[0]?.status, "waiting");
    const message = graphReplayMessage({
      graphAvailable: false,
      workflowDeleted: context.workflowDeleted,
    });
    assert.equal(message, WORKFLOW_DELETED_GRAPH_MESSAGE);
    assert.match(message ?? "", /deleted/);
    assert.match(message ?? "", /graph is no longer available/);
    assert.doesNotMatch(message ?? "", /retry-denied/);
  });

  it("keeps a version 500 as an error and does not call the workflow deleted", async () => {
    const serverError: WorkflowClientFailure = {
      ok: false,
      statusCode: 500,
      requestId: "req-500",
      problem: problem(500, "upstream-error", "version lookup failed"),
      errors: [],
      conflict: false,
    };
    const context = await loadExecutionContextCache(
      identity,
      "wf-1",
      "exec-1",
      "ver-1",
      previousContext(),
      {
        getVersion: async () => serverError,
        fetchCatalog: async () => serverError,
        listApprovals: async () => ({
          ok: true,
          statusCode: 200,
          requestId: "req-appr",
          items: [],
          limit: 0,
          cursor: "",
          next: "",
          strippedKeys: [],
        }),
      },
    );
    assert.equal(context.workflowDeleted, false);
    assert.equal(context.version?.id, "ver-1");
    assert.equal(context.versionProblem?.status, 500);
    assert.equal(context.versionProblem?.detail, "version lookup failed");
    const shown = executionDetailDisplayedProblem({
      historyProblem: null,
      context,
    });
    assert.equal(shown?.status, 500);
    assert.equal(shown?.detail, "version lookup failed");
    assert.notEqual(
      graphReplayMessage({
        graphAvailable: context.version != null,
        workflowDeleted: context.workflowDeleted,
      }),
      WORKFLOW_DELETED_GRAPH_MESSAGE,
    );

    const forbidden: WorkflowClientFailure = {
      ...serverError,
      statusCode: 403,
      requestId: "req-403",
      problem: problem(403, "forbidden", "version lookup forbidden"),
    };
    const denied = await loadExecutionContextCache(
      identity,
      "wf-1",
      "exec-1",
      "ver-1",
      undefined,
      {
        getVersion: async () => forbidden,
        fetchCatalog: async () => forbidden,
        listApprovals: async () => ({
          ok: false,
          statusCode: 403,
          requestId: "req-403",
          problem: problem(403, "forbidden"),
          expired: false,
          invalidated: false,
          selfApproval: false,
          strippedKeys: [],
        }),
      },
    );
    assert.equal(denied.workflowDeleted, false);
    assert.equal(denied.version, null);
    assert.equal(denied.versionProblem?.status, 403);
    assert.equal(
      executionDetailDisplayedProblem({ historyProblem: null, context: denied })
        ?.detail,
      "version lookup forbidden",
    );
    assert.equal(
      graphReplayMessage({
        graphAvailable: false,
        workflowDeleted: denied.workflowDeleted,
      })?.includes("deleted"),
      false,
    );
  });

  it("leaves execution chrome on the query hook without taking run or embed doors", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const chrome = readFileSync(
      `${here}../components/executions/ExecutionDetail.tsx`,
      "utf8",
    );
    const cache = readFileSync(`${here}execution-detail-query.ts`, "utf8");
    assert.match(chrome, /useExecutionDetailQuery/);
    assert.doesNotMatch(chrome, /startExecutionStatusPoll/);
    assert.doesNotMatch(chrome, /pollExecutionStatus/);
    assert.doesNotMatch(chrome, /getExecutionStepLogs/);
    assert.doesNotMatch(chrome, /fetchWorkflowCatalog/);
    assert.match(chrome, /canCancelExecution/);
    assert.match(chrome, /retryCapabilityAffordance/);
    assert.match(chrome, /retryFailureCopy/);
    assert.match(chrome, /workflowDeleted/);
    assert.doesNotMatch(chrome, /retry-denied/);
    const replay = readFileSync(
      `${here}../components/executions/ExecutionReplay.tsx`,
      "utf8",
    );
    assert.match(replay, /graphReplayMessage/);
    assert.match(replay, /workflowDeleted/);
    assert.match(chrome, /downloadGrantFailureMessage/);
    assert.match(chrome, /canOfferScriptEmergencyStop/);
    assert.doesNotMatch(cache, /localStorage|sessionStorage|publishDraft|runPublished/);
    assert.doesNotMatch(chrome, /LoginChrome|ChangePasswordChrome|FirstRunWizard/);
  });
});

function previousContext(): ExecutionContextCache {
  return {
    version: {
      id: "ver-1",
      workflowId: "wf-1",
      versionNumber: 3,
      digest: "sha256:abc",
      publishNote: "",
      publishedAt: "",
    },
    workflowDeleted: false,
    versionProblem: null,
    catalog: null,
    approvals: [],
    requestId: "req-old",
    strippedKeys: [],
  };
}

function step(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    executionId: "exec-1",
    nodeId: "gate",
    nodeType: "flow.approval",
    attempt: 1,
    status: "waiting",
    startedAt: "",
    finishedAt: "",
    createdAt: "",
    input: null,
    output: null,
    error: null,
    fencingToken: null,
    workerId: "",
    leaseId: "",
    ...overrides,
  };
}

const asyncIdentity = identity;
