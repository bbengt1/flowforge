/**
 * TanStack Query conventions for FlowForge server state (G.3.4 / #481).
 *
 * The cache is memory-only. Do not add a persister, dehydrate into HTML,
 * or copy query data into localStorage, sessionStorage, IndexedDB, logs,
 * or the embed room. Query keys carry workspace scope and resource ids.
 * They never carry passwords, tokens, cookies, authorization headers, or
 * download grants. Cached values are stripped before they are stored.
 *
 * Mutations do not retry: replaying POST/DELETE is not fail-closed.
 * Client errors (4xx) do not retry. 5xx and network failures retry twice.
 */

import {
  CancelledError,
  QueryClient,
  type QueryClientConfig,
} from "@tanstack/react-query";
import type { DevIdentity } from "./identity-headers.ts";
import { workspaceLookupKey } from "./identity-headers.ts";
import { isSecretFieldName, normalizeSecretKey } from "./execution.ts";
import { REDACTED_MARKER } from "./execution-types.ts";
import {
  safeProblemDetail,
  type ProblemDetails,
} from "./problem.ts";

export { CancelledError };

/** How many times a failed query may retry after the first attempt. */
export const QUERY_MAX_RETRIES = 2;

export const FLOWFORGE_QUERY_META = {
  persistence: "memory",
  secrets: "stripped-before-cache",
} as const;

const memoryOnlyClients = new WeakSet<QueryClient>();

/**
 * Signed URLs and grant material are not always named like a password.
 * Drop them even when the field name misses the secret-key list.
 * Generic `url` / `href` stay: catalogs use those for documentation links.
 */
const QUERY_CACHE_EXTRA_KEYS = new Set([
  "signedurl",
  "signed_url",
  "presignedurl",
  "presigned_url",
  "storageref",
  "storage_ref",
  "accesskey",
  "access_key",
  "accesskeyid",
  "access_key_id",
]);

const CREDENTIAL_STRING =
  /^(?:bearer|basic)\s+\S+$/i;

const CONNECTION_STRING = /^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i;

export class QueryCacheError extends Error {
  readonly statusCode: number;
  readonly requestId: string;
  readonly code: string;
  readonly problem: ProblemDetails;
  readonly forbidden: boolean;

  constructor(problem: ProblemDetails) {
    const safe = cacheSafeProblem(problem);
    super(safe.detail);
    this.name = "QueryCacheError";
    this.problem = safe;
    this.statusCode = safe.status;
    this.requestId = safe.request_id;
    this.code = safe.code;
    this.forbidden =
      safe.status === 401 || safe.status === 403 || safe.code === "forbidden";
  }
}

export function cacheSafeProblem(problem: ProblemDetails): ProblemDetails {
  return {
    ...problem,
    detail: safeProblemDetail(problem.detail),
    errors: problem.errors?.map((error) => ({
      ...error,
      message: safeProblemDetail(error.message),
    })),
  };
}

export function isRetryableQueryStatus(statusCode: number): boolean {
  return statusCode === 0 || statusCode >= 500;
}

export function isFailClosedQueryError(error: unknown): boolean {
  if (error instanceof CancelledError) {
    return true;
  }
  if (error instanceof QueryCacheError) {
    return error.statusCode >= 400 && error.statusCode < 500;
  }
  return false;
}

/**
 * TanStack calls `retry` with the number of failures so far, starting at 0
 * on the first failure, before it increments. `QUERY_MAX_RETRIES` is the
 * number of extra attempts after that first failure.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_MAX_RETRIES) {
    return false;
  }
  if (isFailClosedQueryError(error)) {
    return false;
  }
  return true;
}

export function flowforgeQueryRetryDelay(failureCount: number): number {
  const shift = Math.min(Math.max(0, Math.floor(failureCount)), 4);
  return Math.min(400 * 2 ** shift, 4_000);
}

export async function runWithQueryRetry<T>(
  attempt: () => Promise<T>,
  options?: { delay?: (failureCount: number) => number },
): Promise<T> {
  let failureCount = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!shouldRetryQuery(failureCount, error)) {
        throw error;
      }
      const wait = (options?.delay ?? flowforgeQueryRetryDelay)(failureCount);
      failureCount += 1;
      if (wait > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, wait);
        });
      }
    }
  }
}

export function queryKeyHasSecret(key: readonly unknown[]): boolean {
  return valueHasSecret(key);
}

export function assertQueryKeySafe(key: readonly unknown[]): void {
  if (queryKeyHasSecret(key)) {
    throw new Error(
      "Query key contains a secret or credential. Keys may carry workspace scope and resource ids only.",
    );
  }
}

/**
 * Principal + workspace scope for cache partitioning.
 * Issuer and subject are caller ids already held by the session, not
 * credentials. Display name, cookies, and tokens are omitted.
 */
export function queryScopeFromIdentity(identity: DevIdentity): string {
  return [
    workspaceLookupKey(identity),
    identity.issuer.trim(),
    identity.subject.trim(),
  ].join("\n");
}

export function tryQueryScope(identity: DevIdentity): string | null {
  const scope = queryScopeFromIdentity(identity);
  if (queryKeyHasSecret([scope])) {
    return null;
  }
  return scope;
}

export function sanitizeQueryCacheValue<T>(value: T): {
  value: T;
  strippedKeys: string[];
} {
  const strippedKeys: string[] = [];
  const cleaned = stripForQueryCache(value, strippedKeys) as T;
  return { value: cleaned, strippedKeys };
}

export function queryClientIsMemoryOnly(client: QueryClient): boolean {
  return memoryOnlyClients.has(client);
}

export function createFlowforgeQueryClient(
  config?: QueryClientConfig,
): QueryClient {
  const client = new QueryClient({
    ...config,
    defaultOptions: {
      ...config?.defaultOptions,
      queries: {
        retry: shouldRetryQuery,
        retryDelay: flowforgeQueryRetryDelay,
        staleTime: 10_000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        meta: FLOWFORGE_QUERY_META,
        ...config?.defaultOptions?.queries,
      },
      mutations: {
        retry: false,
        ...config?.defaultOptions?.mutations,
      },
    },
  });
  memoryOnlyClients.add(client);
  return client;
}

export const BLOCKED_QUERY_KEY = ["flowforge", "blocked"] as const;

export function workspacePermissionsQueryKey(
  scope: string,
): readonly ["flowforge", "workspace", "permissions", string] | null {
  const key = ["flowforge", "workspace", "permissions", scope] as const;
  if (queryKeyHasSecret(key)) {
    return null;
  }
  return key;
}

export function executionHistoryQueryKey(
  scope: string,
  executionId: string,
  workflowId?: string,
): readonly ["flowforge", "execution", string, string, "history", string] | null {
  const key = [
    "flowforge",
    "execution",
    scope,
    executionId,
    "history",
    workflowId ?? "",
  ] as const;
  if (queryKeyHasSecret(key)) {
    return null;
  }
  return key;
}

export function executionContextQueryKey(
  scope: string,
  executionId: string,
  workflowId: string,
  versionId: string,
):
  | readonly [
      "flowforge",
      "execution",
      string,
      string,
      "context",
      string,
      string,
    ]
  | null {
  const key = [
    "flowforge",
    "execution",
    scope,
    executionId,
    "context",
    workflowId,
    versionId,
  ] as const;
  if (queryKeyHasSecret(key)) {
    return null;
  }
  return key;
}

export function executionLogsQueryKey(
  scope: string,
  executionId: string,
  stepIds: readonly string[],
):
  | readonly ["flowforge", "execution", string, string, "logs", string]
  | null {
  const key = [
    "flowforge",
    "execution",
    scope,
    executionId,
    "logs",
    [...stepIds].sort().join(","),
  ] as const;
  if (queryKeyHasSecret(key)) {
    return null;
  }
  return key;
}

/** Roots reserved for the remaining god-component splits. */
export const REMAINING_GOD_COMPONENT_QUERY_ROOTS = {
  workflowHome: ["flowforge", "workflow-home"] as const,
  workflowOperator: ["flowforge", "workflow-operator"] as const,
  actionWizard: ["flowforge", "action-wizard"] as const,
};

function valueHasSecret(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return CREDENTIAL_STRING.test(trimmed) || CONNECTION_STRING.test(trimmed);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueHasSecret(item));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDroppedQueryCacheKey(key) || valueHasSecret(child)) {
      return true;
    }
  }
  return false;
}

function isDroppedQueryCacheKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  const compact = normalized.replace(/_/g, "");
  return (
    isSecretFieldName(key) ||
    QUERY_CACHE_EXTRA_KEYS.has(normalized) ||
    QUERY_CACHE_EXTRA_KEYS.has(compact)
  );
}

function stripForQueryCache(
  value: unknown,
  strippedKeys: string[],
  path = "",
): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (CREDENTIAL_STRING.test(trimmed) || CONNECTION_STRING.test(trimmed)) {
      strippedKeys.push(path || "$");
      return REDACTED_MARKER;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      stripForQueryCache(
        item,
        strippedKeys,
        path ? `${path}[${index}]` : `[${index}]`,
      ),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isDroppedQueryCacheKey(key)) {
      if (child === REDACTED_MARKER) {
        out[key] = REDACTED_MARKER;
        continue;
      }
      strippedKeys.push(childPath);
      continue;
    }
    out[key] = stripForQueryCache(child, strippedKeys, childPath);
  }
  return out;
}
