/** Shapes from jonny's E5.1 OpenAPI (PR #51). Do not invent fields or routes. */

import type { OpsConfigPin } from "./ops-config-types.ts";

export const EXECUTION_STATUSES = [
  "queued",
  "pinned",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "indeterminate",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number] | string;

export const EXECUTION_VIEW_PERMISSION = "execution.view";

export const REDACTED_MARKER = "[redacted]";

/** Documented list query for GET /executions and GET /workflows/{id}/executions. */
export type ExecutionListQuery = {
  workflowId?: string;
  status?: string;
  limit?: number;
};

export type AuditEventQuery = {
  resourceType?: string;
  resourceId?: string;
  action?: string;
  limit?: number;
};

export type ExecutionStartBody = {
  workflowVersionId: string;
  idempotencyKey?: string;
  input?: Record<string, unknown>;
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
  updatedAt: string;
  retentionUntil: string;
  correlationId: string;
  idempotencyKey: string;
  replayed: boolean;
  requestedBy: string;
  triggerId: string;
  input: unknown;
  policySnapshot: unknown;
};

export type ExecutionStep = {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  input: unknown;
  output: unknown;
  error: unknown;
  fencingToken: number | null;
  workerId: string;
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
  fencingToken: number | null;
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
  details: unknown;
  hostContext: unknown;
};

export type ExecutionDetail = ExecutionRecord & {
  pins: OpsConfigPin[];
  steps: ExecutionStep[];
  jobs: ExecutionJob[];
  auditEvents: ExecutionAuditEvent[];
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
  replayed: boolean;
};

export type ExecutionDetailView = {
  header: ExecutionListRow;
  replayedMessage: string;
  pins: OpsConfigPin[];
  steps: ExecutionStep[];
  jobs: ExecutionJob[];
  auditEvents: ExecutionAuditEvent[];
  input: unknown;
  policySnapshot: unknown;
};
