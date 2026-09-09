/**
 * E4.3 single retarget adapter (Chloe UI).
 *
 * Jonny owns policy-eval + approval-binding APIs; this file is the only
 * place UI paths, write bodies, and problem-code aliases live. When his
 * route map lands on main, rebase this branch onto main and change this
 * adapter — do not stack on his API branch (lesson from #31/#39).
 *
 * Scaffold (provisional, not the official API):
 *   GET  /approvals
 *   GET  /approvals/{id}
 *   POST /approvals/{id}/approve   {note?}
 *   POST /approvals/{id}/reject    {note?}
 *   POST /policy/evaluate          {workflowVersionId, operation?, ...}
 *   GET  /workflows/{wf}/executions/{ex}/approvals
 *
 * Session cookies + CSRF on mutations. Prefer problem+json for
 * deny / expired / invalidated. Never invent secrets. Host-supplied
 * id / workspaceId are never sent on writes.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type {
  ApprovalAction,
  DecideApprovalBody,
  EvaluatePolicyBody,
} from "./approval-types.ts";
import { DEFAULT_PRE_RUN_OPERATION } from "./approval-types.ts";

export const APPROVAL_STORY = 37;
export const APPROVAL_EPIC = 34;

export const APPROVALS_COLLECTION = "approvals";
export const POLICY_EVALUATE_SEGMENTS = ["policy", "evaluate"] as const;
export const APPROVE_ACTION = "approve";
export const REJECT_ACTION = "reject";

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

/** Aliases jonny may publish — keep matching in one place. */
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

export function approvalPath(approvalId: string): string {
  return `${approvalsPath()}/${approvalId}`;
}

export function approvalApprovePath(approvalId: string): string {
  return `${approvalPath(approvalId)}/${APPROVE_ACTION}`;
}

export function approvalRejectPath(approvalId: string): string {
  return `${approvalPath(approvalId)}/${REJECT_ACTION}`;
}

export function approvalDecidePath(
  approvalId: string,
  action: ApprovalAction,
): string {
  return action === "reject"
    ? approvalRejectPath(approvalId)
    : approvalApprovePath(approvalId);
}

export function policyEvaluatePath(): string {
  return `/${POLICY_EVALUATE_SEGMENTS.join("/")}`;
}

export function executionApprovalsPath(
  workflowId: string,
  executionId: string,
): string {
  return `/workflows/${workflowId}/executions/${executionId}/${APPROVALS_COLLECTION}`;
}

export function buildEvaluatePolicyBody(
  input: EvaluatePolicyBody,
): EvaluatePolicyBody {
  const body: EvaluatePolicyBody = {
    workflowVersionId: input.workflowVersionId.trim(),
  };
  const operation = (input.operation ?? DEFAULT_PRE_RUN_OPERATION).trim();
  if (operation) {
    body.operation = operation;
  }
  const targetId = input.targetId?.trim();
  if (targetId) {
    body.targetId = targetId;
  }
  const targetKind = input.targetKind?.trim();
  if (targetKind) {
    body.targetKind = targetKind;
  }
  const executionId = input.executionId?.trim();
  if (executionId) {
    body.executionId = executionId;
  }
  const nodeId = input.nodeId?.trim();
  if (nodeId) {
    body.nodeId = nodeId;
  }
  return body;
}

export function buildDecideApprovalBody(note?: string): DecideApprovalBody {
  const trimmed = note?.trim();
  return trimmed ? { note: trimmed } : {};
}

export function isExpiredProblemCode(code: string | undefined): boolean {
  return Boolean(
    code &&
      (EXPIRED_PROBLEM_ALIASES as readonly string[]).includes(code),
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
  { methods: ["GET"], match: (s) => eq(s, [APPROVALS_COLLECTION]) },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === APPROVALS_COLLECTION &&
      isResourceId(s[1]),
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === APPROVALS_COLLECTION &&
      isResourceId(s[1]) &&
      (s[2] === APPROVE_ACTION || s[2] === REJECT_ACTION),
  },
  {
    methods: ["POST"],
    match: (s) => eq(s, POLICY_EVALUATE_SEGMENTS),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "executions" &&
      isResourceId(s[3]) &&
      s[4] === APPROVALS_COLLECTION,
  },
];
