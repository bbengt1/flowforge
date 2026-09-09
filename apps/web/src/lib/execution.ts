/**
 * E5.1 execution history helpers aligned to jonny's #51 OpenAPI.
 *
 * List/detail show safe metadata plus already-redacted input/output/audit
 * (`[redacted]`). Unexpected secret field names are a contract bug: strip,
 * never display. `indeterminate` is first-class. 403 is fail-closed.
 */

import {
  EXECUTION_PROBLEM_CODES,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_REPLAY_MESSAGE,
  executionHistoryHref,
} from "./execution-contract.ts";
import {
  EXECUTION_STATUSES,
  EXECUTION_VIEW_PERMISSION,
  REDACTED_MARKER,
  type ExecutionAuditEvent,
  type ExecutionDetail,
  type ExecutionDetailView,
  type ExecutionJob,
  type ExecutionListQuery,
  type ExecutionListRow,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutionStep,
} from "./execution-types.ts";
import { parseAuthorizedPins } from "./ops-config.ts";
import type { ProblemDetails } from "./problem.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_KEY_ALIASES = new Set([
  "authorization",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "bearer",
  "ciphertext",
  "client_secret",
  "clientsecret",
  "connection_string",
  "connectionstring",
  "cookie",
  "database_url",
  "dek_envelope",
  "dekenvelope",
  "dsn",
  "kubeconfig",
  "password",
  "passwd",
  "passphrase",
  "plaintext",
  "private_key",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secrets",
  "set_cookie",
  "token",
  "webhook_secret",
  "webhooksecret",
]);

const SECRET_KEY_PARTS = [
  "password",
  "secret",
  "token",
  "authorization",
  "credential",
  "api_key",
  "private_key",
  "kubeconfig",
  "passphrase",
  "ciphertext",
];

/** Documented metadata + already-redacted payloads from #51. */
const NEVER_STRIP_KEYS = new Set([
  "id",
  "workflowid",
  "workflow_id",
  "workflowname",
  "workflow_name",
  "workflowslug",
  "workflow_slug",
  "workflowversionid",
  "workflow_version_id",
  "workflowversionnumber",
  "workflow_version_number",
  "workflowdigest",
  "workflow_digest",
  "status",
  "startedat",
  "started_at",
  "finishedat",
  "finished_at",
  "createdat",
  "created_at",
  "updatedat",
  "updated_at",
  "retentionuntil",
  "retention_until",
  "correlationid",
  "correlation_id",
  "idempotencykey",
  "idempotency_key",
  "replayed",
  "reused",
  "requestedby",
  "requested_by",
  "triggerid",
  "trigger_id",
  "executionid",
  "execution_id",
  "nodeid",
  "node_id",
  "nodetype",
  "node_type",
  "nodename",
  "node_name",
  "attempt",
  "fencingtoken",
  "fencing_token",
  "workerid",
  "worker_id",
  "availableat",
  "available_at",
  "leaseexpiresat",
  "lease_expires_at",
  "heartbeatat",
  "heartbeat_at",
  "executionstepid",
  "execution_step_id",
  "action",
  "outcome",
  "resourcetype",
  "resource_type",
  "resourceid",
  "resource_id",
  "occurredat",
  "occurred_at",
  "actorid",
  "actor_id",
  "hostcontext",
  "host_context",
  "policysnapshot",
  "policy_snapshot",
  "input",
  "output",
  "error",
  "details",
  "items",
  "steps",
  "jobs",
  "pins",
  "auditevents",
  "audit_events",
  "events",
]);

export function isUuid(value: string | undefined): boolean {
  return Boolean(value && UUID.test(value));
}

export function normalizeSecretKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

export function isSecretFieldName(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  const compact = normalized.replace(/_/g, "");
  if (NEVER_STRIP_KEYS.has(normalized) || NEVER_STRIP_KEYS.has(compact)) {
    return false;
  }
  if (SECRET_KEY_ALIASES.has(compact) || SECRET_KEY_ALIASES.has(normalized)) {
    return true;
  }
  return SECRET_KEY_PARTS.some(
    (part) =>
      normalized === part ||
      normalized.endsWith(`_${part}`) ||
      normalized.startsWith(`${part}_`) ||
      normalized.includes(`_${part}_`),
  );
}

export function stripSecretFields(
  value: unknown,
  strippedKeys: string[] = [],
  path = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      stripSecretFields(
        item,
        strippedKeys,
        path ? `${path}[${index}]` : `[${index}]`,
      ),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSecretFieldName(key)) {
      if (child === REDACTED_MARKER) {
        out[key] = REDACTED_MARKER;
        continue;
      }
      strippedKeys.push(childPath);
      continue;
    }
    out[key] = stripSecretFields(child, strippedKeys, childPath);
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

function readBoolean(...candidates: unknown[]): boolean {
  for (const value of candidates) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const folded = value.trim().toLowerCase();
      if (folded === "true" || folded === "1") {
        return true;
      }
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isIndeterminateStatus(status: string | undefined): boolean {
  return status?.trim().toLowerCase() === "indeterminate";
}

export function executionStatusLabel(status: ExecutionStatus | undefined): string {
  const folded = status?.trim() || "unknown";
  if (folded === "cancelled") {
    return "canceled";
  }
  return folded;
}

/** POST start: 200 + replayed, or an explicit replayed flag. GET 200 is not a replay. */
export function isIdempotentReplay(record: {
  replayed?: boolean;
  reused?: boolean;
  statusCode?: number;
  method?: string;
}): boolean {
  if (record.replayed || record.reused) {
    return true;
  }
  return record.method === "POST" && record.statusCode === 200;
}

export function isExecutionCreated(statusCode: number | undefined): boolean {
  return statusCode === 201;
}

export function isIdempotencyConflict(
  problem: ProblemDetails | null | undefined,
): boolean {
  return (
    problem?.status === 409 ||
    problem?.code === EXECUTION_PROBLEM_CODES.conflict
  );
}

export function idempotencyReplayMessage(replayed: boolean): string {
  return replayed ? IDEMPOTENCY_REPLAY_MESSAGE : "";
}

export function startOutcomeMessage(statusCode: number, replayed: boolean): string {
  if (replayed || statusCode === 200) {
    return IDEMPOTENCY_REPLAY_MESSAGE;
  }
  if (statusCode === 201) {
    return IDEMPOTENCY_CREATED_MESSAGE;
  }
  return "";
}

export function canSeeExecutionsNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return true;
  }
  return permissions.includes(EXECUTION_VIEW_PERMISSION);
}

export function isExecutionForbidden(
  problem: ProblemDetails | null | undefined,
): boolean {
  return (
    problem?.status === 403 ||
    problem?.code === EXECUTION_PROBLEM_CODES.forbidden
  );
}

export function parseExecutionRecord(raw: unknown): ExecutionRecord | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const row = asRecord(cleaned);
  if (!row) {
    return null;
  }
  const nested = asRecord(row.execution) ?? row;
  const id = readString(nested.id);
  const workflowId = readString(nested.workflowId, nested.workflow_id);
  const workflowVersionId = readString(
    nested.workflowVersionId,
    nested.workflow_version_id,
  );
  if (!isUuid(id) || !isUuid(workflowId) || !isUuid(workflowVersionId)) {
    return null;
  }
  return {
    id,
    workflowId,
    workflowName: readString(nested.workflowName, nested.workflow_name),
    workflowSlug: readString(nested.workflowSlug, nested.workflow_slug),
    workflowVersionId,
    workflowVersionNumber: readNumber(
      nested.workflowVersionNumber,
      nested.workflow_version_number,
    ),
    workflowDigest: readString(nested.workflowDigest, nested.workflow_digest),
    status: readString(nested.status) || "queued",
    startedAt: readString(nested.startedAt, nested.started_at),
    finishedAt: readString(nested.finishedAt, nested.finished_at),
    createdAt: readString(nested.createdAt, nested.created_at),
    updatedAt: readString(nested.updatedAt, nested.updated_at),
    retentionUntil: readString(nested.retentionUntil, nested.retention_until),
    correlationId: readString(nested.correlationId, nested.correlation_id),
    idempotencyKey: readString(nested.idempotencyKey, nested.idempotency_key),
    replayed: readBoolean(nested.replayed, nested.reused),
    requestedBy: readString(nested.requestedBy, nested.requested_by),
    triggerId: readString(nested.triggerId, nested.trigger_id),
    input: nested.input ?? null,
    policySnapshot: nested.policySnapshot ?? nested.policy_snapshot ?? null,
  };
}

export function parseExecutionList(raw: unknown): ExecutionRecord[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const body = raw as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items : [];
  const out: ExecutionRecord[] = [];
  for (const item of items) {
    const parsed = parseExecutionRecord(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

export function parseExecutionStep(
  raw: unknown,
  executionId = "",
): ExecutionStep | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const row = asRecord(cleaned);
  if (!row) {
    return null;
  }
  const id = readString(row.id);
  const nodeId = readString(row.nodeId, row.node_id);
  if (!id || !nodeId) {
    return null;
  }
  return {
    id,
    executionId: readString(row.executionId, row.execution_id) || executionId,
    nodeId,
    nodeType: readString(row.nodeType, row.node_type),
    attempt: readNumber(row.attempt) ?? 1,
    status: readString(row.status) || "queued",
    startedAt: readString(row.startedAt, row.started_at),
    finishedAt: readString(row.finishedAt, row.finished_at),
    createdAt: readString(row.createdAt, row.created_at),
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    fencingToken: readNumber(row.fencingToken, row.fencing_token),
    workerId: readString(row.workerId, row.worker_id),
  };
}

export function parseExecutionJob(
  raw: unknown,
  executionId = "",
): ExecutionJob | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const row = asRecord(cleaned);
  if (!row) {
    return null;
  }
  const id = readString(row.id);
  if (!id) {
    return null;
  }
  return {
    id,
    executionId: readString(row.executionId, row.execution_id) || executionId,
    executionStepId: readString(row.executionStepId, row.execution_step_id),
    status: readString(row.status) || "queued",
    attempt: readNumber(row.attempt),
    availableAt: readString(row.availableAt, row.available_at),
    leaseExpiresAt: readString(row.leaseExpiresAt, row.lease_expires_at),
    heartbeatAt: readString(row.heartbeatAt, row.heartbeat_at),
    workerId: readString(row.workerId, row.worker_id),
    fencingToken: readNumber(row.fencingToken, row.fencing_token),
  };
}

export function parseExecutionEvent(raw: unknown): ExecutionAuditEvent | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const row = asRecord(cleaned);
  if (!row) {
    return null;
  }
  const id = readString(row.id);
  const action = readString(row.action, row.eventType, row.event_type);
  if (!id || !action) {
    return null;
  }
  return {
    id,
    action,
    outcome: readString(row.outcome),
    resourceType: readString(row.resourceType, row.resource_type),
    resourceId: readString(row.resourceId, row.resource_id),
    correlationId: readString(row.correlationId, row.correlation_id),
    occurredAt: readString(row.occurredAt, row.occurred_at, row.createdAt),
    actorId: readString(row.actorId, row.actor_id),
    details: row.details ?? null,
    hostContext: row.hostContext ?? row.host_context ?? null,
  };
}

export function parseItemList<T>(
  raw: unknown,
  parse: (item: unknown) => T | null,
): T[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const body = raw as Record<string, unknown>;
  const items = Array.isArray(body.items)
    ? body.items
    : Array.isArray(raw)
      ? raw
      : [];
  const out: T[] = [];
  for (const item of items) {
    const parsed = parse(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

export function parseExecutionDetail(raw: unknown): ExecutionDetail | null {
  const record = parseExecutionRecord(raw);
  if (!record) {
    return null;
  }
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const body = asRecord(cleaned) ?? {};
  const nested = asRecord(body.execution) ?? body;
  const auditSource =
    nested.auditEvents ??
    nested.audit_events ??
    body.auditEvents ??
    body.audit_events ??
    nested.events ??
    body.events;
  return {
    ...record,
    pins: parseAuthorizedPins(nested.pins ?? body.pins),
    steps: parseItemList(nested.steps ?? body.steps, (item) =>
      parseExecutionStep(item, record.id),
    ),
    jobs: parseItemList(nested.jobs ?? body.jobs, (item) =>
      parseExecutionJob(item, record.id),
    ),
    auditEvents: parseItemList(auditSource, parseExecutionEvent),
  };
}

export function filterExecutionList(
  items: ExecutionRecord[],
  query: ExecutionListQuery,
): ExecutionRecord[] {
  const workflowId = query.workflowId?.trim();
  const status = query.status?.trim().toLowerCase();
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.max(0, Math.min(100, Math.trunc(query.limit)))
      : undefined;

  const filtered = items.filter((item) => {
    if (workflowId && item.workflowId !== workflowId) {
      return false;
    }
    if (status && item.status.toLowerCase() !== status) {
      return false;
    }
    return true;
  });
  return limit == null ? filtered : filtered.slice(0, limit);
}

export function versionPinLabel(record: ExecutionRecord): string {
  const number =
    record.workflowVersionNumber != null
      ? `v${record.workflowVersionNumber}`
      : "version";
  const digest = record.workflowDigest
    ? record.workflowDigest.replace(/^sha256:/, "").slice(0, 12)
    : record.workflowVersionId.slice(0, 8);
  return `${number} · ${digest}`;
}

export function workflowLabel(record: ExecutionRecord): string {
  return record.workflowName || record.workflowSlug || record.workflowId;
}

export function executionListRow(record: ExecutionRecord): ExecutionListRow {
  return {
    id: record.id,
    href: executionHistoryHref(record.id, record.workflowId),
    workflowLabel: workflowLabel(record),
    versionPin: versionPinLabel(record),
    status: record.status,
    indeterminate: isIndeterminateStatus(record.status),
    startedAt: record.startedAt || record.createdAt || "—",
    finishedAt: record.finishedAt || "—",
    correlationId: record.correlationId || "—",
    idempotencyKey: record.idempotencyKey || "—",
    replayed: record.replayed,
  };
}

export function executionListDisplay(items: ExecutionRecord[]): ExecutionListRow[] {
  return items.map(executionListRow);
}

export function executionDetailDisplay(
  detail: ExecutionDetail,
): ExecutionDetailView {
  return {
    header: executionListRow(detail),
    replayedMessage: idempotencyReplayMessage(detail.replayed),
    pins: detail.pins,
    steps: detail.steps,
    jobs: detail.jobs,
    auditEvents: detail.auditEvents,
    input: detail.input,
    policySnapshot: detail.policySnapshot,
  };
}

/** Concatenate operator-visible text so tests can assert redaction. */
export function executionListText(items: ExecutionRecord[]): string {
  return executionListDisplay(items)
    .map((row) =>
      [
        row.id,
        row.workflowLabel,
        row.versionPin,
        row.status,
        row.startedAt,
        row.finishedAt,
        row.correlationId,
        row.idempotencyKey,
        row.replayed ? IDEMPOTENCY_REPLAY_MESSAGE : "",
      ].join(" "),
    )
    .join("\n");
}

export function executionDetailText(detail: ExecutionDetail): string {
  const view = executionDetailDisplay(detail);
  const parts = [
    executionListText([detail]),
    view.replayedMessage,
    redactedJson(view.input),
    ...view.steps.map((step) =>
      [
        step.id,
        step.nodeId,
        step.nodeType,
        step.status,
        redactedJson(step.output ?? step.error),
      ].join(" "),
    ),
    ...view.jobs.map((job) =>
      [job.id, job.status, job.workerId, job.executionStepId].join(" "),
    ),
    ...view.auditEvents.map((event) =>
      [event.id, event.action, event.outcome, redactedJson(event.details)].join(
        " ",
      ),
    ),
  ];
  return parts.join("\n");
}

export function containsUnredactedSecret(text: string): boolean {
  const folded = text.toLowerCase();
  return (
    folded.includes("-----begin") ||
    folded.includes("hunter2") ||
    folded.includes("super-secret") ||
    folded.includes("should-not-leak") ||
    folded.includes("cluster-admin")
  );
}

export function redactedJson(value: unknown): string {
  if (value == null || value === "") {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return REDACTED_MARKER;
  }
}

export function documentedExecutionStatuses(): readonly string[] {
  return EXECUTION_STATUSES;
}
