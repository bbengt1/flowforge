/**
 * Typed E10.4 HTTP / notification catalog client. Paths come from
 * core-http-notification-contract.ts so a retarget only edits that
 * adapter. Prefer GET /ops-config/catalog (httpEngine /
 * notificationEngine when Jonny lands them) then fall back to the
 * marked e104-draft map. Cookie session. Specs are secret-stripped.
 * POST select stays on the existing ops-config client (CSRF).
 */

import { callIdentityProxy } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { getOpsConfigCatalog, listOpsConfig, selectOpsConfig } from "./ops-config-client.ts";
import type { OpsConfigKind, OpsConfigPin } from "./ops-config-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  HTTP_CONTRACT_FALLBACK_HELP,
  HTTP_EXISTING_API_PATHS,
  deliveryHasForbiddenSecret,
  parseHttpNotificationCatalog,
  redactHttpNotificationDelivery,
  type HttpNotificationCatalog,
} from "./core-http-notification-contract.ts";

export type HttpNotificationClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export type HttpNotificationCatalogSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  catalog: HttpNotificationCatalog;
};

export type HttpNotificationPinListSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  items: OpsConfigPin[];
};

export type HttpNotificationSelectSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  pin: OpsConfigPin;
};

function failure(result: {
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
}): HttpNotificationClientFailure {
  return {
    ok: false,
    statusCode: result.statusCode,
    requestId: result.requestId,
    problem: result.problem,
  };
}

export async function getHttpNotificationCatalog(
  identity: DevIdentity,
): Promise<HttpNotificationCatalogSuccess | HttpNotificationClientFailure> {
  const ops = await getOpsConfigCatalog(identity);
  if (ops.ok) {
    const catalog = parseHttpNotificationCatalog({
      ...ops.catalog,
      httpEngine: ops.catalog.httpEngine,
      notificationEngine: ops.catalog.notificationEngine,
    });
    if (catalog.source !== "contract-fallback") {
      return {
        ok: true,
        statusCode: ops.statusCode,
        requestId: ops.requestId,
        catalog,
      };
    }
  }
  const workflow = await callIdentityProxy<unknown>(
    HTTP_EXISTING_API_PATHS.workflowCatalog,
    identity,
  );
  if (workflow.ok) {
    const catalog = parseHttpNotificationCatalog(workflow.data);
    if (catalog.source !== "contract-fallback") {
      return {
        ok: true,
        statusCode: workflow.statusCode,
        requestId: workflow.requestId,
        catalog,
      };
    }
    return {
      ok: true,
      statusCode: workflow.statusCode,
      requestId: workflow.requestId,
      catalog: {
        ...catalog,
        notes: catalog.notes || HTTP_CONTRACT_FALLBACK_HELP,
      },
    };
  }
  if (ops.ok) {
    return {
      ok: true,
      statusCode: ops.statusCode,
      requestId: ops.requestId,
      catalog: parseHttpNotificationCatalog(ops.catalog),
    };
  }
  return failure(ops);
}

export async function listHttpNotificationPins(
  identity: DevIdentity,
  kind: Extract<
    OpsConfigKind,
    "connection" | "recipient_list" | "message_template" | "response_schema"
  >,
): Promise<HttpNotificationPinListSuccess | HttpNotificationClientFailure> {
  const result = await listOpsConfig(identity, kind);
  if (!result.ok) {
    return failure(result);
  }
  const items = result.items
    .filter((item) => item.status !== "disabled")
    .map((item) => ({
      kind,
      resourceId: item.id,
      versionId: item.latestVersionId ?? "",
      versionNumber: item.latestVersionNumber ?? 0,
      digest: item.latestVersionDigest ?? "",
      name: item.name,
      slug: item.slug,
      spec: item.spec,
    }))
    .filter((pin) => pin.resourceId && pin.versionId);
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    items,
  };
}

export async function selectHttpNotificationPin(
  identity: DevIdentity,
  kind: Extract<
    OpsConfigKind,
    "connection" | "recipient_list" | "message_template" | "response_schema"
  >,
  resourceId: string,
  versionId?: string,
): Promise<HttpNotificationSelectSuccess | HttpNotificationClientFailure> {
  const result = await selectOpsConfig(identity, kind, resourceId, versionId);
  if (!result.ok) {
    return failure(result);
  }
  return {
    ok: true,
    statusCode: result.statusCode,
    requestId: result.requestId,
    pin: result.pin,
  };
}

/** Display-safe delivery payload. Unexpected secrets are stripped. */
export function presentHttpNotificationResult(value: unknown): unknown {
  const redacted = redactHttpNotificationDelivery(value);
  if (deliveryHasForbiddenSecret(redacted)) {
    return redactHttpNotificationDelivery(redacted);
  }
  return redacted;
}
