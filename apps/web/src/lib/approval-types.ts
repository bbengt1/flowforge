/**
 * E4.3 policy-eval / approvals shapes aligned to #44 on `main`.
 *
 * Do not persist tokens or treat a local "approved" flag as dispatch
 * authority. Server-side recheck is authoritative.
 */

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "invalidated",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const POLICY_DECISIONS = [
  "allow",
  "deny",
  "approval-required",
] as const;

export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const APPROVAL_ACTIONS = ["approve", "reject"] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const DECIDE_DECISIONS = ["approved", "rejected"] as const;

export type DecideDecision = (typeof DECIDE_DECISIONS)[number];

export const BINDING_CHANGE_FIELDS = [
  "workflowVersion",
  "target",
  "policyRevision",
  "operation",
] as const;

export type BindingChangeField = (typeof BINDING_CHANGE_FIELDS)[number];

export const VALIDITY_REASONS = [
  "pending",
  "decided",
  "expired",
  "invalidated",
  "binding-changed",
  "denied",
  "self-approval",
] as const;

export type ValidityReason = (typeof VALIDITY_REASONS)[number];

export const DEFAULT_PRE_RUN_OPERATION = "workflow.execute";

export const EXECUTION_WAITING_STATUSES = [
  "waiting",
  "awaiting_approval",
  "waiting_approval",
  "approval_required",
  "approval-required",
] as const;

export const APPROVAL_INVALIDATING_KINDS = [
  "policy",
  "cluster_target",
  "ssh_target",
] as const;

export type ApprovalListFilter = {
  status?: string;
  workflowId?: string;
  workflowVersionId?: string;
  executionId?: string;
};

/** Read-only snapshot bound at request time. Server is the source of truth. */
export type ApprovalBinding = {
  workflowVersionId: string;
  workflowVersionDigest: string;
  targetId: string;
  targetKind: string;
  targetName: string;
  targetVersionId: string;
  targetDigest: string;
  policyResourceId: string;
  policyRevisionId: string;
  policyRevisionNumber: number | null;
  policyDigest: string;
  operation: string;
  nodeId: string;
  nodeName: string;
  expiresAt: string;
  bindingFingerprint: string;
};

export type ApprovalValidity = {
  current: boolean;
  reason: ValidityReason | "";
  changedFields: BindingChangeField[];
  currentBinding: ApprovalBinding | null;
};

export type ApprovalRequest = {
  id: string;
  status: ApprovalStatus;
  binding: ApprovalBinding;
  validity: ApprovalValidity;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string;
  decidedAt: string;
  note: string;
  workflowId: string;
  workflowName: string;
  executionId: string;
  executionStatus: string;
  approverRole: string;
  permittedActions: ApprovalAction[];
};

/** Evaluate `requirements[]` — not yet a stored approval row. */
export type PolicyRequirement = {
  nodeId: string;
  nodeName: string;
  operation: string;
  targetKind: string;
  targetId: string;
  targetVersionId: string;
  policyResourceId: string;
  policyVersionId: string;
  policyRevision: number | null;
  approverRole: string;
  expiresIn: string;
  expiresAt: string;
  reason: string;
};

export type PolicyDenied = {
  nodeId: string;
  operation: string;
  decision: string;
  reason: string;
};

export type PolicyEvaluation = {
  decision: PolicyDecision;
  dispatchAllowed: boolean;
  evaluationId: string;
  workflowVersionId: string;
  workflowDigest: string;
  operation: string;
  requirements: PolicyRequirement[];
  approvals: ApprovalRequest[];
  denied: PolicyDenied[];
};

export type EvaluatePolicyBody = {
  workflowId: string;
  workflowVersionId: string;
};

export type CreateApprovalsBody = {
  workflowId: string;
  workflowVersionId: string;
};

export type DecideApprovalBody = {
  decision: DecideDecision;
  note?: string;
};

export type ApprovalCatalog = {
  statuses: string[];
  decisions: string[];
  defaultExpiresIn: string;
};

export type ApprovalEvent = {
  id: string;
  approvalId: string;
  eventType: string;
  actorId: string;
  occurredAt: string;
};

export type ApprovalList = {
  items: ApprovalRequest[];
};
