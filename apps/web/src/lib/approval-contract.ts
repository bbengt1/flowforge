/**
 * Single adapter for E4.3 policy eval / approvals (#44 on `main`).
 *
 * Paths, query keys, mutation bodies, and problem aliases live here so
 * a later route-map change does not scatter through UI. Relates to #37
 * (already closed by #44) / Part of #34. Do not change `apps/api`.
 *
 *   GET  /approvals/catalog
 *   POST /policy/evaluate          {workflowId, workflowVersionId}  CSRF
 *   GET  /approvals                ?status&workflowId&workflowVersionId&executionId
 *   POST /approvals                {workflowId, workflowVersionId}  CSRF
 *   GET  /approvals/{id}
 *   POST /approvals/{id}/decide    {decision, note?}                CSRF
 *   GET  /approvals/{id}/events
 *
 * Session cookies + CSRF on POST. Never invent secrets. Host-supplied
 * id / workspaceId are never sent on writes.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type {
  CreateApprovalsBody,
  DecideApprovalBody,
  DecideDecision,
  EvaluatePolicyBody,
} from "./approval-types.ts";

export const APPROVAL_STORY = 37;
export const APPROVAL_EPIC = 34;
export const APPROVAL_API_PR = 44;

export const APPROVALS_COLLECTION = "approvals";
export const POLICY_EVALUATE_SEGMENTS = ["policy", "evaluate"] as const;
export const DECIDE_ACTION = "decide";
export const CATALOG_ACTION = "catalog";
export const EVENTS_ACTION = "events";

export const APPROVAL_STATUS_QUERY = "status";
export const APPROVAL_WORKFLOW_QUERY = "workflowId";
export const APPROVAL_WORKFLOW_VERSION_QUERY = "workflowVersionId";
export const APPROVAL_EXECUTION_QUERY = "executionId";

export const APPROVAL_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
  expired: "approval-expired",
  invalidated: "approval-invalidated",
  denied: "approval-denied",
} as const;

export const EXPIRED_APPROVAL_DETAIL = "Approval has expired.";
export const INVALIDATED_APPROVAL_DETAIL =
  "Approval is bound to a previous workflow version, target, or policy revision.";
export const SELF_APPROVAL_DETAIL =
  "The requester cannot approve or reject their own request.";

/** E10.3 durable flow.approval wait/resume from #116. Decide stays POST …/decide. */
export const FLOW_APPROVAL_NODE_TYPE = "flow.approval" as const;
export const FLOW_APPROVAL_REQUIRED_WITH = ["approverRole", "expiresIn"] as const;
export const E10_APPROVAL_DECIDE_ENABLED = true;
export const E10_APPROVAL_WAIT_DURABLE = true;
export const APPROVAL_WAIT_RESUME_API_PR = 116;
export const APPROVAL_WAIT_RESUME_ROUTE =
  "POST /api/v1/approvals/{approvalId}/decide";

export const APPROVAL_DECIDE_HELP =
  "Decide is POST /approvals/{id}/decide {decision:'approved'|'rejected', note?} with cookie session + X-CSRF-Token. Fresh authorization is required on every decide. Server 403 remains the authority. Cite #116.";

export const APPROVAL_SOD_HELP =
  "Separation of duties: the requester cannot approve or reject their own request. Compare GET /workspace principal.id to requestedBy (user UUIDs — never session.subject).";

export const APPROVAL_BINDING_HELP =
  "Approvals bind the exact workflow version, target, operation, and policy snapshot. A later publish of policy, target, or workflow version invalidates a prior pending or approved row.";

export const APPROVAL_EXPIRY_HELP =
  "Expiry is bound at request time. Expired rows fail closed (409). A new evaluation is required; a stale local approve is never enough.";

export const APPROVAL_WAIT_DURABLE_HELP =
  "GET /approvals/catalog waitResumeEnabled is true (#116). Mid-run wait parks as waiting and survives recover. This UI does not invent /executions/{id}/resume — decide the bound approval.";

export const APPROVAL_RESUME_VIA_DECIDE_HELP =
  "Resume is decide (#116 resumeRoute). POST /approvals/{id}/decide with CSRF. Do not invent POST /executions/{id}/resume or …/wait.";

export const EXPIRED_PROBLEM_ALIASES = [
  APPROVAL_PROBLEM_CODES.expired,
  "expired",
  "approval_expired",
] as const;

export const INVALIDATED_PROBLEM_ALIASES = [
  APPROVAL_PROBLEM_CODES.invalidated,
  "invalidated",
  "approval_invalidated",
  "binding-changed",
  "binding_changed",
  "stale_approval",
] as const;

export const DENIED_PROBLEM_ALIASES = [
  APPROVAL_PROBLEM_CODES.denied,
  "forbidden",
  "policy-denied",
  "policy_denied",
] as const;

export function approvalsPath(): string {
  return `/${APPROVALS_COLLECTION}`;
}

export function approvalsCatalogPath(): string {
  return `${approvalsPath()}/${CATALOG_ACTION}`;
}

export function approvalPath(approvalId: string): string {
  return `${approvalsPath()}/${approvalId}`;
}

export function approvalDecidePath(approvalId: string): string {
  return `${approvalPath(approvalId)}/${DECIDE_ACTION}`;
}

export function approvalEventsPath(approvalId: string): string {
  return `${approvalPath(approvalId)}/${EVENTS_ACTION}`;
}

export function policyEvaluatePath(): string {
  return `/${POLICY_EVALUATE_SEGMENTS.join("/")}`;
}

export function listApprovalsPath(filter: {
  status?: string;
  workflowId?: string;
  workflowVersionId?: string;
  executionId?: string;
} = {}): string {
  const params = new URLSearchParams();
  if (filter.status?.trim()) {
    params.set(APPROVAL_STATUS_QUERY, filter.status.trim());
  }
  if (filter.workflowId?.trim()) {
    params.set(APPROVAL_WORKFLOW_QUERY, filter.workflowId.trim());
  }
  if (filter.workflowVersionId?.trim()) {
    params.set(APPROVAL_WORKFLOW_VERSION_QUERY, filter.workflowVersionId.trim());
  }
  if (filter.executionId?.trim()) {
    params.set(APPROVAL_EXECUTION_QUERY, filter.executionId.trim());
  }
  const query = params.toString();
  return query ? `${approvalsPath()}?${query}` : approvalsPath();
}

export function executionApprovalsPath(
  _workflowId: string,
  executionId: string,
): string {
  return listApprovalsPath({ executionId });
}

export function buildEvaluatePolicyBody(
  input: EvaluatePolicyBody,
): EvaluatePolicyBody {
  return {
    workflowId: input.workflowId.trim(),
    workflowVersionId: input.workflowVersionId.trim(),
  };
}

export function buildCreateApprovalsBody(
  input: CreateApprovalsBody,
): CreateApprovalsBody {
  return {
    workflowId: input.workflowId.trim(),
    workflowVersionId: input.workflowVersionId.trim(),
  };
}

export function buildDecideApprovalBody(
  decision: DecideDecision,
  note?: string,
): DecideApprovalBody {
  const trimmed = note?.trim();
  if (trimmed) {
    return { decision, note: trimmed };
  }
  return { decision };
}

export function isExpiredProblemCode(code: string | undefined): boolean {
  return Boolean(
    code && (EXPIRED_PROBLEM_ALIASES as readonly string[]).includes(code),
  );
}

export function isInvalidatedProblemCode(code: string | undefined): boolean {
  return Boolean(
    code &&
      (INVALIDATED_PROBLEM_ALIASES as readonly string[]).includes(code),
  );
}

export function isDeniedProblemCode(code: string | undefined): boolean {
  return Boolean(
    code && (DENIED_PROBLEM_ALIASES as readonly string[]).includes(code),
  );
}

export function problemDetailMatches(
  detail: string | undefined,
  expected: string,
): boolean {
  return Boolean(detail?.trim() && detail.trim() === expected);
}

export type ApprovalProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function eq(segments: string[], expected: readonly string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

/**
 * Allowlisted Next proxy routes. identity-proxy spreads this array so a
 * retarget only edits this file.
 */
export const APPROVAL_PROXY_ROUTES: readonly ApprovalProxyRoute[] = [
  { methods: ["GET"], match: (s) => eq(s, [APPROVALS_COLLECTION, CATALOG_ACTION]) },
  { methods: ["GET", "POST"], match: (s) => eq(s, [APPROVALS_COLLECTION]) },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === APPROVALS_COLLECTION &&
      isResourceId(s[1]) &&
      s[2] === EVENTS_ACTION,
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === APPROVALS_COLLECTION &&
      isResourceId(s[1]) &&
      s[2] === DECIDE_ACTION,
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === APPROVALS_COLLECTION &&
      isResourceId(s[1]),
  },
  {
    methods: ["POST"],
    match: (s) => eq(s, POLICY_EVALUATE_SEGMENTS),
  },
];
