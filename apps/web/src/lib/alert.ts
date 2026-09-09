/**
 * E5.4 alert/audit presentation against the #58 map. Alerts show
 * identifiers only — never secrets. Unexpected secret field names
 * (including `details`) are a contract bug: strip, never display.
 * Workspace audit is append-only; the UI never offers edit/delete.
 */

import {
  ALERT_ACK_APPLIED_MESSAGE,
  ALERT_ACK_IDEMPOTENT_MESSAGE,
  ALERT_ACK_ROUTE_PUBLISHED,
  alertHistoryHref,
  executionCorrelateHref,
} from "./alert-contract.ts";
import {
  ALERT_ACK_PERMISSION,
  ALERT_KINDS,
  ALERT_VIEW_PERMISSION,
  REDACTED_MARKER,
  type AlertKind,
  type AlertListQuery,
  type AlertListRow,
  type AlertSeverity,
  type AlertSeverityPresentation,
  type AlertStatus,
  type AuditRowAffordances,
  type OperationalAlert,
  type WorkspaceAuditEvent,
} from "./alert-types.ts";
import {
  containsUnredactedSecret,
  redactedJson,
  stripSecretFields,
} from "./execution.ts";
import type { ProblemDetails } from "./problem.ts";

export const AUDIT_ROW_AFFORDANCES: AuditRowAffordances = {
  canEdit: false,
  canDelete: false,
  canMutate: false,
};

function readString(...candidates: unknown[]): string {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
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

export function canSeeAlertsNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  return hasPermission(permissions, ALERT_VIEW_PERMISSION);
}

export function canSeeAuditNav(
  permissions: readonly string[] | null | undefined,
): boolean {
  if (permissions == null) {
    return true;
  }
  return (
    permissions.includes(ALERT_VIEW_PERMISSION) ||
    permissions.includes("execution.view")
  );
}

export function canAckWithPermission(
  permissions: readonly string[] | null | undefined,
): boolean {
  return hasPermission(permissions, ALERT_ACK_PERMISSION);
}

export function isAlertForbidden(
  problem: ProblemDetails | null | undefined,
): boolean {
  return problem?.status === 403 || problem?.code === "forbidden";
}

export function normalizeAlertKind(kind: AlertKind | undefined): string {
  return kind?.trim().toLowerCase() || "unknown";
}

export function normalizeAlertSeverity(
  severity: AlertSeverity | undefined,
  kind?: AlertKind,
): string {
  const folded = severity?.trim().toLowerCase();
  if (folded === "critical" || folded === "warning") {
    return folded;
  }
  const kindFolded = normalizeAlertKind(kind);
  if (kindFolded === "policy" || kindFolded === "redaction") {
    return "critical";
  }
  if (kindFolded === "authorization" || kindFolded === "replay") {
    return "warning";
  }
  return folded || "warning";
}

export function normalizeAlertStatus(status: AlertStatus | undefined): string {
  const folded = status?.trim().toLowerCase() || "";
  if (folded === "acked" || folded === "acknowledged" || folded === "ack") {
    return "acked";
  }
  if (folded === "open") {
    return "open";
  }
  return folded || "open";
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
  if (folded === "acked") {
    return "Acknowledged";
  }
  if (folded === "open") {
    return "Open";
  }
  return folded;
}

export function alertSeverityPresentation(
  severity: AlertSeverity | undefined,
  kind?: AlertKind,
): AlertSeverityPresentation {
  const folded = normalizeAlertSeverity(severity, kind);
  if (folded === "critical") {
    return {
      severity: "critical",
      label: "Critical",
      icon: "⬤",
      description:
        "Policy deny or redaction/unsafe-artifact failure. Work was blocked.",
      tone: "critical",
    };
  }
  if (folded === "warning") {
    return {
      severity: "warning",
      label: "Warning",
      icon: "◉",
      description:
        "Authorization or replay failure. Inspect correlation and resource ids.",
      tone: "warning",
    };
  }
  return {
    severity: folded,
    label: folded,
    icon: "•",
    description: "Severity reported by the API.",
    tone: "other",
  };
}

export function safeAlertText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (containsUnredactedSecret(trimmed)) {
    return REDACTED_MARKER;
  }
  return trimmed;
}

/** #58 alerts are identifiers only — drop `details` and locator leftovers. */
const ALERT_FORBIDDEN_KEYS = new Set([
  "details",
  "storageref",
  "storage_ref",
  "storageRef",
]);

export function stripAlertForbiddenFields(
  value: unknown,
  strippedKeys: string[] = [],
  path = "",
): unknown {
  const cleaned = stripSecretFields(value, strippedKeys, path);
  return dropAlertForbidden(cleaned, strippedKeys, path);
}

function dropAlertForbidden(
  value: unknown,
  strippedKeys: string[],
  path: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      dropAlertForbidden(
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
    if (ALERT_FORBIDDEN_KEYS.has(key)) {
      strippedKeys.push(childPath);
      continue;
    }
    out[key] = dropAlertForbidden(child, strippedKeys, childPath);
  }
  return out;
}

export function parseOperationalAlert(raw: unknown): OperationalAlert | null {
  const stripped: string[] = [];
  const cleaned = stripAlertForbiddenFields(raw, stripped);
  const row = asRecord(cleaned);
  if (!row) {
    return null;
  }
  const nested = asRecord(row.alert) ?? row;
  const id = readString(nested.id);
  if (!id) {
    return null;
  }
  const kind = readString(nested.kind, nested.type);
  const acknowledgedAt = readString(
    nested.acknowledgedAt,
    nested.acknowledged_at,
  );
  return {
    id,
    kind: kind || "unknown",
    severity: normalizeAlertSeverity(readString(nested.severity), kind),
    status: normalizeAlertStatus(
      readString(nested.status) || (acknowledgedAt ? "acked" : "open"),
    ),
    action: safeAlertText(readString(nested.action)),
    resourceType: readString(nested.resourceType, nested.resource_type),
    resourceId: readString(nested.resourceId, nested.resource_id),
    correlationId: readString(nested.correlationId, nested.correlation_id),
    requestId: readString(nested.requestId, nested.request_id),
    actorId: readString(nested.actorId, nested.actor_id),
    outcome: safeAlertText(readString(nested.outcome)),
    code: safeAlertText(readString(nested.code)),
    acknowledgedAt,
    acknowledgedBy: readString(
      nested.acknowledgedBy,
      nested.acknowledged_by,
    ),
    occurredAt: readString(
      nested.occurredAt,
      nested.occurred_at,
      nested.createdAt,
    ),
  };
}

export function parseAlertList(raw: unknown): OperationalAlert[] {
  return parseItemList(raw, parseOperationalAlert);
}

export function documentedAlertKinds(): readonly string[] {
  return ALERT_KINDS;
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
  const status = query.status?.trim().toLowerCase();
  const resourceType = query.resourceType?.trim().toLowerCase();
  const resourceId = query.resourceId?.trim();
  const q = query.q?.trim().toLowerCase();
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.max(0, Math.min(100, Math.trunc(query.limit)))
      : undefined;

  const filtered = items.filter((item) => {
    if (kind && normalizeAlertKind(item.kind) !== kind) {
      return false;
    }
    if (status && normalizeAlertStatus(item.status) !== status) {
      return false;
    }
    if (resourceType && item.resourceType.toLowerCase() !== resourceType) {
      return false;
    }
    if (resourceId && item.resourceId !== resourceId) {
      return false;
    }
    if (q) {
      const haystack = [
        item.id,
        item.kind,
        item.action,
        item.outcome,
        item.code,
        item.correlationId,
        item.requestId,
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

export function canAckAlert(options: {
  permissions?: readonly string[] | null;
  status?: AlertStatus;
  acknowledgedAt?: string;
}): boolean {
  if (!ALERT_ACK_ROUTE_PUBLISHED) {
    return false;
  }
  if (!canAckWithPermission(options.permissions)) {
    return false;
  }
  if (options.acknowledgedAt?.trim()) {
    return false;
  }
  return normalizeAlertStatus(options.status) === "open";
}

export function isIdempotentAck(record: {
  previousStatus?: string;
  status?: string;
  acknowledgedAt?: string;
}): boolean {
  return (
    normalizeAlertStatus(record.previousStatus) === "acked" &&
    normalizeAlertStatus(record.status) === "acked"
  );
}

export function ackOutcomeMessage(record: {
  previousStatus?: string;
  status?: string;
}): string {
  return isIdempotentAck(record)
    ? ALERT_ACK_IDEMPOTENT_MESSAGE
    : ALERT_ACK_APPLIED_MESSAGE;
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
    action: record.action || "—",
    outcome: record.outcome || "—",
    code: record.code || "—",
    correlationId: record.correlationId || "—",
    requestId: record.requestId || "—",
    resourceId: record.resourceId || "—",
    resourceType: record.resourceType || "—",
    occurredAt: record.occurredAt || "—",
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
        alertSeverityPresentation(row.severity, row.kind).icon,
        alertSeverityPresentation(row.severity, row.kind).label,
        alertStatusLabel(row.status),
        row.action,
        row.outcome,
        row.code,
        row.correlationId,
        row.requestId,
        row.resourceType,
        row.resourceId,
        row.occurredAt,
        executionCorrelateHref(String(row.resourceType), String(row.resourceId)),
      ].join(" "),
    )
    .join("\n");
}

export function alertDetailText(alert: OperationalAlert): string {
  return [
    alertListText([alert]),
    alert.actorId,
    alert.acknowledgedAt,
    alert.acknowledgedBy,
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
        AUDIT_ROW_AFFORDANCES.canMutate ? "mutable" : "append-only",
      ].join(" "),
    )
    .join("\n");
}

export function alertContainsSecret(text: string): boolean {
  return containsUnredactedSecret(text);
}

export { containsUnredactedSecret, stripSecretFields };
