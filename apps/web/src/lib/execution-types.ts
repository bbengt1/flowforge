/** Shapes for Chloe's E5.1 execution history UI. Jonny's query APIs are in flight. */

export const EXECUTION_STATUSES = [
  "queued",
  "pinned",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "cancelled",
  "indeterminate",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number] | string;

export const EXECUTION_VIEW_PERMISSION = "execution.view";

export type ExecutionListQuery = {
  workflowId?: string;
  workflowVersionId?: string;
  status?: string;
  startedAfter?: string;
  startedBefore?: string;
  correlationId?: string;
};

export type ExecutionRecord = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowSlug: string;
  workflowVersionId: string;
  workflowVersionNumber: number | null;
  workflowDigest: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  correlationId: string;
  idempotencyKey: string;
  reused: boolean;
  requestedBy: string;
  triggerId: string;
};

export type ExecutionStep = {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  nodeName: string;
  attempt: number;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  outputRedacted: unknown;
  errorRedacted: unknown;
  inputRedacted: unknown;
};

export type ExecutionJob = {
  id: string;
  executionId: string;
  executionStepId: string;
  status: string;
  attempt: number | null;
  availableAt: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  workerId: string;
};

export type ExecutionAuditEvent = {
  id: string;
  action: string;
  outcome: string;
  resourceType: string;
  resourceId: string;
  correlationId: string;
  occurredAt: string;
  actorId: string;
  detailsRedacted: unknown;
};

export type ExecutionDetail = ExecutionRecord & {
  inputRedacted: unknown;
  steps: ExecutionStep[];
  jobs: ExecutionJob[];
  events: ExecutionAuditEvent[];
};

export type ExecutionListRow = {
  id: string;
  href: string;
  workflowLabel: string;
  versionPin: string;
  status: ExecutionStatus;
  indeterminate: boolean;
  startedAt: string;
  finishedAt: string;
  correlationId: string;
  idempotencyKey: string;
  reused: boolean;
};

export type ExecutionDetailView = {
  header: ExecutionListRow;
  reusedMessage: string;
  steps: ExecutionStep[];
  jobs: ExecutionJob[];
  events: ExecutionAuditEvent[];
  inputRedacted: unknown;
};
