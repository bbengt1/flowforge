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
  approvalEventsPath,
  approvalPath,
  approvalsCatalogPath,
  buildCreateApprovalsBody,
  buildDecideApprovalBody,
  buildEvaluatePolicyBody,
  listApprovalsPath,
  policyEvaluatePath,
} from "./approval-contract.ts";
import {
  isExpiredApprovalProblem,
  isInvalidatedApprovalProblem,
  isSelfApprovalProblem,
  parseApprovalCatalog,
  parseApprovalEvents,
  parseApprovalList,
  parseApprovalRequest,
  parsePolicyEvaluation,
  stripSecretKeys,
} from "./approval.ts";
import type {
  ApprovalCatalog,
  ApprovalEvent,
  ApprovalListFilter,
  ApprovalRequest,
  CreateApprovalsBody,
  DecideDecision,
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
  selfApproval: boolean;
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

export type ApprovalCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: ApprovalCatalog;
  strippedKeys: string[];
};

export type ApprovalEventsSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: ApprovalEvent[];
  strippedKeys: string[];
};

export async function listApprovals(
  identity: DevIdentity,
  filter: ApprovalListFilter = {},
): Promise<ApprovalListSuccess | ApprovalClientFailure> {
  const path = listApprovalsPath(filter);
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

export async function getApprovalCatalog(
  identity: DevIdentity,
): Promise<ApprovalCatalogSuccess | ApprovalClientFailure> {
  const result = await callIdentityProxy<unknown>(
    approvalsCatalogPath(),
    identity,
  );
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretKeys(result.data, strippedKeys);
  const catalog = parseApprovalCatalog(result.data);
  if (!catalog) {
    return malformed(
      result.requestId,
      result.statusCode,
      approvalsCatalogPath(),
      "Approval catalog was missing statuses or decisions.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog,
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

export async function getApprovalEvents(
  identity: DevIdentity,
  approvalId: string,
): Promise<ApprovalEventsSuccess | ApprovalClientFailure> {
  const path = approvalEventsPath(approvalId);
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
    items: parseApprovalEvents(result.data),
    strippedKeys,
  };
}

export async function createApprovals(
  identity: DevIdentity,
  input: CreateApprovalsBody,
): Promise<ApprovalListSuccess | ApprovalClientFailure> {
  const path = listApprovalsPath();
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildCreateApprovalsBody(input),
  });
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

export async function decideApproval(
  identity: DevIdentity,
  approvalId: string,
  decision: DecideDecision,
  note?: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  const path = approvalDecidePath(approvalId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildDecideApprovalBody(decision, note),
  });
  return recordResult(result, path);
}

export async function approveApproval(
  identity: DevIdentity,
  approvalId: string,
  note?: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  return decideApproval(identity, approvalId, "approved", note);
}

export async function rejectApproval(
  identity: DevIdentity,
  approvalId: string,
  note?: string,
): Promise<ApprovalRecordSuccess | ApprovalClientFailure> {
  return decideApproval(identity, approvalId, "rejected", note);
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

/**
 * Pre-run: evaluate, then materialize pending rows when the server
 * requires approval and has not already bound records.
 */
export async function evaluatePolicyForRun(
  identity: DevIdentity,
  input: EvaluatePolicyBody,
): Promise<PolicyEvaluateSuccess | ApprovalClientFailure> {
  const evaluated = await evaluatePolicy(identity, input);
  if (!evaluated.ok) {
    return evaluated;
  }
  if (
    evaluated.evaluation.decision !== "approval-required" ||
    evaluated.evaluation.approvals.length > 0 ||
    evaluated.evaluation.requirements.length === 0
  ) {
    return evaluated;
  }
  const created = await createApprovals(identity, input);
  if (!created.ok) {
    return evaluated;
  }
  return {
    ...evaluated,
    evaluation: {
      ...evaluated.evaluation,
      approvals: created.items,
    },
    strippedKeys: [...evaluated.strippedKeys, ...created.strippedKeys],
  };
}

export async function listExecutionApprovals(
  identity: DevIdentity,
  _workflowId: string,
  executionId: string,
): Promise<ApprovalListSuccess | ApprovalClientFailure> {
  return listApprovals(identity, { executionId });
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

function classifyProblem(problem: ProblemDetails): {
  expired: boolean;
  invalidated: boolean;
  selfApproval: boolean;
} {
  return {
    expired: isExpiredApprovalProblem(problem),
    invalidated: isInvalidatedApprovalProblem(problem),
    selfApproval: isSelfApprovalProblem(problem),
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
    ...classifyProblem(result.problem),
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
    selfApproval: false,
    strippedKeys: [],
  };
}
