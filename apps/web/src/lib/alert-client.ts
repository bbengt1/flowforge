/**
 * Thin typed E5.4 client. Paths come only from alert-contract.ts (#58).
 *
 * Session: credentials:include. CSRF on POST ack. Host-supplied
 * workspace IDs are never sent. Unexpected secrets are stripped.
 * Never log request bodies.
 *
 * Workspace audit is GET /audit-events — not E2.2
 * GET /workspace/audit-events.
 */

import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { type ProblemDetails } from "./problem.ts";
import {
  alertAckPath,
  alertPath,
  buildAlertAckBody,
  listAlertsPath,
  listWorkspaceAuditEventsPath,
} from "./alert-contract.ts";
import {
  ackOutcomeMessage,
  isAlertForbidden,
  parseAlertList,
  parseOperationalAlert,
  parseWorkspaceAuditList,
  stripAlertForbiddenFields,
  stripSecretFields,
} from "./alert.ts";
import type {
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

export type AlertAckSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  alert: OperationalAlert | null;
  idempotent: boolean;
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

export async function listAlerts(
  identity: DevIdentity,
  filter: AlertListQuery = {},
): Promise<AlertListSuccess | AlertClientFailure> {
  const result = await callIdentityProxy<unknown>(listAlertsPath(filter), identity);
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripAlertForbiddenFields(result.data, strippedKeys);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items: parseAlertList(result.data),
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
 * host-supplied id / workspaceId. A second ack is success
 * (idempotent). 403 is fail-closed.
 */
export async function ackAlert(
  identity: DevIdentity,
  alertId: string,
  previousStatus?: string,
): Promise<AlertAckSuccess | AlertClientFailure> {
  const path = alertAckPath(alertId);
  const result = await callIdentityProxy<unknown>(path, identity, {
    method: "POST",
    body: buildAlertAckBody(),
  });
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripAlertForbiddenFields(result.data, strippedKeys);
  if (result.statusCode === 204 || result.data == null) {
    return {
      ok: true,
      statusCode: result.statusCode,
      requestId: result.requestId,
      alert: null,
      idempotent: previousStatus === "acked",
      message: ackOutcomeMessage({
        previousStatus,
        status: "acked",
      }),
      strippedKeys,
    };
  }
  const parsed = parseOperationalAlert(result.data);
  if (parsed && alertId && parsed.id !== alertId) {
    return malformed(
      result.requestId,
      result.statusCode,
      path,
      "Alert ack payload id did not match the requested alert.",
    );
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    alert: parsed,
    idempotent: ackOutcomeMessage({
      previousStatus,
      status: parsed?.status ?? "acked",
    }).includes("idempotent"),
    message: ackOutcomeMessage({
      previousStatus,
      status: parsed?.status ?? "acked",
    }),
    strippedKeys,
  };
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

function detailResult(
  result: IdentityClientResult<unknown>,
  instance: string,
  alertId: string,
): AlertDetailSuccess | AlertClientFailure {
  if (!result.ok) {
    return failure(result);
  }
  const strippedKeys: string[] = [];
  stripAlertForbiddenFields(result.data, strippedKeys);
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
