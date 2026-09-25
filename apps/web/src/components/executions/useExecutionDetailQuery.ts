"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { ApprovalRequest } from "@/lib/approval-types";
import {
  canSeeExecutionsNav,
  executionDetailDisplay,
  normalizeExecutionStatus,
} from "@/lib/execution";
import { pollExecutionStatus } from "@/lib/execution-client";
import {
  emptyExecutionHistoryCache,
  EXECUTION_SERVER_QUERY_OPTIONS,
  forbiddenPollCache,
  loadExecutionContextCache,
  loadExecutionHistoryCache,
  loadExecutionLogsCache,
  loadWorkspacePermissionsCache,
  mergePolledExecution,
  patchExecutionApprovals,
  withExecutionDetail,
  type ExecutionContextCache,
  type ExecutionHistoryCache,
  type ExecutionLogsCache,
} from "@/lib/execution-detail-query";
import { startExecutionStatusPoll } from "@/lib/execution-poll";
import type { ExecutionDetail, ExecutionLogSlice } from "@/lib/execution-types";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  BLOCKED_QUERY_KEY,
  cacheSafeProblem,
  CancelledError,
  executionContextQueryKey,
  executionHistoryQueryKey,
  executionLogsQueryKey,
  tryQueryScope,
  workspacePermissionsQueryKey,
} from "@/lib/query-cache";
import { createGenerationGate } from "@/lib/request-generation";
import type { WorkflowCatalog, WorkflowVersion } from "@/lib/workflow-types";

type UseExecutionDetailQueryInput = {
  identity: DevIdentity;
  executionId: string;
  workflowId?: string;
  ready: boolean;
};

export type ExecutionDetailServerState = {
  detail: ExecutionDetail | null;
  problem: ProblemDetails | null;
  pending: boolean;
  lastRequestId: string | null;
  strippedKeys: string[];
  permissions: string[] | null;
  actorUserId: string;
  stepLogs: Record<string, ExecutionLogSlice>;
  approvals: ApprovalRequest[];
  version: WorkflowVersion | null;
  catalog: WorkflowCatalog | null;
  denied: boolean;
  refresh: () => Promise<void>;
  reportProblem: (problem: ProblemDetails | null) => void;
  noteRequestId: (requestId: string) => void;
  replaceDetail: (execution: ExecutionDetail, strippedKeys: string[]) => void;
  patchApprovals: (
    updater: (current: ApprovalRequest[]) => ApprovalRequest[],
  ) => void;
};

export function useExecutionDetailQuery({
  identity,
  executionId,
  workflowId,
  ready,
}: UseExecutionDetailQueryInput): ExecutionDetailServerState {
  const queryClient = useQueryClient();
  const requestGate = useRef(createGenerationGate());
  const scope = tryQueryScope(identity);
  const historyKey = useMemo(
    () =>
      scope == null
        ? BLOCKED_QUERY_KEY
        : (executionHistoryQueryKey(scope, executionId, workflowId) ??
          BLOCKED_QUERY_KEY),
    [executionId, scope, workflowId],
  );
  const workspaceKey = useMemo(
    () =>
      scope == null
        ? BLOCKED_QUERY_KEY
        : (workspacePermissionsQueryKey(scope) ?? BLOCKED_QUERY_KEY),
    [scope],
  );
  const enabled =
    ready && scope != null && historyKey !== BLOCKED_QUERY_KEY;

  const workspaceQuery = useQuery({
    queryKey: workspaceKey,
    enabled,
    ...EXECUTION_SERVER_QUERY_OPTIONS,
    queryFn: () => loadWorkspacePermissionsCache(identity),
  });

  const historyQuery = useQuery({
    queryKey: historyKey,
    enabled,
    ...EXECUTION_SERVER_QUERY_OPTIONS,
    retry: false,
    queryFn: async ({ client, queryKey }) => {
      const token = requestGate.current.begin();
      const previous = client.getQueryData<ExecutionHistoryCache>(queryKey);
      const data = await loadExecutionHistoryCache(
        identity,
        executionId,
        workflowId,
        previous,
      );
      if (!requestGate.current.isCurrent(token)) {
        throw new CancelledError({ revert: true });
      }
      return data;
    },
  });

  const history = historyQuery.data;
  const permissions = workspaceQuery.data
    ? workspaceQuery.data.permissions
    : null;
  const denied =
    ready && permissions != null && !canSeeExecutionsNav(permissions);
  const detail = history?.forbidden ? null : (history?.detail ?? null);
  const display =
    detail && !denied ? executionDetailDisplay(detail) : null;
  // Run poll only. Step `pending` and job `blocked` are not run statuses.
  // `skipped` is terminal and does not keep the poll alive.
  const live =
    normalizeExecutionStatus(display?.header.status) === "queued" ||
    normalizeExecutionStatus(display?.header.status) === "running";

  const pinWorkflowId = detail?.workflowId || workflowId || "";
  const versionId = detail?.workflowVersionId ?? "";
  const stepKey = (detail?.steps ?? [])
    .map((step) => step.id)
    .sort()
    .join(",");
  const contextBuilt =
    scope == null
      ? null
      : executionContextQueryKey(scope, executionId, pinWorkflowId, versionId);
  const logsBuilt =
    scope == null
      ? null
      : executionLogsQueryKey(
          scope,
          executionId,
          stepKey ? stepKey.split(",") : [],
        );
  const contextKey = contextBuilt ?? BLOCKED_QUERY_KEY;
  const logsKey = logsBuilt ?? BLOCKED_QUERY_KEY;
  const contextEnabled = Boolean(
    enabled && detail && pinWorkflowId && versionId && contextBuilt,
  );
  const logsEnabled = Boolean(enabled && detail && stepKey && logsBuilt);

  const contextQuery = useQuery({
    queryKey: contextKey,
    enabled: contextEnabled,
    ...EXECUTION_SERVER_QUERY_OPTIONS,
    retry: false,
    queryFn: ({ client, queryKey }) =>
      loadExecutionContextCache(
        identity,
        pinWorkflowId,
        executionId,
        versionId,
        client.getQueryData<ExecutionContextCache>(queryKey),
      ),
  });

  const logsQuery = useQuery({
    queryKey: logsKey,
    enabled: logsEnabled,
    ...EXECUTION_SERVER_QUERY_OPTIONS,
    retry: false,
    queryFn: ({ client, queryKey }) =>
      loadExecutionLogsCache(
        identity,
        executionId,
        stepKey ? stepKey.split(",") : [],
        client.getQueryData<ExecutionLogsCache>(queryKey),
      ),
  });

  useEffect(() => {
    const gate = requestGate.current;
    if (!enabled || denied || !live) {
      return;
    }
    const loop = startExecutionStatusPoll({
      async tick() {
        const token = gate.begin();
        const result = await pollExecutionStatus(
          identity,
          executionId,
          workflowId,
        );
        if (!gate.isCurrent(token)) {
          return true;
        }
        if (!result.ok) {
          if (result.forbidden) {
            queryClient.setQueryData<ExecutionHistoryCache>(
              historyKey,
              (current) => forbiddenPollCache(current, result),
            );
          }
          return false;
        }
        queryClient.setQueryData<ExecutionHistoryCache>(historyKey, (current) =>
          mergePolledExecution(current, {
            execution: result.execution,
            strippedKeys: result.strippedKeys,
            requestId: result.requestId,
          }),
        );
        return true;
      },
    });
    return () => {
      gate.begin();
      loop.stop();
    };
  }, [
    denied,
    enabled,
    executionId,
    historyKey,
    identity,
    live,
    queryClient,
    workflowId,
  ]);

  const context = contextQuery.data;
  const logs = logsQuery.data;
  const strippedKeys = useMemo(
    () =>
      uniqueStrings([
        ...(history?.strippedKeys ?? []),
        ...(context?.strippedKeys ?? []),
        ...(logs?.strippedKeys ?? []),
      ]),
    [context?.strippedKeys, history?.strippedKeys, logs?.strippedKeys],
  );

  function writeHistory(
    updater: (
      current: ExecutionHistoryCache | undefined,
    ) => ExecutionHistoryCache | undefined,
  ) {
    queryClient.setQueryData<ExecutionHistoryCache>(historyKey, (current) =>
      updater(current),
    );
  }

  async function refresh() {
    requestGate.current.begin();
    writeHistory((current) =>
      current ? { ...current, problem: null } : undefined,
    );
    await Promise.all([
      queryClient.refetchQueries({ queryKey: workspaceKey }),
      queryClient.refetchQueries({ queryKey: historyKey }),
    ]);
    await Promise.all([
      queryClient.refetchQueries({ queryKey: contextKey }),
      queryClient.refetchQueries({ queryKey: logsKey }),
    ]);
  }

  function reportProblem(problem: ProblemDetails | null) {
    writeHistory((current) => ({
      ...(current ?? emptyExecutionHistoryCache()),
      problem: problem ? cacheSafeProblem(problem) : null,
    }));
  }

  function noteRequestId(requestId: string) {
    writeHistory((current) => ({
      ...(current ?? emptyExecutionHistoryCache()),
      requestId,
    }));
  }

  function replaceDetail(execution: ExecutionDetail, nextStripped: string[]) {
    writeHistory((current) =>
      withExecutionDetail(current, execution, nextStripped),
    );
  }

  function patchApprovals(
    updater: (current: ApprovalRequest[]) => ApprovalRequest[],
  ) {
    queryClient.setQueryData<ExecutionContextCache>(contextKey, (current) =>
      patchExecutionApprovals(current, updater),
    );
  }

  const loadProblem = history?.problem ?? null;
  const fetchProblem =
    historyQuery.error == null
      ? null
      : problemFromQueryError(historyQuery.error);

  return {
    detail,
    problem: loadProblem ?? fetchProblem,
    pending:
      enabled &&
      (workspaceQuery.isFetching ||
        historyQuery.isFetching ||
        !workspaceQuery.isFetched ||
        !historyQuery.isFetched),
    lastRequestId: history?.requestId ? history.requestId : null,
    strippedKeys,
    permissions,
    actorUserId: workspaceQuery.data?.actorUserId ?? "",
    stepLogs: logs?.stepLogs ?? {},
    approvals: context?.approvals ?? [],
    version: context?.version ?? null,
    catalog: context?.catalog ?? null,
    denied,
    refresh,
    reportProblem,
    noteRequestId,
    replaceDetail,
    patchApprovals,
  };
}

function problemFromQueryError(error: unknown): ProblemDetails | null {
  if (error instanceof CancelledError) {
    return null;
  }
  return {
    type: "urn:flowforge:problem:query",
    title: "Could not load execution",
    status: 503,
    detail: "The execution could not be loaded.",
    instance: "execution-detail",
    code: "query-failed",
    request_id: "",
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
