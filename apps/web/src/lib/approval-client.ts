/**
 * Thin typed E4.3 client. Paths come only from approval-contract.ts.
 *
 * Session: credentials:include + X-CSRF-Token on mutations.
 * Host-supplied workspace IDs are never sent. Approval tokens are
 * stripped from responses and never stored.
 *
 * A successful local parse of status=approved does not authorize
 * dispatch — callers must re-evaluate on the server.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  approvalDecidePath,
  approvalPath,
  approvalsPath,
  buildDecideApprovalBody,
  buildEvaluatePolicyBody,
  executionApprovalsPath,
  isExpiredProblemCode,
  isInvalidatedProblemCode,
  policyEvaluatePath,
} from "./approval-contract.ts";
import {
  parseApprovalList,
  parseApprovalRequest,
  parsePolicyEvaluation,
  stripSecretKeys,
} from "./approval.ts";
import type {
  ApprovalAction,
  ApprovalRequest,
  EvaluatePolicyBody,
  PolicyEvaluation,
} from "./approval-types.ts";

export type ApprovalClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  expired: boolean;
  invalidated: boolean;
  strippedKeys: string[];
};

export type ApprovalRecordSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  approval: ApprovalRequest;
  strippedKeys: string[];
};

export type ApprovalListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ApprovalRequest[];
  strippedKeys: string[];
};

export type PolicyEvaluateSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  evaluation: PolicyEvaluation;
  strippedKeys: string[];
};

export async function listApprovals(
  identity: DevIdentity,
): Promise<ApprovalListSuccess | ApprovalClientFailure> {
  const result = await callIdentityProxy<unknown>(approvalsPath(), identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretKeys(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseApprovalList(result.data),
    strippedKeys,
  };
}

export async function getApproval(
  identity: DevIdentity,
  approvalId: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  const path = approvalPath(approvalId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return recordResult(result, path);
}

export async function decideApproval(
  identity: DevIdentity,
  approvalId: string,
  action: ApprovalAction,
  note?: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  const path = approvalDecidePath(approvalId, action);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildDecideApprovalBody(note),
  });
  return recordResult(result, path);
}

export async function approveApproval(
  identity: DevIdentity,
  approvalId: string,
  note?: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  return decideApproval(identity, approvalId, "approve", note);
}

export async function rejectApproval(
  identity: DevIdentity,
  approvalId: string,
  note?: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  return decideApproval(identity, approvalId, "reject", note);
}

export async function evaluatePolicy(
  identity: DevIdentity,
  input: EvaluatePolicyBody,
): Promise<PolicyEvaluateSuccess | ApprovalClientFailure> {
  const path = policyEvaluatePath();
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildEvaluatePolicyBody(input),
  });
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretKeys(result.data, strippedKeys);
  const evaluation = parsePolicyEvaluation(result.data);
  if (!evaluation) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Policy evaluation was missing a decision.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    evaluation,
    strippedKeys,
  };
}

export async function listExecutionApprovals(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
): Promise<ApprovalListSuccess | ApprovalClientFailure> {
  const path = executionApprovalsPath(workflowId, executionId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretKeys(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseApprovalList(result.data),
    strippedKeys,
  };
}

function recordResult(
  result: IdentityClientResult<unknown>,
  instance: string,
): ApprovalRecordSuccess | ApprovalClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretKeys(result.data, strippedKeys);
  const approval = parseApprovalRequest(result.data);
  if (!approval) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Approval payload was missing id, status, or binding.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    approval,
    strippedKeys,
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): ApprovalClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    expired: isExpiredProblemCode(result.problem.code),
    invalidated: isInvalidatedProblemCode(result.problem.code),
    strippedKeys: [],
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): ApprovalClientFailure {
  return {
    ok: false,
    statusCode,
    requestId,
    problem: {
      type: "urn:flowforge:problem:upstream-error",
      title: "Upstream Error",
      status: statusCode,
      detail,
      instance,
      code: "upstream-error",
      request_id: requestId,
    },
    expired: false,
    invalidated: false,
    strippedKeys: [],
  };
}
