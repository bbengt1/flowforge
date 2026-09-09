/**
 * E4.3 approval / policy-eval helpers.
 *
 * Server-side recheck is authoritative. A stale local "approved" value
 * never authorizes dispatch. Approval tokens are never written to
 * localStorage or sessionStorage.
 */

import {
  isDeniedProblemCode,
  isExpiredProblemCode,
  isInvalidatedProblemCode,
} from "./approval-contract.ts";
import {
  APPROVAL_ACTIONS,
  APPROVAL_STATUSES,
  BINDING_CHANGE_FIELDS,
  EXECUTION_WAITING_STATUSES,
  POLICY_DECISIONS,
  VALIDITY_REASONS,
  type ApprovalAction,
  type ApprovalBinding,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalValidity,
  type BindingChangeField,
  type PolicyDecision,
  type PolicyEvaluation,
  type ValidityReason,
} from "./approval-types.ts";
import type { ProblemDetails } from "./problem.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_KEY_ALIASES = new Set([
  "approvaltoken",
  "approval_token",
  "decisiontoken",
  "decision_token",
  "authorization",
  "accesstoken",
  "access_token",
  "apitoken",
  "api_token",
  "bearer",
  "ciphertext",
  "cookie",
  "password",
  "secret",
  "token",
]);

const SECRET_KEY_PARTS = [
  "password",
  "secret",
  "token",
  "authorization",
  "ciphertext",
];

export function isUuid(value: string | undefined): boolean {
  return Boolean(value && UUID.test(value));
}

export function isSecretKey(name: string): boolean {
  const folded = name.trim().toLowerCase().replace(/[-.]/g, "_");
  if (SECRET_KEY_ALIASES.has(folded.replace(/_/g, ""))) {
    return true;
  }
  if (SECRET_KEY_ALIASES.has(folded)) {
    return true;
  }
  return SECRET_KEY_PARTS.some((part) => folded.includes(part));
}

export function stripSecretKeys(
  value: unknown,
  stripped: string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretKeys(item, stripped));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      stripped.push(key);
      continue;
    }
    out[key] = stripSecretKeys(raw, stripped);
  }
  return out;
}

function readString(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readNumber(...candidates: unknown[]): number | null {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function isApprovalStatus(value: string): value is ApprovalStatus {
  return (APPROVAL_STATUSES as readonly string[]).includes(value);
}

function isPolicyDecision(value: string): value is PolicyDecision {
  return (POLICY_DECISIONS as readonly string[]).includes(value);
}

function isApprovalAction(value: string): value is ApprovalAction {
  return (APPROVAL_ACTIONS as readonly string[]).includes(value);
}

function isChangeField(value: string): value is BindingChangeField {
  return (BINDING_CHANGE_FIELDS as readonly string[]).includes(value);
}

function isValidityReason(value: string): value is ValidityReason {
  return (VALIDITY_REASONS as readonly string[]).includes(value);
}

export function parseApprovalBinding(raw: unknown): ApprovalBinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const workflowVersionId = readString(
    row.workflowVersionId,
    row.workflow_version_id,
  );
  const operation = readString(row.operation);
  if (!isUuid(workflowVersionId) || !operation) {
    return null;
  }
  return {
    workflowVersionId,
    workflowVersionDigest: readString(
      row.workflowVersionDigest,
      row.workflow_version_digest,
      row.workflowDigest,
      row.digest,
    ),
    targetId: readString(row.targetId, row.target_id),
    targetKind: readString(row.targetKind, row.target_kind),
    targetName: readString(row.targetName, row.target_name),
    policyRevisionId: readString(
      row.policyRevisionId,
      row.policy_revision_id,
      row.policyVersionId,
      row.policy_version_id,
    ),
    policyRevisionNumber: readNumber(
      row.policyRevisionNumber,
      row.policy_revision_number,
      row.policyVersionNumber,
    ),
    policyDigest: readString(row.policyDigest, row.policy_digest),
    operation,
    expiresAt: readString(row.expiresAt, row.expires_at),
  };
}

function parseValidity(
  raw: unknown,
  status: ApprovalStatus,
  binding: ApprovalBinding,
): ApprovalValidity {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const changedFields = parseChangedFields(row.changedFields ?? row.changed_fields);
  const currentBinding = parseApprovalBinding(
    row.currentBinding ?? row.current_binding,
  );
  const reasonRaw = readString(row.reason);
  const reason = isValidityReason(reasonRaw) ? reasonRaw : "";
  const explicitCurrent =
    typeof row.current === "boolean"
      ? row.current
      : typeof row.valid === "boolean"
        ? row.valid
        : null;

  if (explicitCurrent === false || status === "expired" || status === "invalidated") {
    return {
      current: false,
      reason:
        reason ||
        (status === "expired"
          ? "expired"
          : status === "invalidated"
            ? "invalidated"
            : changedFields.length
              ? "binding-changed"
              : ""),
      changedFields,
      currentBinding,
    };
  }

  if (explicitCurrent === true) {
    return {
      current: true,
      reason: reason || (status === "pending" ? "pending" : "decided"),
      changedFields,
      currentBinding,
    };
  }

  if (changedFields.length > 0) {
    return {
      current: false,
      reason: reason || "binding-changed",
      changedFields,
      currentBinding,
    };
  }

  if (bindingMismatched(binding, currentBinding)) {
    return {
      current: false,
      reason: reason || "binding-changed",
      changedFields: changedFields.length
        ? changedFields
        : diffBinding(binding, currentBinding),
      currentBinding,
    };
  }

  if (isExpiryElapsed(binding.expiresAt)) {
    return {
      current: false,
      reason: reason || "expired",
      changedFields,
      currentBinding,
    };
  }

  return {
    current: status === "pending" || status === "approved",
    reason: reason || (status === "pending" ? "pending" : "decided"),
    changedFields,
    currentBinding,
  };
}

function parseChangedFields(raw: unknown): BindingChangeField[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: BindingChangeField[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const folded = item.trim();
    if (isChangeField(folded) && !out.includes(folded)) {
      out.push(folded);
    }
  }
  return out;
}

function parseActions(raw: unknown): ApprovalAction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ApprovalAction[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const folded = item.trim();
    if (isApprovalAction(folded) && !out.includes(folded)) {
      out.push(folded);
    }
  }
  return out;
}

export function parseApprovalRequest(raw: unknown): ApprovalRequest | null {
  const stripped: string[] = [];
  const cleaned = stripSecretKeys(raw, stripped);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return null;
  }
  const row = cleaned as Record<string, unknown>;
  const id = readString(row.id);
  const statusRaw = readString(row.status);
  const binding = parseApprovalBinding(row.binding);
  if (!isUuid(id) || !isApprovalStatus(statusRaw) || !binding) {
    return null;
  }
  return {
    id,
    status: statusRaw,
    binding,
    validity: parseValidity(row.validity, statusRaw, binding),
    requestedBy: readString(row.requestedBy, row.requested_by),
    requestedAt: readString(row.requestedAt, row.requested_at),
    decidedBy: readString(row.decidedBy, row.decided_by),
    decidedAt: readString(row.decidedAt, row.decided_at),
    note: readString(row.note),
    workflowId: readString(row.workflowId, row.workflow_id),
    workflowName: readString(row.workflowName, row.workflow_name),
    executionId: readString(row.executionId, row.execution_id),
    executionStatus: readString(row.executionStatus, row.execution_status),
    permittedActions: parseActions(
      row.permittedActions ?? row.permitted_actions,
    ),
  };
}

export function parseApprovalList(raw: unknown): ApprovalRequest[] {
  const stripped: string[] = [];
  const cleaned = stripSecretKeys(raw, stripped);
  if (!cleaned || typeof cleaned !== "object") {
    return [];
  }
  const items = Array.isArray(cleaned)
    ? cleaned
    : (cleaned as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }
  const out: ApprovalRequest[] = [];
  for (const item of items) {
    const parsed = parseApprovalRequest(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

export function parsePolicyEvaluation(raw: unknown): PolicyEvaluation | null {
  const stripped: string[] = [];
  const cleaned = stripSecretKeys(raw, stripped);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return null;
  }
  const row = cleaned as Record<string, unknown>;
  const decisionRaw = readString(row.decision);
  const workflowVersionId = readString(
    row.workflowVersionId,
    row.workflow_version_id,
  );
  if (!isPolicyDecision(decisionRaw)) {
    return null;
  }
  return {
    decision: decisionRaw,
    evaluationId: readString(row.evaluationId, row.evaluation_id),
    workflowVersionId,
    operation: readString(row.operation),
    requirements: parseApprovalList(
      row.requirements ?? row.items ?? row.approvals,
    ),
  };
}

export function isExpiryElapsed(
  expiresAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!expiresAt) {
    return false;
  }
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms <= now;
}

export function isApprovalExpired(
  approval: Pick<ApprovalRequest, "status" | "binding" | "validity">,
  now = Date.now(),
): boolean {
  if (approval.status === "expired" || approval.validity.reason === "expired") {
    return true;
  }
  return isExpiryElapsed(approval.binding.expiresAt, now);
}

export function isApprovalInvalidated(
  approval: Pick<ApprovalRequest, "status" | "validity">,
): boolean {
  if (approval.status === "invalidated") {
    return true;
  }
  return (
    approval.validity.reason === "invalidated" ||
    approval.validity.reason === "binding-changed" ||
    approval.validity.changedFields.length > 0
  );
}

export function bindingMismatched(
  bound: ApprovalBinding,
  current: ApprovalBinding | null,
): boolean {
  if (!current) {
    return false;
  }
  return diffBinding(bound, current).length > 0;
}

export function diffBinding(
  bound: ApprovalBinding,
  current: ApprovalBinding | null,
): BindingChangeField[] {
  if (!current) {
    return [];
  }
  const changed: BindingChangeField[] = [];
  if (
    bound.workflowVersionId !== current.workflowVersionId ||
    (bound.workflowVersionDigest &&
      current.workflowVersionDigest &&
      bound.workflowVersionDigest !== current.workflowVersionDigest)
  ) {
    changed.push("workflowVersion");
  }
  if (
    (bound.targetId && current.targetId && bound.targetId !== current.targetId) ||
    (bound.targetKind &&
      current.targetKind &&
      bound.targetKind !== current.targetKind)
  ) {
    changed.push("target");
  }
  if (
    bound.policyRevisionId &&
    current.policyRevisionId &&
    bound.policyRevisionId !== current.policyRevisionId
  ) {
    changed.push("policyRevision");
  }
  if (bound.operation && current.operation && bound.operation !== current.operation) {
    changed.push("operation");
  }
  return changed;
}

export function invalidationSummary(approval: ApprovalRequest): string {
  if (isApprovalExpired(approval)) {
    return "This approval has expired. A new server-side evaluation is required.";
  }
  if (!isApprovalInvalidated(approval)) {
    return "";
  }
  const fields = approval.validity.changedFields;
  if (fields.length === 0) {
    return "Prior approval is no longer valid. Policy, target, or version changed.";
  }
  return `Prior approval is no longer valid. Changed: ${fields.join(", ")}.`;
}

/**
 * Decide is allowed only when the server says the snapshot is still
 * current and pending. Expiry and invalidation fail closed in the UI;
 * the POST is still the authority.
 */
export function canDecideApproval(
  approval: ApprovalRequest,
  now = Date.now(),
): boolean {
  if (approval.status !== "pending") {
    return false;
  }
  if (!approval.validity.current) {
    return false;
  }
  if (isApprovalExpired(approval, now) || isApprovalInvalidated(approval)) {
    return false;
  }
  return (
    approval.permittedActions.includes("approve") ||
    approval.permittedActions.includes("reject")
  );
}

export function canSeeApprovalsNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return true;
  }
  return permissions.includes("approval.view");
}

export function canDecideFromPermissions(
  permissions: readonly string[] | null | undefined,
): boolean {
  return Boolean(permissions?.includes("approval.decide"));
}

export function isExecutionAwaitingApproval(status: string | undefined): boolean {
  return Boolean(
    status &&
      (EXECUTION_WAITING_STATUSES as readonly string[]).includes(status),
  );
}

export function pendingApprovals(items: readonly ApprovalRequest[]): ApprovalRequest[] {
  return items.filter((item) => item.status === "pending");
}

export function filterApprovalList(
  items: readonly ApprovalRequest[],
  query: { q?: string; status?: string },
): ApprovalRequest[] {
  const q = query.q?.trim().toLowerCase() ?? "";
  const status = query.status?.trim() ?? "";
  return items.filter((item) => {
    if (status && item.status !== status) {
      return false;
    }
    if (!q) {
      return true;
    }
    const haystack = [
      item.id,
      item.workflowName,
      item.binding.operation,
      item.binding.targetName,
      item.binding.workflowVersionDigest,
      item.status,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Dispatch is allowed only when the latest server evaluation is `allow`.
 * A local/stale "approved" flag is ignored on purpose.
 */
export function canDispatchFromEvaluation(
  evaluation: PolicyEvaluation | null,
): boolean {
  return evaluation?.decision === "allow";
}

export function shouldBlockRun(options: {
  evaluation: PolicyEvaluation | null;
  evaluationProblem?: ProblemDetails | null;
  staleLocalApproved?: boolean;
}): boolean {
  void options.staleLocalApproved;
  if (options.evaluation) {
    return !canDispatchFromEvaluation(options.evaluation);
  }
  if (
    options.evaluationProblem &&
    problemClosesApproval(options.evaluationProblem)
  ) {
    return true;
  }
  return false;
}

export function approvalStatusLabel(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "invalidated":
      return "Invalidated";
  }
}

export function policyDecisionLabel(decision: PolicyDecision): string {
  switch (decision) {
    case "allow":
      return "Allowed";
    case "deny":
      return "Denied";
    case "approval_required":
      return "Approval required";
  }
}

export function problemClosesApproval(problem: ProblemDetails): boolean {
  return (
    isExpiredProblemCode(problem.code) ||
    isInvalidatedProblemCode(problem.code) ||
    isDeniedProblemCode(problem.code)
  );
}

export function failClosedProblemTitle(problem: ProblemDetails): string {
  if (isExpiredProblemCode(problem.code)) {
    return "Approval expired";
  }
  if (isInvalidatedProblemCode(problem.code)) {
    return "Approval invalidated";
  }
  if (isDeniedProblemCode(problem.code)) {
    return "Approval denied";
  }
  return problem.title;
}

/** Browser persistence is forbidden for approval/decision tokens. */
export const FORBIDDEN_APPROVAL_STORAGE = ["localStorage", "sessionStorage"] as const;
