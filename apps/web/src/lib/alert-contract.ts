/**
 * Single adapter for Chloe's E5.4 alert/audit UX (#49).
 *
 * Jonny's alerts route map is still in flight. Paths, query keys,
 * mutation bodies, and problem aliases live here so a later map
 * change does not scatter through UI. Branch against `main` — do
 * not stack on an API feature branch. Do not change `apps/api`.
 *
 * Scaffold (retarget when published):
 *
 *   GET  /alerts                    ?kind&severity&status&limit
 *   GET  /alerts/catalog
 *   GET  /alerts/{id}
 *   POST /alerts/{id}/ack           {}  CSRF  (if published)
 *   POST /alerts/{id}/resolve       {}  CSRF  (if published)
 *   GET  /audit-events              ?resourceType&resourceId&action&limit
 *   GET  /audit-events/{id}
 *
 * Workspace audit is GET /audit-events — not E2.2
 * GET /workspace/audit-events and not GET /session/audit-events.
 * Append-only: this adapter never allowlists POST/PUT/PATCH/DELETE
 * on audit-events. Relates to #49 / Part of #45.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type { AlertListQuery, WorkspaceAuditQuery } from "./alert-types.ts";

export const ALERT_STORY = 49;
export const ALERT_EPIC = 45;

export const ALERT_UI_COLLECTION = "alerts";
export const ALERT_UPSTREAM_COLLECTION = "alerts";
export const ALERT_CATALOG_ACTION = "catalog";
export const ALERT_ACK_ACTION = "ack";
export const ALERT_ACK_UPSTREAM_ACTION = "ack";
export const ALERT_RESOLVE_ACTION = "resolve";
export const ALERT_RESOLVE_UPSTREAM_ACTION = "resolve";

/**
 * Ack/resolve are allowlisted so CSRF POSTs are ready when jonny
 * publishes them. Flip to false to force a read-only list.
 */
export const ALERT_ACK_ROUTE_PUBLISHED = true;
export const ALERT_RESOLVE_ROUTE_PUBLISHED = true;

export const WORKSPACE_AUDIT_COLLECTION = "audit-events";
export const WORKSPACE_AUDIT_UPSTREAM_COLLECTION = "audit-events";
/** E2.2 isolation stub — never the product audit browser. */
export const ISOLATION_AUDIT_SEGMENTS = ["workspace", "audit-events"] as const;
export const SESSION_AUDIT_SEGMENTS = ["session", "audit-events"] as const;

export const ALERT_KIND_QUERY = "kind";
export const ALERT_SEVERITY_QUERY = "severity";
export const ALERT_STATUS_QUERY = "status";
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
  "Alerts show kind, severity, timestamps, correlation id, resource ids, and a safe message. Unexpected secret fields are stripped.";

export const AUDIT_APPEND_ONLY_HELP =
  "Workspace audit is append-only for normal roles. This UI does not offer edit or delete. Mutation attempts fail closed at the API.";

export const AUDIT_NOT_ISOLATION_HELP =
  "Product audit is GET /audit-events. E2.2 GET /workspace/audit-events is an isolation stub, not this browser.";

export const ALERT_ACK_APPLIED_MESSAGE =
  "Alert acknowledged (HTTP 200). The API accepted the request.";

export const ALERT_RESOLVE_APPLIED_MESSAGE =
  "Alert resolved (HTTP 200). The API accepted the request.";

export const ALERT_ACK_FORBIDDEN_MESSAGE =
  "Acknowledge is separately authorized. HTTP 403 is fail-closed; this UI does not mark the alert acknowledged.";

export const ALERT_RESOLVE_FORBIDDEN_MESSAGE =
  "Resolve is separately authorized. HTTP 403 is fail-closed; this UI does not mark the alert resolved.";

export const ALERT_MUTATION_CSRF_HELP =
  "Ack and resolve send X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const ALERT_MUTATION_UNAVAILABLE_MESSAGE =
  "Ack/resolve is hidden until the API publishes those mutations. The list stays read-only.";

export const AUDIT_MUTATION_METHODS = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export function alertsPath(): string {
  return `/${ALERT_UI_COLLECTION}`;
}

export function alertsCatalogPath(): string {
  return `${alertsPath()}/${ALERT_CATALOG_ACTION}`;
}

export function alertPath(alertId: string): string {
  return `${alertsPath()}/${alertId}`;
}

export function alertAckPath(alertId: string): string {
  return `${alertPath(alertId)}/${ALERT_ACK_ACTION}`;
}

export function alertResolvePath(alertId: string): string {
  return `${alertPath(alertId)}/${ALERT_RESOLVE_ACTION}`;
}

export function workspaceAuditEventsPath(): string {
  return `/${WORKSPACE_AUDIT_COLLECTION}`;
}

export function workspaceAuditEventPath(auditEventId: string): string {
  return `${workspaceAuditEventsPath()}/${auditEventId}`;
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
    [ALERT_SEVERITY_QUERY, filter.severity],
    [ALERT_STATUS_QUERY, filter.status],
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
    [ALERT_KIND_QUERY, filter.kind],
    [ALERT_LIMIT_QUERY, filter.limit],
  ]);
}

/** Empty JSON body — never send host-supplied id / workspaceId. */
export function buildAlertAckBody(): Record<string, never> {
  return {};
}

export function buildAlertResolveBody(): Record<string, never> {
  return {};
}

export function isAlertProxySegments(segments: string[]): boolean {
  if (segments[0] === ALERT_UI_COLLECTION) {
    return true;
  }
  return (
    segments[0] === WORKSPACE_AUDIT_COLLECTION &&
    segments.length === 2 &&
    isResourceId(segments[1])
  );
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

function retargetAction(
  path: string,
  fromAction: string,
  toAction: string,
): string {
  if (fromAction === toAction) {
    return path;
  }
  const from = `/${fromAction}`;
  const to = `/${toAction}`;
  if (path.endsWith(from) || path.includes(`${from}?`)) {
    return path.replace(from, to);
  }
  return path;
}

export function retargetAlertApiPath(uiApiPath: string): string {
  if (
    uiApiPath === `/api/v1/${WORKSPACE_AUDIT_COLLECTION}` ||
    uiApiPath.startsWith(`/api/v1/${WORKSPACE_AUDIT_COLLECTION}/`) ||
    uiApiPath.startsWith(`/api/v1/${WORKSPACE_AUDIT_COLLECTION}?`)
  ) {
    return retargetCollectionPath(
      uiApiPath,
      WORKSPACE_AUDIT_COLLECTION,
      WORKSPACE_AUDIT_UPSTREAM_COLLECTION,
    );
  }
  let collected = retargetCollectionPath(
    uiApiPath,
    ALERT_UI_COLLECTION,
    ALERT_UPSTREAM_COLLECTION,
  );
  collected = retargetAction(
    collected,
    ALERT_ACK_ACTION,
    ALERT_ACK_UPSTREAM_ACTION,
  );
  return retargetAction(
    collected,
    ALERT_RESOLVE_ACTION,
    ALERT_RESOLVE_UPSTREAM_ACTION,
  );
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
 * Audit rows are GET-only. Do not add POST /alerts or any
 * mutation on /audit-events. Isolation GET /workspace/audit-events
 * stays on the E2.2 allowlist, not here.
 */
export const ALERT_PROXY_ROUTES: readonly AlertProxyRoute[] = [
  {
    methods: ["GET"],
    match: (s) => eq(s, [ALERT_UI_COLLECTION, ALERT_CATALOG_ACTION]),
  },
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
    methods: ["POST"],
    match: (s) =>
      ALERT_RESOLVE_ROUTE_PUBLISHED &&
      s.length === 3 &&
      s[0] === ALERT_UI_COLLECTION &&
      isResourceId(s[1]) &&
      s[2] === ALERT_RESOLVE_ACTION,
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === ALERT_UI_COLLECTION &&
      isResourceId(s[1]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === WORKSPACE_AUDIT_COLLECTION &&
      isResourceId(s[1]),
  },
];
