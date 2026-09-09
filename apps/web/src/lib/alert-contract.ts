/**
 * Single adapter for Chloe's E5.4 alert/audit UX (#49), retargeted
 * to Jonny's #58 map on `main`.
 *
 *   GET  /alerts                    ?kind&status&resourceType&resourceId&limit
 *   GET  /alerts/{id}
 *   POST /alerts/{id}/ack           {}  CSRF  idempotent
 *
 * Workspace audit correlate is GET /audit-events — not E2.2
 * GET /workspace/audit-events. Append-only: this adapter never
 * allowlists POST/PUT/PATCH/DELETE on audit-events.
 *
 * Relates to #49 / Part of #45. Cites #58. Do not change `apps/api`.
 * Do not close #49 alone.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type { AlertListQuery, WorkspaceAuditQuery } from "./alert-types.ts";

export const ALERT_STORY = 49;
export const ALERT_EPIC = 45;
export const ALERT_API_PR = 58;

export const ALERT_UI_COLLECTION = "alerts";
export const ALERT_UPSTREAM_COLLECTION = "alerts";
export const ALERT_ACK_ACTION = "ack";
export const ALERT_ACK_UPSTREAM_ACTION = "ack";
export const ALERT_ACK_ROUTE_PUBLISHED = true;

export const WORKSPACE_AUDIT_COLLECTION = "audit-events";
/** E2.2 isolation stub — never the product audit browser. */
export const ISOLATION_AUDIT_SEGMENTS = ["workspace", "audit-events"] as const;

export const ALERT_KIND_QUERY = "kind";
export const ALERT_STATUS_QUERY = "status";
export const ALERT_RESOURCE_TYPE_QUERY = "resourceType";
export const ALERT_RESOURCE_ID_QUERY = "resourceId";
export const ALERT_LIMIT_QUERY = "limit";
export const AUDIT_RESOURCE_TYPE_QUERY = "resourceType";
export const AUDIT_RESOURCE_ID_QUERY = "resourceId";
export const AUDIT_ACTION_QUERY = "action";

export const ALERT_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
  methodNotAllowed: "method-not-allowed",
} as const;

export const ALERT_SECRET_FREE_HELP =
  "Alerts show kind, severity, action, outcome, code, timestamps, and correlation/resource/request ids. Unexpected secret fields are stripped.";

export const AUDIT_APPEND_ONLY_HELP =
  "Workspace audit is append-only for normal roles. This UI does not offer edit or delete. Mutation attempts fail closed at the API.";

export const AUDIT_NOT_ISOLATION_HELP =
  "Product audit is GET /audit-events. E2.2 GET /workspace/audit-events is an isolation stub, not this browser.";

export const ALERT_ACK_APPLIED_MESSAGE =
  "Alert acknowledged (HTTP 200). The API accepted the request.";

export const ALERT_ACK_IDEMPOTENT_MESSAGE =
  "Already acknowledged. A second ack is idempotent — the API did not start new work.";

export const ALERT_ACK_FORBIDDEN_MESSAGE =
  "Acknowledge requires alert.ack. HTTP 403 is fail-closed; this UI does not mark the alert acknowledged.";

export const ALERT_ACK_CSRF_HELP =
  "Ack sends X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const AUDIT_MUTATION_METHODS = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export function alertsPath(): string {
  return `/${ALERT_UI_COLLECTION}`;
}

export function alertPath(alertId: string): string {
  return `${alertsPath()}/${alertId}`;
}

export function alertAckPath(alertId: string): string {
  return `${alertPath(alertId)}/${ALERT_ACK_ACTION}`;
}

export function workspaceAuditEventsPath(): string {
  return `/${WORKSPACE_AUDIT_COLLECTION}`;
}

export function isolationAuditEventsPath(): string {
  return `/${ISOLATION_AUDIT_SEGMENTS.join("/")}`;
}

export function alertHistoryHref(alertId: string): string {
  return `/alerts/${alertId}`;
}

export function auditBrowserHref(): string {
  return "/audit";
}

export function executionCorrelateHref(
  resourceType: string,
  resourceId: string,
): string {
  if (resourceType.trim().toLowerCase() === "execution" && resourceId.trim()) {
    return `/executions/${resourceId.trim()}`;
  }
  return "";
}

function appendQuery(
  path: string,
  pairs: Array<[string, string | number | undefined]>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) {
    if (typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(value));
    } else if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function listAlertsPath(filter: AlertListQuery = {}): string {
  return appendQuery(alertsPath(), [
    [ALERT_KIND_QUERY, filter.kind],
    [ALERT_STATUS_QUERY, filter.status],
    [ALERT_RESOURCE_TYPE_QUERY, filter.resourceType],
    [ALERT_RESOURCE_ID_QUERY, filter.resourceId],
    [ALERT_LIMIT_QUERY, filter.limit],
  ]);
}

export function listWorkspaceAuditEventsPath(
  filter: WorkspaceAuditQuery = {},
): string {
  return appendQuery(workspaceAuditEventsPath(), [
    [AUDIT_RESOURCE_TYPE_QUERY, filter.resourceType],
    [AUDIT_RESOURCE_ID_QUERY, filter.resourceId],
    [AUDIT_ACTION_QUERY, filter.action],
    [ALERT_LIMIT_QUERY, filter.limit],
  ]);
}

/** Empty JSON body — never send host-supplied id / workspaceId. */
export function buildAlertAckBody(): Record<string, never> {
  return {};
}

export function isAlertProxySegments(segments: string[]): boolean {
  return segments[0] === ALERT_UI_COLLECTION;
}

export function isProductAuditSegments(segments: string[]): boolean {
  return segments[0] === WORKSPACE_AUDIT_COLLECTION;
}

export function isIsolationAuditSegments(segments: string[]): boolean {
  return (
    segments.length === 2 &&
    segments[0] === ISOLATION_AUDIT_SEGMENTS[0] &&
    segments[1] === ISOLATION_AUDIT_SEGMENTS[1]
  );
}

/**
 * Rewrite a UI `/api/v1/alerts…` path onto the upstream collection.
 * Query strings are preserved by the proxy `withRequestSearch` hop.
 */
export function retargetCollectionPath(
  uiApiPath: string,
  uiCollection: string,
  upstreamCollection: string,
): string {
  const prefix = `/api/v1/${uiCollection}`;
  const target = `/api/v1/${upstreamCollection}`;
  if (
    uiApiPath === prefix ||
    uiApiPath.startsWith(`${prefix}/`) ||
    uiApiPath.startsWith(`${prefix}?`)
  ) {
    return `${target}${uiApiPath.slice(prefix.length)}`;
  }
  return uiApiPath;
}

export function retargetAlertApiPath(uiApiPath: string): string {
  const collected = retargetCollectionPath(
    uiApiPath,
    ALERT_UI_COLLECTION,
    ALERT_UPSTREAM_COLLECTION,
  );
  if (ALERT_ACK_ACTION === ALERT_ACK_UPSTREAM_ACTION) {
    return collected;
  }
  const from = `/${ALERT_ACK_ACTION}`;
  const to = `/${ALERT_ACK_UPSTREAM_ACTION}`;
  if (collected.endsWith(from) || collected.includes(`${from}?`)) {
    return collected.replace(from, to);
  }
  return collected;
}

export type AlertProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function eq(segments: string[], expected: readonly string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

/**
 * Allowlisted Next proxy routes. identity-proxy spreads this array.
 * Exact #58 routes only — no catalog, resolve, or audit mutations.
 * Isolation GET /workspace/audit-events stays on the E2.2 allowlist.
 */
export const ALERT_PROXY_ROUTES: readonly AlertProxyRoute[] = [
  { methods: ["GET"], match: (s) => eq(s, [ALERT_UI_COLLECTION]) },
  {
    methods: ["POST"],
    match: (s) =>
      ALERT_ACK_ROUTE_PUBLISHED &&
      s.length === 3 &&
      s[0] === ALERT_UI_COLLECTION &&
      isResourceId(s[1]) &&
      s[2] === ALERT_ACK_ACTION,
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === ALERT_UI_COLLECTION &&
      isResourceId(s[1]),
  },
];
