/**
 * Thin typed E5.1 execution history client.
 *
 * Paths come only from execution-contract.ts so a later jonny route map
 * retargets in one place. Session: credentials:include. Host-supplied
 * workspace IDs are never sent. Unexpected secrets are stripped before
 * callers see the payload. Never log request bodies or cookies.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  executionEventsPath,
  executionJobsPath,
  executionPath,
  executionStepsPath,
  listExecutionsPath,
  workflowExecutionPinPath,
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
  const path = listExecutionsPath(filter);
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
  if (
    result.statusCode === 404 &&
    workflowId?.trim()
  ) {
    return getExecutionPinFallback(identity, workflowId.trim(), executionId);
  }
  return failure(result);
}

export async function getExecutionSteps(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionStepsSuccess | ExecutionClientFailure> {
  const path = executionStepsPath(executionId);
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
    items: parseItemList(result.data, (item) =>
      parseExecutionStep(item, executionId),
    ),
    strippedKeys,
  };
}

export async function getExecutionJobs(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionJobsSuccess | ExecutionClientFailure> {
  const path = executionJobsPath(executionId);
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
    items: parseItemList(result.data, (item) =>
      parseExecutionJob(item, executionId),
    ),
    strippedKeys,
  };
}

export async function getExecutionEvents(
  identity: DevIdentity,
  executionId: string,
): Promise<ExecutionEventsSuccess | ExecutionClientFailure> {
  const path = executionEventsPath(executionId);
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
    items: parseItemList(result.data, parseExecutionEvent),
    strippedKeys,
  };
}

/**
 * Load detail, then fill missing steps/jobs/events from nested GETs.
 * Nested 404 (routes not published yet) is ignored. Nested 403 fails
 * that section closed.
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
    events: execution.events.length === 0,
  };
  const extras = await Promise.all([
    missing.steps ? getExecutionSteps(identity, executionId) : null,
    missing.jobs ? getExecutionJobs(identity, executionId) : null,
    missing.events ? getExecutionEvents(identity, executionId) : null,
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
    execution = { ...execution, events: events.items };
    strippedKeys.push(...events.strippedKeys);
  }

  return {
    ok: true,
    statusCode: header.statusCode,
    requestId: header.requestId,
    execution,
    strippedKeys,
  };
}

async function getExecutionPinFallback(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
): Promise<ExecutionDetailSuccess | ExecutionClientFailure> {
  const path = workflowExecutionPinPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return detailResult(result, path, executionId);
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
