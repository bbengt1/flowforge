/**
 * Single adapter for Chloe's execution UI.
 *
 * E5.1 (#51 on `main`): list/detail + idempotent start.
 * E5.2 (#47): cancel/retry/status, retargeted to Jonny's #53 map.
 *
 * Status (steps, jobs, leaseExpiresAt, heartbeatAt, fencingToken) comes
 * from polling `GET /api/v1/executions/{id}` — never `/jobs/*`
 * (claim / heartbeat / complete / fail / recover).
 *
 * Browser stays on same-origin `/api/v1/…`. Next rewrites to
 * `/api/control-plane/*`; identity-proxy maps onto the Go API.
 *
 * Relates to #47 / Part of #45. Cites #53. Do not change `apps/api`.
 * Do not close #47 alone.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type { AuditEventQuery, ExecutionListQuery } from "./execution-types.ts";

export const EXECUTION_STORY = 46;
export const EXECUTION_DISPATCH_STORY = 47;
export const EXECUTION_EPIC = 45;
export const EXECUTION_API_PR = 53;

export const EXECUTION_UI_COLLECTION = "executions";
export const EXECUTION_UPSTREAM_COLLECTION = "executions";

export const EXECUTION_STEPS_ACTION = "steps";
export const EXECUTION_JOBS_ACTION = "jobs";
export const EXECUTION_AUDIT_EVENTS_ACTION = "audit-events";
export const EXECUTION_CANCEL_ACTION = "cancel";
export const EXECUTION_CANCEL_UPSTREAM_ACTION = "cancel";
export const EXECUTION_RETRY_ACTION = "retry";
/** #53 published POST …/retry and POST …/steps/{stepId}/retry. */
export const EXECUTION_RETRY_ROUTE_PUBLISHED = true;
/** Poll GET /executions/{id} while queued/running. Never poll /jobs/*. */
export const EXECUTION_STATUS_POLL_MS = 2000;
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

export const CANCEL_APPLIED_MESSAGE =
  "Cancellation recorded. The API accepted the request (HTTP 200).";

export const CANCEL_IDEMPOTENT_MESSAGE =
  "Already canceled. A second cancel is idempotent — the API did not start new work.";

export const CANCEL_FORBIDDEN_MESSAGE =
  "Cancel is separately authorized (execution.cancel). HTTP 403 is fail-closed; this UI does not treat the run as canceled.";

export const CANCEL_CSRF_HELP =
  "Cancel sends X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const INDETERMINATE_STATUS_HELP =
  "Indeterminate means a remote side effect may have occurred and was not verified. Do not assume the action did not run.";

export const RETRY_UNAVAILABLE_MESSAGE =
  "Retry is only offered for failed or canceled core data.* / flow.* steps. Provider nodes and other terminals are not retried from this UI.";

export const RETRY_INDETERMINATE_MESSAGE =
  "Retry is not offered for indeterminate outcomes. A remote side effect may have occurred and was not verified. Do not assume the action did not run.";

export const RETRY_APPLIED_MESSAGE =
  "Retry queued a new attempt (HTTP 201). The API did not silently re-run an indeterminate step.";

export const RETRY_FORBIDDEN_MESSAGE =
  "Retry requires workflow.execute. HTTP 403 is fail-closed; this UI does not start another attempt.";

export const RETRY_CONFLICT_MESSAGE =
  "The API rejected retry (HTTP 409). Indeterminate and provider nodes cannot be retried.";

export const RETRY_CSRF_HELP =
  "Retry sends X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const STATUS_POLL_HELP =
  "While queued or running, this page polls GET /executions/{id} for steps and jobs. It never calls /jobs/*.";

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

export function executionCancelPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_CANCEL_ACTION}`;
}

export function workflowExecutionCancelPath(
  workflowId: string,
  executionId: string,
): string {
  return `${workflowExecutionPath(workflowId, executionId)}/${EXECUTION_CANCEL_ACTION}`;
}

export function executionRetryPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_RETRY_ACTION}`;
}

export function executionStepRetryPath(
  executionId: string,
  stepId: string,
): string {
  return `${executionStepPath(executionId, stepId)}/${EXECUTION_RETRY_ACTION}`;
}

export function workflowExecutionRetryPath(
  workflowId: string,
  executionId: string,
): string {
  return `${workflowExecutionPath(workflowId, executionId)}/${EXECUTION_RETRY_ACTION}`;
}

/** Empty JSON body — Go `EmptyDispatchRequest`. Never send host-supplied id / workspaceId. */
export function buildCancelBody(): Record<string, never> {
  return {};
}

/** Go `RetryRequest` — optional stepId when retrying a known step. */
export function buildRetryBody(input?: { stepId?: string }): {
  stepId?: string;
} {
  if (input?.stepId) {
    return { stepId: input.stepId };
  }
  return {};
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
  if (
    segments[0] === EXECUTION_UI_COLLECTION ||
    segments[0] === WORKSPACE_AUDIT_EVENTS_COLLECTION
  ) {
    return true;
  }
  return (
    segments[0] === "workflows" &&
    segments[2] === EXECUTION_UI_COLLECTION &&
    (segments[4] === EXECUTION_CANCEL_ACTION ||
      segments[4] === EXECUTION_CANCEL_UPSTREAM_ACTION ||
      segments[4] === EXECUTION_RETRY_ACTION)
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
  const collected = retargetCollectionPath(
    uiApiPath,
    EXECUTION_UI_COLLECTION,
    EXECUTION_UPSTREAM_COLLECTION,
  );
  if (EXECUTION_CANCEL_ACTION === EXECUTION_CANCEL_UPSTREAM_ACTION) {
    return collected;
  }
  const from = `/${EXECUTION_CANCEL_ACTION}`;
  const to = `/${EXECUTION_CANCEL_UPSTREAM_ACTION}`;
  if (collected.endsWith(from) || collected.includes(`${from}?`)) {
    return collected.replace(from, to);
  }
  return collected;
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
 * Allowlisted Next proxy routes. identity-proxy spreads this array.
 * POST start stays on `/workflows/{id}/executions` (already
 * allowlisted with CSRF). Do not add POST /executions or any
 * `/jobs/*` worker route (claim / heartbeat / complete / fail /
 * recover). Cancel and retry follow the #53 map.
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
    methods: ["POST"],
    match: (s) =>
      s.length === 5 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]) &&
      s[2] === EXECUTION_STEPS_ACTION &&
      isResourceId(s[3]) &&
      s[4] === EXECUTION_RETRY_ACTION,
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
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]) &&
      (s[2] === EXECUTION_CANCEL_ACTION || s[2] === EXECUTION_RETRY_ACTION),
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
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "executions" &&
      isResourceId(s[3]) &&
      (s[4] === EXECUTION_CANCEL_ACTION || s[4] === EXECUTION_RETRY_ACTION),
  },
];
