/**
 * Thin typed execution client (E5.1 list/detail + E5.2 cancel/retry).
 *
 * Paths come only from execution-contract.ts (#53). Session:
 * credentials:include. CSRF on POST cancel/retry. Host-supplied
 * workspace IDs are never sent. Unexpected secrets are stripped.
 * Never log request bodies. Status is GET /executions/{id} only —
 * never /jobs/*.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  RETRY_APPLIED_MESSAGE,
  buildCancelBody,
  buildRetryBody,
  executionAuditEventsPath,
  executionCancelPath,
  executionJobsPath,
  executionPath,
  executionRetryPath,
  executionStepRetryPath,
  executionStepsPath,
  listExecutionsPath,
  listWorkflowExecutionsPath,
  listWorkspaceAuditEventsPath,
  workflowExecutionCancelPath,
  workflowExecutionPath,
  workflowExecutionRetryPath,
} from "./execution-contract.ts";
import {
  cancelOutcomeMessage,
  isExecutionForbidden,
  isIdempotentCancel,
  parseExecutionDetail,
  parseExecutionEvent,
  parseExecutionJob,
  parseExecutionList,
  parseExecutionStep,
  parseItemList,
  stripSecretFields,
} from "./execution.ts";
import type {
  AuditEventQuery,
  ExecutionAuditEvent,
  ExecutionDetail,
  ExecutionJob,
  ExecutionListQuery,
  ExecutionRecord,
  ExecutionStep,
} from "./execution-types.ts";

export type ExecutionClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
  strippedKeys: string[];
};

export type ExecutionListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionRecord[];
  strippedKeys: string[];
};

export type ExecutionDetailSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: ExecutionDetail;
  strippedKeys: string[];
};

export type ExecutionStepsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionStep[];
  strippedKeys: string[];
};

export type ExecutionJobsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionJob[];
  strippedKeys: string[];
};

export type ExecutionEventsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ExecutionAuditEvent[];
  strippedKeys: string[];
};

export type ExecutionCancelSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: ExecutionDetail | null;
  idempotent: boolean;
  message: string;
  strippedKeys: string[];
};

export type ExecutionRetrySuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  execution: ExecutionDetail | null;
  message: string;
  strippedKeys: string[];
};

export async function listExecutions(
  identity: DevIdentity,
  filter: ExecutionListQuery = {},
): Promise<ExecutionListSuccess | ExecutionClientFailure> {
  return listFromPath(identity, listExecutionsPath(filter));
}

export async function listWorkflowExecutions(
  identity: DevIdentity,
  workflowId: string,
  filter: Pick<ExecutionListQuery, "status" | "limit"> = {},
): Promise<ExecutionListSuccess | ExecutionClientFailure> {
  return listFromPath(
    identity,
    listWorkflowExecutionsPath(workflowId, filter),
  );
}

async function listFromPath(
  identity: DevIdentity,
  path: string,
): Promise<ExecutionListSuccess | ExecutionClientFailure> {
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseExecutionList(result.data),
    strippedKeys,
  };
}

export async function getExecution(
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const path = executionPath(executionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (result.ok) {
    return detailResult(result, path, executionId);
  }
  if (result.statusCode === 404 && workflowId?.trim()) {
    return getWorkflowExecutionDetail(
      identity,
      workflowId.trim(),
      executionId,
    );
  }
  return failure(result);
}

export async function getWorkflowExecutionDetail(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const path = workflowExecutionPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return detailResult(result, path, executionId);
}

export async function getExecutionSteps(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionStepsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(executionStepsPath(executionId), identity),
    (item) => parseExecutionStep(item, executionId),
  );
}

export async function getExecutionJobs(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionJobsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(executionJobsPath(executionId), identity),
    (item) => parseExecutionJob(item, executionId),
  );
}

export async function getExecutionEvents(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  return getExecutionAuditEvents(identity, executionId);
}

export async function getExecutionAuditEvents(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(
      executionAuditEventsPath(executionId),
      identity,
    ),
    parseExecutionEvent,
  );
}

/**
 * POST /executions/{id}/cancel with CSRF. Empty body — never send
 * host-supplied id / workspaceId. A second cancel is success
 * (idempotent). 403 is fail-closed. Falls back to the workflow-scoped
 * twin on 404 when workflowId is known.
 */
export async function cancelExecution(
  identity: DevIdentity,
  executionId: string,
  options: { workflowId?: string; previousStatus?: string } = {},
): Promise<ExecutionCancelSuccess | ExecutionClientFailure> {
  const path = executionCancelPath(executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCancelBody(),
  });
  if (
    !result.ok &&
    result.statusCode === 404 &&
    options.workflowId?.trim()
  ) {
    return cancelWorkflowExecution(
      identity,
      options.workflowId.trim(),
      executionId,
      options.previousStatus,
    );
  }
  return cancelResult(result, path, executionId, options.previousStatus);
}

export async function cancelWorkflowExecution(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
  previousStatus?: string,
): Promise<ExecutionCancelSuccess | ExecutionClientFailure> {
  const path = workflowExecutionCancelPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCancelBody(),
  });
  return cancelResult(result, path, executionId, previousStatus);
}

/**
 * POST /executions/{id}/retry with CSRF. Body is `{stepId?}` —
 * never host-supplied id / workspaceId. Prefer retryExecutionStep
 * when the clicked step is known. 403 is fail-closed. 409 for
 * indeterminate / provider nodes.
 */
export async function retryExecution(
  identity: DevIdentity,
  executionId: string,
  options: { workflowId?: string; stepId?: string } = {},
): Promise<ExecutionRetrySuccess | ExecutionClientFailure> {
  const path = executionRetryPath(executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRetryBody({ stepId: options.stepId }),
  });
  if (
    !result.ok &&
    result.statusCode === 404 &&
    options.workflowId?.trim()
  ) {
    return retryWorkflowExecution(
      identity,
      options.workflowId.trim(),
      executionId,
      options.stepId,
    );
  }
  return retryResult(result, path, executionId);
}

export async function retryExecutionStep(
  identity: DevIdentity,
  executionId: string,
  stepId: string,
): Promise<ExecutionRetrySuccess | ExecutionClientFailure> {
  const path = executionStepRetryPath(executionId, stepId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRetryBody({ stepId }),
  });
  if (!result.ok && result.statusCode === 404) {
    return retryExecution(identity, executionId, { stepId });
  }
  return retryResult(result, path, executionId);
}

export async function retryWorkflowExecution(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
  stepId?: string,
): Promise<ExecutionRetrySuccess | ExecutionClientFailure> {
  const path = workflowExecutionRetryPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildRetryBody({ stepId }),
  });
  return retryResult(result, path, executionId);
}

function retryResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  executionId: string,
): ExecutionRetrySuccess | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const raw =
    result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : {};
  const parsed = parseExecutionDetail(raw.execution ?? result.data);
  if (parsed && executionId && parsed.id !== executionId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Retry payload id did not match the requested execution.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution: parsed,
    message: RETRY_APPLIED_MESSAGE,
    strippedKeys,
  };
}

/** Poll GET /executions/{id} for steps/jobs. Never hits /jobs/*. */
export async function pollExecutionStatus(
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  return getExecution(identity, executionId, workflowId);
}

function cancelResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  executionId: string,
  previousStatus?: string,
): ExecutionCancelSuccess | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  if (result.statusCode === 204 || result.data == null) {
    const idempotent = isIdempotentCancel({
      previousStatus,
      status: "canceled",
    });
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      execution: null,
      idempotent,
      message: cancelOutcomeMessage({
        previousStatus,
        status: "canceled",
      }),
      strippedKeys,
    };
  }
  const parsed = parseExecutionDetail(result.data);
  if (parsed && executionId && parsed.id !== executionId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Cancel payload id did not match the requested execution.",
    );
  }
  const raw =
    result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : {};
  const idempotent = isIdempotentCancel({
    previousStatus,
    status: parsed?.status,
    canceled: raw.canceled === true,
    replayed: raw.replayed === true || parsed?.replayed === true,
  });
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution: parsed,
    idempotent,
    message: cancelOutcomeMessage({
      previousStatus,
      status: parsed?.status ?? "canceled",
      canceled: raw.canceled === true,
      replayed: raw.replayed === true || parsed?.replayed === true,
    }),
    strippedKeys,
  };
}

export async function listWorkspaceAuditEvents(
  identity: DevIdentity,
  filter: AuditEventQuery = {},
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  return itemsResult(
    await callIdentityProxy<unknown>(
      listWorkspaceAuditEventsPath(filter),
      identity,
    ),
    parseExecutionEvent,
  );
}

/**
 * Load detail from GET /executions/{id} (steps/jobs/pins come from that
 * payload — #53). Audit may be filled from nested GET …/audit-events
 * or workspace GET /audit-events. Never fetches /jobs/* or nested
 * GET …/jobs for status.
 */
export async function loadExecutionHistory(
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const header = await getExecution(identity, executionId, workflowId);
  if (!header.ok) {
    return header;
  }
  const strippedKeys = [...header.strippedKeys];
  let execution = header.execution;

  if (execution.auditEvents.length === 0) {
    const events = await getExecutionAuditEvents(identity, executionId);
    if (!events.ok && events.forbidden) {
      return events;
    }
    if (events.ok) {
      execution = { ...execution, auditEvents: events.items };
      strippedKeys.push(...events.strippedKeys);
    } else {
      const workspace = await listWorkspaceAuditEvents(identity, {
        resourceType: "execution",
        resourceId: executionId,
      });
      if (workspace.ok) {
        execution = { ...execution, auditEvents: workspace.items };
        strippedKeys.push(...workspace.strippedKeys);
      } else if (workspace.forbidden) {
        return workspace;
      }
    }
  }

  return {
    ok: true,
    statusCode: header.statusCode,
    requestId: header.requestId,
    execution,
    strippedKeys,
  };
}

function itemsResult<T>(
  result: IdentityClientResult<unknown>,
  parse: (item: unknown) => T | null,
):
  | {
      ok: true;
      statusCode: number;
      requestId: string;
      items: T[];
      strippedKeys: string[];
    }
  | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseItemList(result.data, parse),
    strippedKeys,
  };
}

function detailResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  executionId: string,
): ExecutionDetailSuccess | ExecutionClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const execution = parseExecutionDetail(result.data);
  if (!execution) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Execution payload was missing id, workflowId, or workflowVersionId.",
    );
  }
  if (execution.id !== executionId && executionId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Execution payload id did not match the requested execution.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    execution,
    strippedKeys,
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): ExecutionClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    forbidden: isExecutionForbidden(result.problem),
    strippedKeys: [],
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): ExecutionClientFailure {
  return {
    ok: false,
    statusCode,
    requestId,
    forbidden: false,
    strippedKeys: [],
    problem: {
      type: "urn:flowforge:problem:upstream-error",
      title: "Upstream Error",
      status: statusCode,
      detail,
      instance,
      code: "upstream-error",
      request_id: requestId,
    },
  };
}
