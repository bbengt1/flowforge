/**
 * Shapes from jonny's E5.4 OpenAPI (#58 on `main`). Identifiers
 * only — no `details`, tokens, headers, or secret leaves.
 */

export const ALERT_KINDS = [
  "authorization",
  "replay",
  "policy",
  "redaction",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number] | string;

export const ALERT_SEVERITIES = ["warning", "critical"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number] | string;

export const ALERT_STATUSES = ["open", "acked"] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number] | string;

export const ALERT_VIEW_PERMISSION = "alert.view";
export const ALERT_ACK_PERMISSION = "alert.ack";

export const REDACTED_MARKER = "[redacted]";

/** Documented list query for GET /alerts. */
export type AlertListQuery = {
  kind?: string;
  status?: string;
  resourceType?: string;
  resourceId?: string;
  limit?: number;
};

export type WorkspaceAuditQuery = {
  resourceType?: string;
  resourceId?: string;
  action?: string;
  limit?: number;
};

export type OperationalAlert = {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId: string;
  requestId: string;
  actorId: string;
  outcome: string;
  code: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
  occurredAt: string;
};

export type AlertListRow = {
  id: string;
  href: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  action: string;
  outcome: string;
  code: string;
  correlationId: string;
  requestId: string;
  resourceId: string;
  resourceType: string;
  occurredAt: string;
};

export type AlertSeverityPresentation = {
  severity: string;
  label: string;
  icon: string;
  description: string;
  tone: "critical" | "warning" | "other";
};

export type WorkspaceAuditEvent = {
  id: string;
  action: string;
  outcome: string;
  resourceType: string;
  resourceId: string;
  correlationId: string;
  occurredAt: string;
  actorId: string;
  details: unknown;
};

/** Append-only: the UI never exposes edit/delete on audit rows. */
export type AuditRowAffordances = {
  canEdit: false;
  canDelete: false;
  canMutate: false;
};
