/**
 * E5.1 execution history helpers.
 *
 * List/detail show safe metadata only. Unexpected secret fields on API
 * responses are treated as a contract bug: strip, never display.
 * `indeterminate` is a first-class status. 403 is fail-closed.
 */

import {
  EXECUTION_PROBLEM_CODES,
  IDEMPOTENCY_REPLAY_MESSAGE,
  executionHistoryHref,
} from "./execution-contract.ts";
import {
  EXECUTION_STATUSES,
  EXECUTION_VIEW_PERMISSION,
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
  "output",
  "input",
  "stdout",
  "stderr",
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

/** Metadata keys that contain "token" / "id" but are not secret material. */
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
  "correlationid",
  "correlation_id",
  "idempotencykey",
  "idempotency_key",
  "reused",
  "idempotentreplay",
  "idempotent_replay",
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
  "detailsredacted",
  "details_redacted",
  "inputredacted",
  "input_redacted",
  "outputredacted",
  "output_redacted",
  "errorredacted",
  "error_redacted",
  "items",
  "steps",
  "jobs",
  "events",
  "pins",
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

export function isIdempotentReplay(record: {
  reused?: boolean;
  statusCode?: number;
}): boolean {
  return Boolean(record.reused) || record.statusCode === 200;
}

export function idempotencyReplayMessage(reused: boolean): string {
  return reused ? IDEMPOTENCY_REPLAY_MESSAGE : "";
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
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return null;
  }
  const row = cleaned as Record<string, unknown>;
  const nested =
    row.execution && typeof row.execution === "object"
      ? (row.execution as Record<string, unknown>)
      : row;
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
    correlationId: readString(nested.correlationId, nested.correlation_id),
    idempotencyKey: readString(nested.idempotencyKey, nested.idempotency_key),
    reused: readBoolean(
      nested.reused,
      nested.idempotentReplay,
      nested.idempotent_replay,
      nested.duplicate,
      nested.alreadyExists,
      nested.already_exists,
    ),
    requestedBy: readString(nested.requestedBy, nested.requested_by),
    triggerId: readString(nested.triggerId, nested.trigger_id),
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
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return null;
  }
  const row = cleaned as Record<string, unknown>;
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
    nodeName: readString(row.nodeName, row.node_name),
    attempt: readNumber(row.attempt) ?? 1,
    status: readString(row.status) || "queued",
    startedAt: readString(row.startedAt, row.started_at),
    finishedAt: readString(row.finishedAt, row.finished_at),
    outputRedacted: row.outputRedacted ?? row.output_redacted ?? null,
    errorRedacted: row.errorRedacted ?? row.error_redacted ?? null,
    inputRedacted: row.inputRedacted ?? row.input_redacted ?? null,
  };
}

export function parseExecutionJob(
  raw: unknown,
  executionId = "",
): ExecutionJob | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return null;
  }
  const row = cleaned as Record<string, unknown>;
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
  };
}

export function parseExecutionEvent(raw: unknown): ExecutionAuditEvent | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    return null;
  }
  const row = cleaned as Record<string, unknown>;
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
    detailsRedacted: row.detailsRedacted ?? row.details_redacted ?? null,
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
  const body =
    cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
      ? (cleaned as Record<string, unknown>)
      : {};
  const nested =
    body.execution && typeof body.execution === "object"
      ? (body.execution as Record<string, unknown>)
      : body;
  return {
    ...record,
    inputRedacted: nested.inputRedacted ?? nested.input_redacted ?? null,
    steps: parseItemList(nested.steps ?? body.steps, (item) =>
      parseExecutionStep(item, record.id),
    ),
    jobs: parseItemList(nested.jobs ?? body.jobs, (item) =>
      parseExecutionJob(item, record.id),
    ),
    events: parseItemList(nested.events ?? body.events, parseExecutionEvent),
  };
}

export function filterExecutionList(
  items: ExecutionRecord[],
  query: ExecutionListQuery,
): ExecutionRecord[] {
  const workflowId = query.workflowId?.trim();
  const workflowVersionId = query.workflowVersionId?.trim();
  const status = query.status?.trim().toLowerCase();
  const startedAfter = query.startedAfter?.trim();
  const startedBefore = query.startedBefore?.trim();
  const correlationId = query.correlationId?.trim();

  return items.filter((item) => {
    if (workflowId && item.workflowId !== workflowId) {
      return false;
    }
    if (workflowVersionId && item.workflowVersionId !== workflowVersionId) {
      return false;
    }
    if (status && item.status.toLowerCase() !== status) {
      return false;
    }
    if (startedAfter) {
      const stamp = item.startedAt || item.createdAt;
      if (stamp && stamp < startedAfter) {
        return false;
      }
    }
    if (startedBefore) {
      const stamp = item.startedAt || item.createdAt;
      if (stamp && stamp > startedBefore) {
        return false;
      }
    }
    if (correlationId && item.correlationId !== correlationId) {
      return false;
    }
    return true;
  });
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
    reused: record.reused,
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
    reusedMessage: idempotencyReplayMessage(detail.reused),
    steps: detail.steps,
    jobs: detail.jobs,
    events: detail.events,
    inputRedacted: detail.inputRedacted,
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
        row.reused ? IDEMPOTENCY_REPLAY_MESSAGE : "",
      ].join(" "),
    )
    .join("\n");
}

export function executionDetailText(detail: ExecutionDetail): string {
  const view = executionDetailDisplay(detail);
  const parts = [
    executionListText([detail]),
    view.reusedMessage,
    JSON.stringify(view.inputRedacted ?? null),
    ...view.steps.map((step) =>
      [
        step.id,
        step.nodeId,
        step.nodeType,
        step.nodeName,
        step.status,
        JSON.stringify(step.outputRedacted ?? null),
        JSON.stringify(step.errorRedacted ?? null),
      ].join(" "),
    ),
    ...view.jobs.map((job) =>
      [job.id, job.status, job.workerId, job.executionStepId].join(" "),
    ),
    ...view.events.map((event) =>
      [
        event.id,
        event.action,
        event.outcome,
        JSON.stringify(event.detailsRedacted ?? null),
      ].join(" "),
    ),
  ];
  return parts.join("\n");
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
    return "—";
  }
}

export function documentedExecutionStatuses(): readonly string[] {
  return EXECUTION_STATUSES;
}
