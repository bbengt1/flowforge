/**
 * Shapes for Chloe's E5.4 alert/audit operator. Jonny's route map is
 * still in flight — keep field names camelCase and retarget in
 * alert-contract.ts. Do not invent secrets. Host-supplied id /
 * workspaceId are never sent on writes.
 */

export const ALERT_KINDS = [
  "authorization",
  "replay",
  "policy",
  "redaction",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number] | string;

export const ALERT_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number] | string;

export const ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number] | string;

/** Until jonny publishes alert.view, browse with execution.view. */
export const ALERT_VIEW_PERMISSION = "alert.view";
export const ALERT_MANAGE_PERMISSION = "alert.manage";
export const AUDIT_VIEW_PERMISSION = "audit.view";
export const ALERT_VIEW_FALLBACK_PERMISSION = "execution.view";
export const ALERT_MANAGE_FALLBACK_PERMISSION = "execution.cancel";
export const WORKSPACE_ADMINISTER_PERMISSION = "workspace.administer";

export const REDACTED_MARKER = "[redacted]";

export type AlertListQuery = {
  kind?: string;
  severity?: string;
  status?: string;
  limit?: number;
};

export type WorkspaceAuditQuery = {
  resourceType?: string;
  resourceId?: string;
  action?: string;
  kind?: string;
  limit?: number;
};

export type AlertResourceIds = {
  executionId: string;
  workflowId: string;
  workflowVersionId: string;
  stepId: string;
  jobId: string;
  artifactId: string;
  approvalId: string;
  policyId: string;
  credentialId: string;
  extra: Record<string, string>;
};

export type OperationalAlert = {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  correlationId: string;
  resourceType: string;
  resourceId: string;
  resourceIds: AlertResourceIds;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string;
  resolvedAt: string;
  permittedActions: string[];
};

export type AlertCatalog = {
  kinds: string[];
  severities: string[];
  statuses: string[];
};

export type AlertListRow = {
  id: string;
  href: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  correlationId: string;
  resourceId: string;
  resourceType: string;
  occurredAt: string;
};

export type AlertSeverityPresentation = {
  severity: string;
  label: string;
  icon: string;
  description: string;
  tone: "critical" | "high" | "medium" | "low" | "info" | "other";
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
