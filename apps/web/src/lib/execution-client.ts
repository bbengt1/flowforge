/**
 * Thin typed E5.1 client against jonny's #51 map.
 *
 * Paths come only from execution-contract.ts. Session: credentials:include.
 * Host-supplied workspace IDs are never sent. Unexpected secrets are
 * stripped before callers see the payload. Never log request bodies.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  executionAuditEventsPath,
  executionJobsPath,
  executionPath,
  executionStepsPath,
  listExecutionsPath,
  listWorkflowExecutionsPath,
  listWorkspaceAuditEventsPath,
  workflowExecutionPath,
} from "./execution-contract.ts";
import {
  isExecutionForbidden,
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
 * Load detail (includes steps/jobs/pins/audit when #51 returns them),
 * then fill missing collections from nested GETs. Nested 404 is ignored.
 * Nested 403 fails that section closed.
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

  const missing = {
    steps: execution.steps.length === 0,
    jobs: execution.jobs.length === 0,
    auditEvents: execution.auditEvents.length === 0,
  };
  const extras = await Promise.all([
    missing.steps ? getExecutionSteps(identity, executionId) : null,
    missing.jobs ? getExecutionJobs(identity, executionId) : null,
    missing.auditEvents
      ? getExecutionAuditEvents(identity, executionId)
      : null,
  ]);

  const [steps, jobs, events] = extras;
  if (steps && !steps.ok && steps.forbidden) {
    return steps;
  }
  if (jobs && !jobs.ok && jobs.forbidden) {
    return jobs;
  }
  if (events && !events.ok && events.forbidden) {
    return events;
  }
  if (steps?.ok) {
    execution = { ...execution, steps: steps.items };
    strippedKeys.push(...steps.strippedKeys);
  }
  if (jobs?.ok) {
    execution = { ...execution, jobs: jobs.items };
    strippedKeys.push(...jobs.strippedKeys);
  }
  if (events?.ok) {
    execution = { ...execution, auditEvents: events.items };
    strippedKeys.push(...events.strippedKeys);
  } else if (missing.auditEvents) {
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
