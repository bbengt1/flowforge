/**
 * Server cache for ExecutionDetail — the first of the four god components
 * (gap F3). Fetch and cache live here. Chrome keeps cancel, retry,
 * emergency stop, download, compare, and selection.
 *
 * Follow-ons, not this change:
 * - WorkflowHome: folder list, workflow pages, search, and row extras.
 *   Explorer selection, rename, and move stay local UI state.
 * - WorkflowOperator: catalog, versions, run logs, pins, and approvals.
 *   The draft document stays local (YAML is source of truth; drafts never run).
 * - ActionWizard: ops-config pin catalog and credential display-name lookups.
 *   Wizard step state stays local. Vault cache is display name + UUID only.
 */

import type { ApprovalRequest } from "./approval-types.ts";
import { listExecutionApprovals } from "./approval-client.ts";
import {
  getExecutionStepLogs,
  loadExecutionHistory,
  type ExecutionClientFailure,
  type ExecutionDetailSuccess,
} from "./execution-client.ts";
import type { ExecutionDetail, ExecutionLogSlice } from "./execution-types.ts";
import { callIdentityProxy, type IdentityClientResult } from "./identity-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { CurrentWorkspace } from "./identity-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  QueryCacheError,
  cacheSafeProblem,
  isRetryableQueryStatus,
  runWithQueryRetry,
  sanitizeQueryCacheValue,
} from "./query-cache.ts";
import {
  fetchWorkflowCatalog,
  getWorkflowVersion,
} from "./workflow-client.ts";
import type { WorkflowCatalog, WorkflowVersion } from "./workflow-types.ts";

/** Same path ExecutionDetail used before the cache split. */
export const EXECUTION_DETAIL_WORKSPACE_PATH = "/workspace";

export const EXECUTION_SERVER_QUERY_OPTIONS = {
  staleTime: 0,
  gcTime: 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export type WorkspacePermissionsCache = {
  permissions: string[];
  actorUserId: string;
};

export type ExecutionHistoryCache = {
  detail: ExecutionDetail | null;
  problem: ProblemDetails | null;
  forbidden: boolean;
  requestId: string;
  strippedKeys: string[];
};

export type ExecutionContextCache = {
  version: WorkflowVersion | null;
  catalog: WorkflowCatalog | null;
  approvals: ApprovalRequest[];
  requestId: string;
  strippedKeys: string[];
};

export type ExecutionLogsCache = {
  stepLogs: Record<string, ExecutionLogSlice>;
  strippedKeys: string[];
};

export type ExecutionHistoryLoader = (
  identity: DevIdentity,
  executionId: string,
  workflowId?: string,
) => Promise<ExecutionDetailSuccess | ExecutionClientFailure>;

export type WorkspacePermissionsLoader = (
  identity: DevIdentity,
) => Promise<IdentityClientResult<CurrentWorkspace>>;

export function emptyExecutionHistoryCache(): ExecutionHistoryCache {
  return {
    detail: null,
    problem: null,
    forbidden: false,
    requestId: "",
    strippedKeys: [],
  };
}

export function emptyExecutionContextCache(): ExecutionContextCache {
  return {
    version: null,
    catalog: null,
    approvals: [],
    requestId: "",
    strippedKeys: [],
  };
}

export function emptyExecutionLogsCache(): ExecutionLogsCache {
  return {
    stepLogs: {},
    strippedKeys: [],
  };
}

export function mergePolledExecution(
  current: ExecutionHistoryCache | undefined,
  polled: {
    execution: ExecutionDetail;
    strippedKeys: string[];
    requestId: string;
  },
): ExecutionHistoryCache {
  const base = current ?? emptyExecutionHistoryCache();
  const execution = polled.execution;
  const detail = base.detail
    ? {
        ...execution,
        auditEvents:
          execution.auditEvents.length > 0
            ? execution.auditEvents
            : base.detail.auditEvents,
        artifacts:
          execution.artifacts.length > 0
            ? execution.artifacts
            : base.detail.artifacts,
      }
    : execution;
  return sealHistory({
    ...base,
    detail,
    problem: base.problem,
    forbidden: false,
    requestId: polled.requestId,
    strippedKeys: polled.strippedKeys,
  });
}

export function forbiddenPollCache(
  current: ExecutionHistoryCache | undefined,
  failure: { problem: ProblemDetails; requestId: string },
): ExecutionHistoryCache {
  const base = current ?? emptyExecutionHistoryCache();
  return sealHistory({
    ...base,
    detail: null,
    problem: cacheSafeProblem(failure.problem),
    forbidden: true,
    requestId: failure.requestId,
  });
}

export function withExecutionDetail(
  current: ExecutionHistoryCache | undefined,
  execution: ExecutionDetail,
  strippedKeys: string[],
): ExecutionHistoryCache {
  const base = current ?? emptyExecutionHistoryCache();
  const sanitized = sanitizeQueryCacheValue(execution);
  return {
    ...base,
    detail: sanitized.value,
    forbidden: false,
    strippedKeys: uniqueStrings([
      ...strippedKeys,
      ...sanitized.strippedKeys,
    ]),
  };
}

export function patchExecutionApprovals(
  current: ExecutionContextCache | undefined,
  updater: (approvals: ApprovalRequest[]) => ApprovalRequest[],
): ExecutionContextCache {
  const base = current ?? emptyExecutionContextCache();
  const approvals = updater(base.approvals);
  return sealContext({ ...base, approvals });
}

export async function loadWorkspacePermissionsCache(
  identity: DevIdentity,
  load: WorkspacePermissionsLoader = defaultWorkspaceLoader,
): Promise<WorkspacePermissionsCache> {
  const workspace = await load(identity);
  if (workspace.ok) {
    return sanitizeQueryCacheValue({
      permissions: workspace.data.permissions ?? [],
      actorUserId: workspace.data.principal?.id ?? "",
    }).value;
  }
  if (workspace.statusCode === 401 || workspace.statusCode === 403) {
    return { permissions: [], actorUserId: "" };
  }
  throw new QueryCacheError(workspace.problem);
}

export async function loadExecutionHistoryCache(
  identity: DevIdentity,
  executionId: string,
  workflowId: string | undefined,
  previous: ExecutionHistoryCache | undefined,
  options?: {
    loadHistory?: ExecutionHistoryLoader;
    delay?: (failureCount: number) => number;
  },
): Promise<ExecutionHistoryCache> {
  const loadHistory = options?.loadHistory ?? loadExecutionHistory;
  try {
    return await runWithQueryRetry(
      () => fetchHistoryOnce(loadHistory, identity, executionId, workflowId, previous),
      options?.delay ? { delay: options.delay } : undefined,
    );
  } catch (error) {
    if (error instanceof QueryCacheError) {
      return sealHistory({
        ...(previous ?? emptyExecutionHistoryCache()),
        detail: error.forbidden ? null : (previous?.detail ?? null),
        problem: error.problem,
        forbidden: error.forbidden,
        requestId: error.requestId,
        strippedKeys: previous?.strippedKeys ?? [],
      });
    }
    throw error;
  }
}

export async function loadExecutionContextCache(
  identity: DevIdentity,
  workflowId: string,
  executionId: string,
  versionId: string,
  previous: ExecutionContextCache | undefined,
  deps: {
    getVersion?: typeof getWorkflowVersion;
    fetchCatalog?: typeof fetchWorkflowCatalog;
    listApprovals?: typeof listExecutionApprovals;
  } = {},
): Promise<ExecutionContextCache> {
  const getVersion = deps.getVersion ?? getWorkflowVersion;
  const fetchCatalog = deps.fetchCatalog ?? fetchWorkflowCatalog;
  const listApprovals = deps.listApprovals ?? listExecutionApprovals;
  const [versionResult, catalogResult, approvalResult] = await Promise.all([
    getVersion(identity, workflowId, versionId),
    fetchCatalog(identity),
    listApprovals(identity, workflowId, executionId),
  ]);
  const next: ExecutionContextCache = {
    version: previous?.version ?? null,
    catalog: previous?.catalog ?? null,
    approvals: previous?.approvals ?? [],
    requestId: previous?.requestId ?? "",
    strippedKeys: [],
  };
  if (versionResult.ok) {
    next.version = versionResult.version;
    next.requestId = versionResult.requestId;
  }
  if (catalogResult.ok) {
    next.catalog = catalogResult.catalog;
    next.requestId = catalogResult.requestId;
  }
  if (approvalResult.ok) {
    next.approvals = approvalResult.items;
    next.requestId = approvalResult.requestId;
    next.strippedKeys.push(...approvalResult.strippedKeys);
  }
  return sealContext(next);
}

export async function loadExecutionLogsCache(
  identity: DevIdentity,
  executionId: string,
  stepIds: readonly string[],
  previous: ExecutionLogsCache | undefined,
  loadLogs: typeof getExecutionStepLogs = getExecutionStepLogs,
): Promise<ExecutionLogsCache> {
  const stepLogs: Record<string, ExecutionLogSlice> = {
    ...(previous?.stepLogs ?? {}),
  };
  const strippedKeys: string[] = [];
  await Promise.all(
    stepIds.map(async (stepId) => {
      const logs = await loadLogs(identity, executionId, stepId);
      if (logs.ok) {
        stepLogs[stepId] = logs.logs;
        strippedKeys.push(...logs.strippedKeys);
      }
    }),
  );
  const sanitized = sanitizeQueryCacheValue({ stepLogs, strippedKeys });
  return {
    ...sanitized.value,
    strippedKeys: uniqueStrings([
      ...strippedKeys,
      ...sanitized.strippedKeys,
    ]),
  };
}

async function fetchHistoryOnce(
  loadHistory: ExecutionHistoryLoader,
  identity: DevIdentity,
  executionId: string,
  workflowId: string | undefined,
  previous: ExecutionHistoryCache | undefined,
): Promise<ExecutionHistoryCache> {
  const result = await loadHistory(identity, executionId, workflowId);
  if (!result.ok) {
    if (isRetryableQueryStatus(result.statusCode)) {
      throw new QueryCacheError(result.problem);
    }
    return sealHistory({
      ...(previous ?? emptyExecutionHistoryCache()),
      detail: result.forbidden ? null : (previous?.detail ?? null),
      problem: cacheSafeProblem(result.problem),
      forbidden: result.forbidden,
      requestId: result.requestId,
      strippedKeys: previous?.strippedKeys ?? [],
    });
  }
  return sealHistory({
    ...(previous ?? emptyExecutionHistoryCache()),
    detail: result.execution,
    problem: null,
    forbidden: false,
    requestId: result.requestId,
    strippedKeys: result.strippedKeys,
  });
}

function defaultWorkspaceLoader(identity: DevIdentity) {
  return callIdentityProxy<CurrentWorkspace>(
    EXECUTION_DETAIL_WORKSPACE_PATH,
    identity,
  );
}

function sealHistory(cache: ExecutionHistoryCache): ExecutionHistoryCache {
  const sanitized = sanitizeQueryCacheValue(cache);
  return {
    ...sanitized.value,
    strippedKeys: uniqueStrings([
      ...cache.strippedKeys,
      ...sanitized.strippedKeys,
    ]),
  };
}

function sealContext(cache: ExecutionContextCache): ExecutionContextCache {
  const sanitized = sanitizeQueryCacheValue(cache);
  return {
    ...sanitized.value,
    strippedKeys: uniqueStrings([
      ...cache.strippedKeys,
      ...sanitized.strippedKeys,
    ]),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
