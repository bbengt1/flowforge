/**
 * E4.3 policy-eval / approvals shapes (Chloe UI scaffold).
 *
 * Jonny's route map is still in flight. These types are the UI contract
 * the retarget adapter (`approval-contract.ts`) normalizes into. Do not
 * persist tokens or treat a local "approved" flag as dispatch authority.
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
  "approval_required",
] as const;

export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const APPROVAL_ACTIONS = ["approve", "reject"] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

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
] as const;

export type ValidityReason = (typeof VALIDITY_REASONS)[number];

export const DEFAULT_PRE_RUN_OPERATION = "workflow.execute";

export const EXECUTION_WAITING_STATUSES = [
  "waiting",
  "awaiting_approval",
  "waiting_approval",
  "approval_required",
] as const;

/** Read-only snapshot bound at request time. Server is the source of truth. */
export type ApprovalBinding = {
  workflowVersionId: string;
  workflowVersionDigest: string;
  targetId: string;
  targetKind: string;
  targetName: string;
  policyRevisionId: string;
  policyRevisionNumber: number | null;
  policyDigest: string;
  operation: string;
  expiresAt: string;
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
  permittedActions: ApprovalAction[];
};

export type PolicyEvaluation = {
  decision: PolicyDecision;
  evaluationId: string;
  workflowVersionId: string;
  operation: string;
  requirements: ApprovalRequest[];
};

export type EvaluatePolicyBody = {
  workflowVersionId: string;
  operation?: string;
  targetId?: string;
  targetKind?: string;
  executionId?: string;
  nodeId?: string;
};

export type DecideApprovalBody = {
  note?: string;
};

export type ApprovalList = {
  items: ApprovalRequest[];
};
