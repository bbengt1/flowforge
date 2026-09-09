/**
 * Single retarget adapter for E5.1 execution history (Chloe UI).
 *
 * Browser fetches stay on same-origin `/api/v1/executions*`. Next rewrites
 * those to `/api/control-plane/*`, and identity-proxy maps them onto the
 * Go API. Jonny's persistence query routes are still in flight — change
 * `EXECUTION_UPSTREAM_COLLECTION` here if they land under another prefix.
 *
 * Existing start remains `POST /workflows/{workflowId}/executions`
 * `{workflowVersionId}` (E3.2). This adapter only allowlists query GETs.
 *
 * Relates to #46 / Part of #45. Do not change `apps/api`.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import type { ExecutionListQuery } from "./execution-types.ts";

export const EXECUTION_STORY = 46;
export const EXECUTION_EPIC = 45;

/** UI + Next proxy collection under `/api/v1/`. */
export const EXECUTION_UI_COLLECTION = "executions";

/**
 * Upstream Go collection. Identity mapping until jonny publishes.
 * Example retarget: `"workspace/executions"`.
 */
export const EXECUTION_UPSTREAM_COLLECTION = "executions";

export const EXECUTION_STEPS_ACTION = "steps";
export const EXECUTION_JOBS_ACTION = "jobs";
export const EXECUTION_EVENTS_ACTION = "events";

export const EXECUTION_WORKFLOW_QUERY = "workflowId";
export const EXECUTION_WORKFLOW_VERSION_QUERY = "workflowVersionId";
export const EXECUTION_STATUS_QUERY = "status";
export const EXECUTION_STARTED_AFTER_QUERY = "startedAfter";
export const EXECUTION_STARTED_BEFORE_QUERY = "startedBefore";
export const EXECUTION_CORRELATION_QUERY = "correlationId";

export const EXECUTION_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
} as const;

export const IDEMPOTENCY_REPLAY_MESSAGE =
  "This (workspace, workflow version, idempotency key) reused an existing run and did not start a second execution.";

export const IDEMPOTENCY_KEY_HELP =
  "Idempotency keys are unique per workspace and workflow version. A duplicate key does not create a second run when the API returns that behavior.";

export function executionsPath(): string {
  return `/${EXECUTION_UI_COLLECTION}`;
}

export function executionPath(executionId: string): string {
  return `${executionsPath()}/${executionId}`;
}

export function executionStepsPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_STEPS_ACTION}`;
}

export function executionJobsPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_JOBS_ACTION}`;
}

export function executionEventsPath(executionId: string): string {
  return `${executionPath(executionId)}/${EXECUTION_EVENTS_ACTION}`;
}

export function listExecutionsPath(filter: ExecutionListQuery = {}): string {
  const params = new URLSearchParams();
  if (filter.workflowId?.trim()) {
    params.set(EXECUTION_WORKFLOW_QUERY, filter.workflowId.trim());
  }
  if (filter.workflowVersionId?.trim()) {
    params.set(EXECUTION_WORKFLOW_VERSION_QUERY, filter.workflowVersionId.trim());
  }
  if (filter.status?.trim()) {
    params.set(EXECUTION_STATUS_QUERY, filter.status.trim());
  }
  if (filter.startedAfter?.trim()) {
    params.set(EXECUTION_STARTED_AFTER_QUERY, filter.startedAfter.trim());
  }
  if (filter.startedBefore?.trim()) {
    params.set(EXECUTION_STARTED_BEFORE_QUERY, filter.startedBefore.trim());
  }
  if (filter.correlationId?.trim()) {
    params.set(EXECUTION_CORRELATION_QUERY, filter.correlationId.trim());
  }
  const query = params.toString();
  return query ? `${executionsPath()}?${query}` : executionsPath();
}

export function executionHistoryHref(
  executionId: string,
  workflowId?: string,
): string {
  const base = `/executions/${executionId}`;
  const id = workflowId?.trim();
  return id ? `${base}?workflowId=${encodeURIComponent(id)}` : base;
}

/** Existing E3.2 pin read — fallback when workspace list/detail is 404. */
export function workflowExecutionPinPath(
  workflowId: string,
  executionId: string,
): string {
  return `/workflows/${workflowId}/executions/${executionId}`;
}

export function isExecutionProxySegments(segments: string[]): boolean {
  return segments[0] === EXECUTION_UI_COLLECTION;
}

/**
 * Rewrite a UI `/api/v1/executions…` path onto jonny's upstream collection.
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

export function retargetExecutionApiPath(uiApiPath: string): string {
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
 * Allowlisted Next proxy routes. identity-proxy spreads this array so a
 * retarget only edits this file.
 */
export const EXECUTION_PROXY_ROUTES: readonly ExecutionProxyRoute[] = [
  { methods: ["GET"], match: (s) => eq(s, [EXECUTION_UI_COLLECTION]) },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]) &&
      (s[2] === EXECUTION_STEPS_ACTION ||
        s[2] === EXECUTION_JOBS_ACTION ||
        s[2] === EXECUTION_EVENTS_ACTION),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === EXECUTION_UI_COLLECTION &&
      isResourceId(s[1]),
  },
];
