/**
 * Single adapter for Chloe's E5.1 UI against jonny's #51 route map.
 *
 * Exact paths only — do not invent collections or query params.
 * Browser stays on same-origin `/api/v1/…`. Next rewrites to
 * `/api/control-plane/*`; identity-proxy maps onto the Go API.
 *
 * Relates to #46 / Part of #45. Do not change `apps/api`.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type { AuditEventQuery, ExecutionListQuery } from "./execution-types.ts";

export const EXECUTION_STORY = 46;
export const EXECUTION_EPIC = 45;
export const EXECUTION_API_PR = 51;

export const EXECUTION_UI_COLLECTION = "executions";
export const EXECUTION_UPSTREAM_COLLECTION = "executions";

export const EXECUTION_STEPS_ACTION = "steps";
export const EXECUTION_JOBS_ACTION = "jobs";
export const EXECUTION_AUDIT_EVENTS_ACTION = "audit-events";
export const WORKSPACE_AUDIT_EVENTS_COLLECTION = "audit-events";

export const EXECUTION_WORKFLOW_QUERY = "workflowId";
export const EXECUTION_STATUS_QUERY = "status";
export const EXECUTION_LIMIT_QUERY = "limit";
export const AUDIT_RESOURCE_TYPE_QUERY = "resourceType";
export const AUDIT_RESOURCE_ID_QUERY = "resourceId";
export const AUDIT_ACTION_QUERY = "action";

export const EXECUTION_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

export const IDEMPOTENCY_REPLAY_MESSAGE =
  "Replayed existing run (HTTP 200). The same (workspace, workflow version, idempotency key) did not start a second execution.";

export const IDEMPOTENCY_CREATED_MESSAGE =
  "Started a new execution (HTTP 201).";

export const IDEMPOTENCY_CONFLICT_MESSAGE =
  "This idempotency key was already used with a different input (HTTP 409). The API did not start a new run. Do not retry with a new key unless you intend a new execution.";

export const IDEMPOTENCY_KEY_HELP =
  "Optional. Unique per workspace and workflow version. Same key + same input returns the original run (200). Same key + different input is 409.";

export const REDACTED_HELP =
  "Secret values from the API appear as [redacted]. Unexpected secret field names are stripped.";

export function executionsPath(): string {
  return `/${EXECUTION_UI_COLLECTION}`;
}

export function executionPath(executionId: string): string {
  return `${executionsPath()}/${executionId}`;
}

export function executionStepsPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_STEPS_ACTION}`;
}

export function executionStepPath(
  executionId: string,
  stepId: string,
): string {
  return `${executionStepsPath(executionId)}/${stepId}`;
}

export function executionJobsPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_JOBS_ACTION}`;
}

export function executionAuditEventsPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_AUDIT_EVENTS_ACTION}`;
}

/** @deprecated Use executionAuditEventsPath — #51 is …/audit-events, not …/events. */
export function executionEventsPath(executionId: string): string {
  return executionAuditEventsPath(executionId);
}

export function workspaceAuditEventsPath(): string {
  return `/${WORKSPACE_AUDIT_EVENTS_COLLECTION}`;
}

export function workflowExecutionsCollectionPath(workflowId: string): string {
  return `/workflows/${workflowId}/executions`;
}

export function workflowExecutionPath(
  workflowId: string,
  executionId: string,
): string {
  return `${workflowExecutionsCollectionPath(workflowId)}/${executionId}`;
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

export function listExecutionsPath(filter: ExecutionListQuery = {}): string {
  return appendQuery(executionsPath(), [
    [EXECUTION_WORKFLOW_QUERY, filter.workflowId],
    [EXECUTION_STATUS_QUERY, filter.status],
    [EXECUTION_LIMIT_QUERY, filter.limit],
  ]);
}

export function listWorkflowExecutionsPath(
  workflowId: string,
  filter: Pick<ExecutionListQuery, "status" | "limit"> = {},
): string {
  return appendQuery(workflowExecutionsCollectionPath(workflowId), [
    [EXECUTION_STATUS_QUERY, filter.status],
    [EXECUTION_LIMIT_QUERY, filter.limit],
  ]);
}

export function listWorkspaceAuditEventsPath(
  filter: AuditEventQuery = {},
): string {
  return appendQuery(workspaceAuditEventsPath(), [
    [AUDIT_RESOURCE_TYPE_QUERY, filter.resourceType],
    [AUDIT_RESOURCE_ID_QUERY, filter.resourceId],
    [AUDIT_ACTION_QUERY, filter.action],
    [EXECUTION_LIMIT_QUERY, filter.limit],
  ]);
}

export function executionHistoryHref(
  executionId: string,
  workflowId?: string,
): string {
  const base = `/executions/${executionId}`;
  const id = workflowId?.trim();
  return id ? `${base}?workflowId=${encodeURIComponent(id)}` : base;
}

export function isExecutionProxySegments(segments: string[]): boolean {
  return (
    segments[0] === EXECUTION_UI_COLLECTION ||
    segments[0] === WORKSPACE_AUDIT_EVENTS_COLLECTION
  );
}

/**
 * Rewrite a UI `/api/v1/executions…` path onto the upstream collection.
 * Query strings are preserved by the proxy `withRequestSearch` hop.
 * `/audit-events` is already the #51 workspace audit path (not E2.2).
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

export function retargetExecutionApiPath(uiApiPath: string): string {
  if (
    uiApiPath === `/api/v1/${WORKSPACE_AUDIT_EVENTS_COLLECTION}` ||
    uiApiPath.startsWith(`/api/v1/${WORKSPACE_AUDIT_EVENTS_COLLECTION}?`)
  ) {
    return uiApiPath;
  }
  return retargetCollectionPath(
    uiApiPath,
    EXECUTION_UI_COLLECTION,
    EXECUTION_UPSTREAM_COLLECTION,
  );
}

export type ExecutionProxyRoute = {
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
 * Allowlisted Next proxy routes from #51. identity-proxy spreads this
 * array. POST start stays on `/workflows/{id}/executions` (already
 * allowlisted with CSRF). Do not add POST /executions.
 */
export const EXECUTION_PROXY_ROUTES: readonly ExecutionProxyRoute[] = [
  { methods: ["GET"], match: (s) => eq(s, [EXECUTION_UI_COLLECTION]) },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 4 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]) &&
      s[2] === EXECUTION_STEPS_ACTION &&
      isResourceId(s[3]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]) &&
      (s[2] === EXECUTION_STEPS_ACTION ||
        s[2] === EXECUTION_JOBS_ACTION ||
        s[2] === EXECUTION_AUDIT_EVENTS_ACTION),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]),
  },
  {
    methods: ["GET"],
    match: (s) => eq(s, [WORKSPACE_AUDIT_EVENTS_COLLECTION]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "executions",
  },
];
