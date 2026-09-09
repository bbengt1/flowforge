/** Shapes from jonny's E5.1 OpenAPI (#51), E5.2 #53 cancel/retry, and E5.3 #56 artifacts. Do not invent fields or routes. */

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
export const EXECUTION_CANCEL_PERMISSION = "execution.cancel";
export const WORKFLOW_EXECUTE_PERMISSION = "workflow.execute";

export const JOB_STATUSES = [
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "indeterminate",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number] | string;

/** #53: Cancel when queued or running. Other terminals are 409. */
export const CANCELABLE_STATUSES = ["queued", "running"] as const;

/** #53: Retry only failed/canceled core data.* / flow.* steps — never indeterminate. */
export const RETRYABLE_STATUSES = ["failed", "canceled"] as const;

export const REDACTED_MARKER = "[redacted]";

/** Encrypted artifact metadata only — never bucket credentials or durable URLs. */
export const ARTIFACT_METADATA_FIELDS = [
  "name",
  "digest",
  "sizeBytes",
  "classification",
  "retentionUntil",
] as const;

export const ARTIFACT_LOCATOR_KEYS = [
  "url",
  "downloadUrl",
  "download_url",
  "publicUrl",
  "public_url",
  "signedUrl",
  "signed_url",
  "presignedUrl",
  "presigned_url",
  "href",
  "location",
  "storageRef",
  "storage_ref",
  "bucket",
  "bucketName",
  "bucket_name",
  "objectKey",
  "object_key",
  "accessKey",
  "access_key",
  "accessKeyId",
  "access_key_id",
  "secretAccessKey",
  "secret_access_key",
  "endpoint",
  "s3Uri",
  "s3_uri",
  "gsUri",
  "gs_uri",
  "handle",
  "downloadToken",
  "download_token",
  "grantToken",
  "grant_token",
] as const;

/** Bounded log/output display — defense in depth on top of API redaction. */
export const MAX_LOG_CHARS = 8192;
export const MAX_LOG_LINES = 200;

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
  permittedActions: string[];
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
  leaseId: string;
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
  leaseId: string;
};

export type ExecutionArtifact = {
  id: string;
  executionId: string;
  executionStepId: string;
  name: string;
  digest: string;
  sizeBytes: number | null;
  classification: string;
  retentionUntil: string;
  expiresAt: string;
  kind: string;
  redacted: boolean;
  legalHold: boolean;
  deleted: boolean;
  deletedAt: string;
};

export type ExecutionLogSlice = {
  stepId: string;
  lines: string[];
  text: string;
  offset: number;
  nextOffset: number;
  truncated: boolean;
  byteCount: number;
  maxBytes: number;
};

/** Safe operator view of a grant. href / URL / handle must never land here. */
export type DownloadGrantView = {
  id: string;
  artifactId: string;
  expiresAt: string;
  expired: boolean;
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
  artifacts: ExecutionArtifact[];
  legalHold: boolean;
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

export type ExecutionStatusPresentation = {
  status: string;
  label: string;
  icon: string;
  description: string;
  indeterminate: boolean;
  tone:
    | "indeterminate"
    | "running"
    | "canceled"
    | "failed"
    | "succeeded"
    | "queued"
    | "claimed"
    | "other";
};

export type JobDispatchView = {
  id: string;
  status: string;
  presentation: ExecutionStatusPresentation;
  claimed: boolean;
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  workerId: string;
  fencingToken: number | null;
  attempt: number | null;
  executionStepId: string;
};

export type ExecutionDetailView = {
  header: ExecutionListRow;
  replayedMessage: string;
  pins: OpsConfigPin[];
  steps: ExecutionStep[];
  jobs: ExecutionJob[];
  jobViews: JobDispatchView[];
  auditEvents: ExecutionAuditEvent[];
  artifacts: ExecutionArtifact[];
  input: unknown;
  policySnapshot: unknown;
  permittedActions: string[];
  retentionUntil: string;
  legalHold: boolean;
};
