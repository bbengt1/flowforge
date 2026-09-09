/**
 * E5.4 alert/audit presentation. Alerts show IDs and a safe message —
 * never secrets. Unexpected secret field names are a contract bug:
 * strip, never display. Workspace audit is append-only; the UI never
 * offers edit/delete.
 */

import {
  ALERT_ACK_APPLIED_MESSAGE,
  ALERT_ACK_ROUTE_PUBLISHED,
  ALERT_MUTATION_UNAVAILABLE_MESSAGE,
  ALERT_RESOLVE_APPLIED_MESSAGE,
  ALERT_RESOLVE_ROUTE_PUBLISHED,
  AUDIT_APPEND_ONLY_HELP,
  alertHistoryHref,
} from "./alert-contract.ts";
import {
  ALERT_KINDS,
  ALERT_MANAGE_FALLBACK_PERMISSION,
  ALERT_MANAGE_PERMISSION,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_VIEW_FALLBACK_PERMISSION,
  ALERT_VIEW_PERMISSION,
  AUDIT_VIEW_PERMISSION,
  REDACTED_MARKER,
  WORKSPACE_ADMINISTER_PERMISSION,
  type AlertCatalog,
  type AlertKind,
  type AlertListQuery,
  type AlertListRow,
  type AlertResourceIds,
  type AlertSeverity,
  type AlertSeverityPresentation,
  type AlertStatus,
  type AuditRowAffordances,
  type OperationalAlert,
  type WorkspaceAuditEvent,
} from "./alert-types.ts";
import {
  containsUnredactedSecret,
  isSecretFieldName,
  redactedJson,
  stripSecretFields,
} from "./execution.ts";
import type { ProblemDetails } from "./problem.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOURCE_ID_KEYS = new Set([
  "executionid",
  "execution_id",
  "workflowid",
  "workflow_id",
  "workflowversionid",
  "workflow_version_id",
  "stepid",
  "step_id",
  "executionstepid",
  "execution_step_id",
  "jobid",
  "job_id",
  "artifactid",
  "artifact_id",
  "approvalid",
  "approval_id",
  "policyid",
  "policy_id",
  "credentialid",
  "credential_id",
  "resourceid",
  "resource_id",
  "targetid",
  "target_id",
  "nodeid",
  "node_id",
]);

export const AUDIT_ROW_AFFORDANCES: AuditRowAffordances = {
  canEdit: false,
  canDelete: false,
  canMutate: false,
};

export function isUuid(value: string | undefined): boolean {
  return Boolean(value && UUID.test(value));
}

function readString(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readStringList(...candidates: unknown[]): string[] {
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasPermission(
  permissions: readonly string[] | null | undefined,
  key: string,
): boolean {
  if (permissions == null) {
    return true;
  }
  return permissions.includes(key);
}

function hasAnyPermission(
  permissions: readonly string[] | null | undefined,
  keys: readonly string[],
): boolean {
  if (permissions == null) {
    return true;
  }
  return keys.some((key) => permissions.includes(key));
}

/** Browse when alert.view / audit.view exists, else execution.view. */
export function canSeeAlertsNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return true;
  }
  if (
    hasAnyPermission(permissions, [
      ALERT_VIEW_PERMISSION,
      ALERT_MANAGE_PERMISSION,
    ])
  ) {
    return true;
  }
  return hasPermission(permissions, ALERT_VIEW_FALLBACK_PERMISSION);
}

export function canSeeAuditNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return true;
  }
  if (hasPermission(permissions, AUDIT_VIEW_PERMISSION)) {
    return true;
  }
  return canSeeAlertsNav(permissions);
}

export function canManageAlerts(
  permissions: readonly string[] | null | undefined,
): boolean {
  return hasAnyPermission(permissions, [
    ALERT_MANAGE_PERMISSION,
    WORKSPACE_ADMINISTER_PERMISSION,
    ALERT_MANAGE_FALLBACK_PERMISSION,
  ]);
}

export function isAlertForbidden(
  problem: ProblemDetails | null | undefined,
): boolean {
  return problem?.status === 403 || problem?.code === "forbidden";
}

export function isAlertNotFound(
  problem: ProblemDetails | null | undefined,
): boolean {
  return problem?.status === 404 || problem?.code === "not-found";
}

export function normalizeAlertKind(kind: AlertKind | undefined): string {
  return kind?.trim().toLowerCase() || "unknown";
}

export function normalizeAlertSeverity(
  severity: AlertSeverity | undefined,
): string {
  return severity?.trim().toLowerCase() || "info";
}

export function normalizeAlertStatus(status: AlertStatus | undefined): string {
  const folded = status?.trim().toLowerCase() || "open";
  if (folded === "acked" || folded === "ack") {
    return "acknowledged";
  }
  if (folded === "closed") {
    return "resolved";
  }
  return folded;
}

export function alertKindLabel(kind: AlertKind | undefined): string {
  const folded = normalizeAlertKind(kind);
  const labels: Record<string, string> = {
    authorization: "Authorization",
    replay: "Replay",
    policy: "Policy",
    redaction: "Redaction",
  };
  return labels[folded] ?? folded;
}

export function alertStatusLabel(status: AlertStatus | undefined): string {
  const folded = normalizeAlertStatus(status);
  const labels: Record<string, string> = {
    open: "Open",
    acknowledged: "Acknowledged",
    resolved: "Resolved",
  };
  return labels[folded] ?? folded;
}

export function alertSeverityPresentation(
  severity: AlertSeverity | undefined,
): AlertSeverityPresentation {
  const folded = normalizeAlertSeverity(severity);
  const catalog: Record<
    string,
    Omit<AlertSeverityPresentation, "severity">
  > = {
    critical: {
      label: "Critical",
      icon: "⬤",
      description: "Fail-closed authorization, replay, policy, or redaction failure that blocked work.",
      tone: "critical",
    },
    high: {
      label: "High",
      icon: "◉",
      description: "Actionable operational failure. Inspect correlation and resource ids.",
      tone: "high",
    },
    medium: {
      label: "Medium",
      icon: "◎",
      description: "Operator-visible signal that did not necessarily stop the run.",
      tone: "medium",
    },
    low: {
      label: "Low",
      icon: "○",
      description: "Informational operational signal.",
      tone: "low",
    },
    info: {
      label: "Info",
      icon: "·",
      description: "Safe diagnostic notice.",
      tone: "info",
    },
  };
  const known = catalog[folded];
  if (known) {
    return { severity: folded, ...known };
  }
  return {
    severity: folded,
    label: folded,
    icon: "•",
    description: "Severity reported by the API.",
    tone: "other",
  };
}

export function safeAlertMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (containsUnredactedSecret(trimmed)) {
    return REDACTED_MARKER;
  }
  return trimmed;
}

function emptyResourceIds(): AlertResourceIds {
  return {
    executionId: "",
    workflowId: "",
    workflowVersionId: "",
    stepId: "",
    jobId: "",
    artifactId: "",
    approvalId: "",
    policyId: "",
    credentialId: "",
    extra: {},
  };
}

export function parseAlertResourceIds(raw: unknown): AlertResourceIds {
  const ids = emptyResourceIds();
  const row = asRecord(raw);
  if (!row) {
    return ids;
  }
  ids.executionId = readString(row.executionId, row.execution_id);
  ids.workflowId = readString(row.workflowId, row.workflow_id);
  ids.workflowVersionId = readString(
    row.workflowVersionId,
    row.workflow_version_id,
  );
  ids.stepId = readString(row.stepId, row.step_id, row.executionStepId);
  ids.jobId = readString(row.jobId, row.job_id);
  ids.artifactId = readString(row.artifactId, row.artifact_id);
  ids.approvalId = readString(row.approvalId, row.approval_id);
  ids.policyId = readString(row.policyId, row.policy_id);
  ids.credentialId = readString(row.credentialId, row.credential_id);
  for (const [key, value] of Object.entries(row)) {
    const folded = key.trim().toLowerCase().replace(/-/g, "_");
    if (isSecretFieldName(key)) {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    if (
      RESOURCE_ID_KEYS.has(folded) ||
      RESOURCE_ID_KEYS.has(folded.replace(/_/g, ""))
    ) {
      if (!ids.extra[key] && !(key in ids)) {
        ids.extra[key] = value.trim();
      }
    }
  }
  return ids;
}

function resourceIdsFromRow(row: Record<string, unknown>): AlertResourceIds {
  const nested = parseAlertResourceIds(
    row.resourceIds ?? row.resource_ids ?? row.resources,
  );
  const top = parseAlertResourceIds(row);
  return {
    executionId: nested.executionId || top.executionId,
    workflowId: nested.workflowId || top.workflowId,
    workflowVersionId: nested.workflowVersionId || top.workflowVersionId,
    stepId: nested.stepId || top.stepId,
    jobId: nested.jobId || top.jobId,
    artifactId: nested.artifactId || top.artifactId,
    approvalId: nested.approvalId || top.approvalId,
    policyId: nested.policyId || top.policyId,
    credentialId: nested.credentialId || top.credentialId,
    extra: nested.extra,
  };
}

export function listedResourceIds(ids: AlertResourceIds): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ["executionId", ids.executionId],
    ["workflowId", ids.workflowId],
    ["workflowVersionId", ids.workflowVersionId],
    ["stepId", ids.stepId],
    ["jobId", ids.jobId],
    ["artifactId", ids.artifactId],
    ["approvalId", ids.approvalId],
    ["policyId", ids.policyId],
    ["credentialId", ids.credentialId],
    ...Object.entries(ids.extra),
  ];
  return pairs.filter(([, value]) => Boolean(value));
}

export function parseOperationalAlert(raw: unknown): OperationalAlert | null {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const row = asRecord(cleaned);
  if (!row) {
    return null;
  }
  const nested = asRecord(row.alert) ?? row;
  const id = readString(nested.id);
  if (!id) {
    return null;
  }
  const kind = readString(nested.kind, nested.type, nested.eventType);
  return {
    id,
    kind: kind || "unknown",
    severity: readString(nested.severity) || "info",
    status: normalizeAlertStatus(readString(nested.status)),
    message: safeAlertMessage(
      readString(nested.message, nested.title, nested.detail, nested.summary),
    ),
    correlationId: readString(nested.correlationId, nested.correlation_id),
    resourceType: readString(nested.resourceType, nested.resource_type),
    resourceId: readString(nested.resourceId, nested.resource_id),
    resourceIds: resourceIdsFromRow(nested),
    occurredAt: readString(
      nested.occurredAt,
      nested.occurred_at,
      nested.createdAt,
      nested.created_at,
    ),
    createdAt: readString(nested.createdAt, nested.created_at),
    updatedAt: readString(nested.updatedAt, nested.updated_at),
    acknowledgedAt: readString(
      nested.acknowledgedAt,
      nested.acknowledged_at,
    ),
    resolvedAt: readString(nested.resolvedAt, nested.resolved_at),
    permittedActions: readStringList(
      nested.permittedActions,
      nested.permitted_actions,
    ),
  };
}

export function parseAlertList(raw: unknown): OperationalAlert[] {
  return parseItemList(raw, parseOperationalAlert);
}

export function parseAlertCatalog(raw: unknown): AlertCatalog {
  const stripped: string[] = [];
  const cleaned = stripSecretFields(raw, stripped);
  const row = asRecord(cleaned) ?? {};
  const kinds = readStringList(row.kinds, row.types);
  const severities = readStringList(row.severities);
  const statuses = readStringList(row.statuses);
  return {
    kinds: kinds.length ? kinds : [...ALERT_KINDS],
    severities: severities.length ? severities : [...ALERT_SEVERITIES],
    statuses: statuses.length ? statuses : [...ALERT_STATUSES],
  };
}

export function parseWorkspaceAuditEvent(raw: unknown): WorkspaceAuditEvent | null {
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
  };
}

export function parseWorkspaceAuditList(raw: unknown): WorkspaceAuditEvent[] {
  return parseItemList(raw, parseWorkspaceAuditEvent);
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

export function filterAlertList(
  items: OperationalAlert[],
  query: AlertListQuery & { q?: string },
): OperationalAlert[] {
  const kind = query.kind?.trim().toLowerCase();
  const severity = query.severity?.trim().toLowerCase();
  const status = query.status?.trim().toLowerCase();
  const q = query.q?.trim().toLowerCase();
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.max(0, Math.min(100, Math.trunc(query.limit)))
      : undefined;

  const filtered = items.filter((item) => {
    if (kind && normalizeAlertKind(item.kind) !== kind) {
      return false;
    }
    if (severity && normalizeAlertSeverity(item.severity) !== severity) {
      return false;
    }
    if (status && normalizeAlertStatus(item.status) !== status) {
      return false;
    }
    if (q) {
      const haystack = [
        item.id,
        item.kind,
        item.message,
        item.correlationId,
        item.resourceId,
        item.resourceType,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }
    return true;
  });
  return limit == null ? filtered : filtered.slice(0, limit);
}

function permittedIncludes(
  permitted: readonly string[] | null | undefined,
  action: string,
): boolean {
  if (permitted == null || permitted.length === 0) {
    return true;
  }
  const folded = permitted.map((item) => item.trim().toLowerCase());
  return folded.includes(action) || folded.includes(`${action}d`);
}

export function canAckAlert(options: {
  permissions?: readonly string[] | null;
  status?: AlertStatus;
  permittedActions?: readonly string[] | null;
}): boolean {
  if (!ALERT_ACK_ROUTE_PUBLISHED) {
    return false;
  }
  if (!canManageAlerts(options.permissions)) {
    return false;
  }
  const status = normalizeAlertStatus(options.status);
  if (status !== "open") {
    return false;
  }
  return permittedIncludes(options.permittedActions, "ack");
}

export function canResolveAlert(options: {
  permissions?: readonly string[] | null;
  status?: AlertStatus;
  permittedActions?: readonly string[] | null;
}): boolean {
  if (!ALERT_RESOLVE_ROUTE_PUBLISHED) {
    return false;
  }
  if (!canManageAlerts(options.permissions)) {
    return false;
  }
  const status = normalizeAlertStatus(options.status);
  if (status === "resolved") {
    return false;
  }
  return permittedIncludes(options.permittedActions, "resolve");
}

export function alertMutationUnavailableMessage(): string {
  if (!ALERT_ACK_ROUTE_PUBLISHED && !ALERT_RESOLVE_ROUTE_PUBLISHED) {
    return ALERT_MUTATION_UNAVAILABLE_MESSAGE;
  }
  return "";
}

export function ackOutcomeMessage(): string {
  return ALERT_ACK_APPLIED_MESSAGE;
}

export function resolveOutcomeMessage(): string {
  return ALERT_RESOLVE_APPLIED_MESSAGE;
}

export function auditRowAffordances(): AuditRowAffordances {
  return AUDIT_ROW_AFFORDANCES;
}

export function hasAuditMutationAffordance(text: string): boolean {
  const folded = text.toLowerCase();
  return (
    /\bedit audit\b/.test(folded) ||
    /\bdelete audit\b/.test(folded) ||
    /\bremove audit\b/.test(folded) ||
    /\bupdate audit\b/.test(folded) ||
    folded.includes("edit this event") ||
    folded.includes("delete this event") ||
    folded.includes("tamper")
  );
}

export function alertListRow(record: OperationalAlert): AlertListRow {
  return {
    id: record.id,
    href: alertHistoryHref(record.id),
    kind: record.kind,
    severity: record.severity,
    status: record.status,
    message: record.message || "—",
    correlationId: record.correlationId || "—",
    resourceId: record.resourceId || "—",
    resourceType: record.resourceType || "—",
    occurredAt: record.occurredAt || record.createdAt || "—",
  };
}

export function alertListDisplay(items: OperationalAlert[]): AlertListRow[] {
  return items.map(alertListRow);
}

export function alertListText(items: OperationalAlert[]): string {
  return alertListDisplay(items)
    .map((row) =>
      [
        row.id,
        alertKindLabel(row.kind),
        alertSeverityPresentation(row.severity).icon,
        alertSeverityPresentation(row.severity).label,
        alertStatusLabel(row.status),
        row.message,
        row.correlationId,
        row.resourceType,
        row.resourceId,
        row.occurredAt,
      ].join(" "),
    )
    .join("\n");
}

export function alertDetailText(alert: OperationalAlert): string {
  const ids = listedResourceIds(alert.resourceIds)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return [
    alertListText([alert]),
    alert.correlationId,
    alert.resourceId,
    ids,
    alert.acknowledgedAt,
    alert.resolvedAt,
  ].join("\n");
}

export function auditBrowserText(items: WorkspaceAuditEvent[]): string {
  return items
    .map((event) =>
      [
        event.id,
        event.action,
        event.outcome,
        event.resourceType,
        event.resourceId,
        event.correlationId,
        event.occurredAt,
        event.actorId,
        redactedJson(event.details),
        AUDIT_APPEND_ONLY_HELP,
      ].join(" "),
    )
    .join("\n");
}

export function alertContainsSecret(text: string): boolean {
  return containsUnredactedSecret(text);
}

export { containsUnredactedSecret, stripSecretFields };
