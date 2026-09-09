/**
 * Thin typed E5.4 alert/audit client. Paths come only from
 * alert-contract.ts. Session: credentials:include. CSRF on
 * POST ack/resolve. Host-supplied workspace IDs are never sent.
 * Unexpected secrets are stripped. Never log request bodies.
 *
 * Workspace audit is GET /audit-events — not E2.2
 * GET /workspace/audit-events.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  ALERT_ACK_APPLIED_MESSAGE,
  ALERT_RESOLVE_APPLIED_MESSAGE,
  alertAckPath,
  alertPath,
  alertResolvePath,
  alertsCatalogPath,
  buildAlertAckBody,
  buildAlertResolveBody,
  listAlertsPath,
  listWorkspaceAuditEventsPath,
  workspaceAuditEventPath,
} from "./alert-contract.ts";
import {
  isAlertForbidden,
  parseAlertCatalog,
  parseAlertList,
  parseOperationalAlert,
  parseWorkspaceAuditEvent,
  parseWorkspaceAuditList,
  stripSecretFields,
} from "./alert.ts";
import type {
  AlertCatalog,
  AlertListQuery,
  OperationalAlert,
  WorkspaceAuditEvent,
  WorkspaceAuditQuery,
} from "./alert-types.ts";

export type AlertClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
  forbidden: boolean;
  strippedKeys: string[];
};

export type AlertListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OperationalAlert[];
  strippedKeys: string[];
};

export type AlertDetailSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  alert: OperationalAlert;
  strippedKeys: string[];
};

export type AlertCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: AlertCatalog;
  strippedKeys: string[];
};

export type AlertMutationSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  alert: OperationalAlert | null;
  message: string;
  strippedKeys: string[];
};

export type AuditListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: WorkspaceAuditEvent[];
  strippedKeys: string[];
};

export type AuditDetailSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  event: WorkspaceAuditEvent;
  strippedKeys: string[];
};

export async function listAlerts(
  identity: DevIdentity,
  filter: AlertListQuery = {},
): Promise<AlertListSuccess | AlertClientFailure> {
  const result = await callIdentityProxy<unknown>(listAlertsPath(filter), identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseAlertList(result.data),
    strippedKeys,
  };
}

export async function getAlertCatalog(
  identity: DevIdentity,
): Promise<AlertCatalogSuccess | AlertClientFailure> {
  const result = await callIdentityProxy<unknown>(alertsCatalogPath(), identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    catalog: parseAlertCatalog(result.data),
    strippedKeys,
  };
}

export async function getAlert(
  identity: DevIdentity,
  alertId: string,
): Promise<AlertDetailSuccess | AlertClientFailure> {
  const path = alertPath(alertId);
  const result = await callIdentityProxy<unknown>(path, identity);
  return detailResult(result, path, alertId);
}

/**
 * POST /alerts/{id}/ack with CSRF. Empty body — never send
 * host-supplied id / workspaceId. 403 is fail-closed.
 */
export async function ackAlert(
  identity: DevIdentity,
  alertId: string,
): Promise<AlertMutationSuccess | AlertClientFailure> {
  const path = alertAckPath(alertId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildAlertAckBody(),
  });
  return mutationResult(result, path, alertId, ALERT_ACK_APPLIED_MESSAGE);
}

/**
 * POST /alerts/{id}/resolve with CSRF. Empty body — never send
 * host-supplied id / workspaceId. 403 is fail-closed.
 */
export async function resolveAlert(
  identity: DevIdentity,
  alertId: string,
): Promise<AlertMutationSuccess | AlertClientFailure> {
  const path = alertResolvePath(alertId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildAlertResolveBody(),
  });
  return mutationResult(result, path, alertId, ALERT_RESOLVE_APPLIED_MESSAGE);
}

export async function listWorkspaceAuditEvents(
  identity: DevIdentity,
  filter: WorkspaceAuditQuery = {},
): Promise<AuditListSuccess | AlertClientFailure> {
  const result = await callIdentityProxy<unknown>(
    listWorkspaceAuditEventsPath(filter),
    identity,
  );
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseWorkspaceAuditList(result.data),
    strippedKeys,
  };
}

export async function getWorkspaceAuditEvent(
  identity: DevIdentity,
  auditEventId: string,
): Promise<AuditDetailSuccess | AlertClientFailure> {
  const path = workspaceAuditEventPath(auditEventId);
  const result = await callIdentityProxy<unknown>(path, identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const event = parseWorkspaceAuditEvent(result.data);
  if (!event) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Audit event payload was missing id or action.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    event,
    strippedKeys,
  };
}

function detailResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  alertId: string,
): AlertDetailSuccess | AlertClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  const alert = parseOperationalAlert(result.data);
  if (!alert) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Alert payload was missing id.",
    );
  }
  if (alert.id !== alertId && alertId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Alert payload id did not match the requested alert.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    alert,
    strippedKeys,
  };
}

function mutationResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  alertId: string,
  message: string,
): AlertMutationSuccess | AlertClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripSecretFields(result.data, strippedKeys);
  if (result.statusCode === 204 || result.data == null) {
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      alert: null,
      message,
      strippedKeys,
    };
  }
  const parsed = parseOperationalAlert(result.data);
  if (parsed && alertId && parsed.id !== alertId) {
    return malformed(
      result.requestId,
      result.statusCode,
      instance,
      "Alert mutation payload id did not match the requested alert.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    alert: parsed,
    message,
    strippedKeys,
  };
}

function failure(
  result: Extract<IdentityClientResult<unknown>, { ok: false }>,
): AlertClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
    forbidden: isAlertForbidden(result.problem),
    strippedKeys: [],
  };
}

function malformed(
  requestId: string,
  statusCode: number,
  instance: string,
  detail: string,
): AlertClientFailure {
  return {
    ok: false,
    statusCode,
    requestId,
    forbidden: false,
    strippedKeys: [],
    problem: {
      type: "urn:flowforge:problem:upstream-error",
      title: "Upstream Error",
      status: statusCode,
      detail,
      instance,
      code: "upstream-error",
      request_id: requestId,
    },
  };
}
