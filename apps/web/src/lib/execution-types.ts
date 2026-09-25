/** Shapes from jonny's E5.1 OpenAPI (#51), E5.2 #53 cancel/retry, and E5.3 #56 artifacts. Do not invent fields or routes. */

import type { OpsConfigPin } from "./ops-config-types.ts";

/**
 * Run status values. Unchanged by upstream-edge holding: a run is not
 * `blocked`, `pending`, or `skipped`. Those belong on steps and jobs.
 */
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
  "blocked",
  "queued",
  "claimed",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "indeterminate",
  "skipped",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number] | string;

/**
 * Step status values. `pending` waits on unresolved inputs.
 * `skipped` has finished and does not fail the run.
 * `blocked` is a job status, not a step status.
 */
export const STEP_STATUSES = [
  "pending",
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "indeterminate",
  "skipped",
] as const;

/**
 * A step (or a skipped job) has finished. `skipped` is terminal and
 * does not fail the run. `pending` and job `blocked` are not terminal.
 */
export const TERMINAL_STEP_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
  "indeterminate",
  "skipped",
] as const;

/** #53: Cancel when queued or running. Other terminals are 409. */
export const CANCELABLE_STATUSES = ["queued", "running"] as const;

/** #53: Retry only failed/canceled core data.* / flow.* steps — never indeterminate. */
export const RETRYABLE_STATUSES = ["failed", "canceled"] as const;

export const BLOCKED_STATUS_LABEL = "Blocked";
export const PENDING_STATUS_LABEL = "Pending";
export const SKIPPED_STATUS_LABEL = "Skipped";
export const NOT_REACHED_STATUS_LABEL = "Not reached";

export const BLOCKED_STATUS_ICON = "‖";
export const PENDING_STATUS_ICON = "…";
export const SKIPPED_STATUS_ICON = "⊘";
export const NOT_REACHED_STATUS_ICON = "–";

export const BLOCKED_STATUS_HELP = "Waiting for upstream steps to finish.";
export const PENDING_STATUS_HELP = "Not started yet. Waiting on inputs.";
export const SKIPPED_STATUS_HELP =
  "Didn't run because an upstream approval was rejected or expired, or its branch wasn't taken. Not a failure.";
export const NOT_REACHED_STATUS_HELP =
  "The run failed before this step's inputs were ready. Retrying the failed upstream step can still release it.";

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
  /**
   * Opaque keyset token from the previous `next`. Keep it in memory.
   * Do not copy it into the browser URL or localStorage.
   */
  cursor?: string;
  /** Server substring: workflow name, slug, correlation id, status. */
  q?: string;
};

export type AuditEventQuery = {
  resourceType?: string;
  resourceId?: string;
  action?: string;
  limit?: number;
  cursor?: string;
  q?: string;
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
    | "blocked"
    | "pending"
    | "skipped"
    | "not-reached"
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
