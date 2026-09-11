"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ExecutionCompare } from "@/components/executions/ExecutionCompare";
import { ExecutionHistoryListbox } from "@/components/executions/ExecutionHistoryListbox";
import { ExecutionOperateActions } from "@/components/executions/ExecutionOperateActions";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  listExecutions,
  listWorkflowExecutions,
  loadExecutionHistory,
} from "@/lib/execution-client";
import {
  canSeeExecutionsNav,
  documentedExecutionStatuses,
  executionListDisplay,
  isExecutionForbidden,
} from "@/lib/execution";
import {
  EXECUTION_INBOX_DEFAULT_LIMIT,
  EXECUTION_INBOX_HELP,
  EXECUTION_INBOX_LIMITS,
  executionInboxHasActiveFilters,
  executionInboxHref,
  parseExecutionInboxQuery,
} from "@/lib/execution-inbox";
import { compareRedactedExecutions } from "@/lib/execution-replay";
import { executionOperateShouldLoadDetail } from "@/lib/execution-operate";
import type {
  ExecutionDetail,
  ExecutionListQuery,
  ExecutionRecord,
} from "@/lib/execution-types";
import { ManualStartPanel } from "@/components/workflows/ManualStartPanel";
import { canOfferManualStart } from "@/lib/manual-start-contract";
import { compareWorkflow } from "@/lib/workflow-client";
import { versionCompareRef } from "@/lib/workflow";
import type { CompareWorkflowResult } from "@/lib/workflow-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { listWorkflows } from "@/lib/workflow-client";
import type { WorkflowRecord } from "@/lib/workflow-types";

export function ExecutionHistory() {
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const headerFallback = useSyncExternalStore(
    subscribeHeaderFallback,
    loadHeaderFallback,
    () => false,
  );
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const embed = pathname.startsWith("/embed/v1");
  const query = useMemo(
    () => parseExecutionInboxQuery(searchParams.toString()),
    [searchParams],
  );

  const [items, setItems] = useState<ExecutionRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [compareLeftId, setCompareLeftId] = useState("");
  const [compareRightId, setCompareRightId] = useState("");
  const [compareResult, setCompareResult] = useState<ReturnType<
    typeof compareRedactedExecutions
  > | null>(null);
  const [versionCompare, setVersionCompare] =
    useState<CompareWorkflowResult | null>(null);
  const [startWorkflowId, setStartWorkflowId] = useState("");
  const [operateDetails, setOperateDetails] = useState<
    Record<string, ExecutionDetail>
  >({});

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  const denied = ready && permissions != null && !canSeeExecutionsNav(permissions);
  const canExecute = canOfferManualStart(permissions);
  const publishedWorkflows = workflows.filter((item) => item.latestVersionId);
  const forbidden = isExecutionForbidden(problem);
  const visible = useMemo(
    () => (forbidden || denied ? [] : executionListDisplay(items)),
    [items, forbidden, denied],
  );
  const perWorkflow = Boolean(query.workflowId?.trim());
  const filtersActive = executionInboxHasActiveFilters(query);

  function replaceQuery(next: ExecutionListQuery) {
    router.replace(executionInboxHref(next, embed), { scroll: false });
  }

  async function refresh() {
    setPending(true);
    setProblem(null);
    const filter = {
      status: query.status,
      limit: query.limit || EXECUTION_INBOX_DEFAULT_LIMIT,
    };
    const [list, workspace, workflowList] = await Promise.all([
      query.workflowId?.trim()
        ? listWorkflowExecutions(identity, query.workflowId.trim(), filter)
        : listExecutions(identity, filter),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
      listWorkflows(identity),
    ]);
    setLastRequestId(list.requestId);
    setPending(false);
    if (workspace.ok) {
      setPermissions(workspace.data.permissions ?? []);
    } else if (workspace.statusCode === 403 || workspace.statusCode === 401) {
      setPermissions([]);
    }
    if (workflowList.ok) {
      setWorkflows(workflowList.items);
    }
    if (!list.ok) {
      setProblem(list.problem);
      if (list.forbidden) {
        setItems([]);
      }
      return;
    }
    setItems(list.items);
    setStrippedKeys(list.strippedKeys);
    void loadOperateDetails(list.items);
  }

  async function loadOperateDetails(rows: readonly ExecutionRecord[]) {
    const needed = rows.filter(executionOperateShouldLoadDetail);
    if (needed.length === 0) {
      return;
    }
    const results = await Promise.all(
      needed.map((row) =>
        loadExecutionHistory(identity, row.id, row.workflowId),
      ),
    );
    setOperateDetails((current) => {
      const next = { ...current };
      for (const result of results) {
        if (result.ok) {
          next[result.execution.id] = result.execution;
        }
      }
      return next;
    });
  }

  useEffect(() => {
    if (!ready) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [ready, identity, query.workflowId, query.status, query.limit]);

  return (
    <div className="space-y-6">
      {!ready ? (
        <SessionSetupHint purpose="before listing executions." />
      ) : null}

      {denied ? (
        <p className="text-sm text-zinc-600">
          This role cannot view executions (
          <code className="font-mono text-xs">execution.view</code> missing).
        </p>
      ) : null}

      {problem ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}
      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {perWorkflow ? "Workflow runs" : "Workspace runs"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-zinc-600">
              {EXECUTION_INBOX_HELP}{" "}
              {perWorkflow ? (
                <>
                  This filter uses{" "}
                  <code className="font-mono text-xs">
                    GET /workflows/{"{id}"}/executions
                  </code>
                  .
                </>
              ) : (
                <>
                  Workspace list is{" "}
                  <code className="font-mono text-xs">GET /executions</code>.
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {filtersActive ? (
              <button
                type="button"
                onClick={() => replaceQuery({ limit: EXECUTION_INBOX_DEFAULT_LIMIT })}
                disabled={denied}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                Clear filters
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending || !ready || denied}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
            >
              {pending ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <p className="text-sm font-medium">Status</p>
            <div
              role="group"
              aria-label="Status"
              className="mt-2 flex flex-wrap gap-2"
            >
              <StatusChip
                label="Any"
                active={!query.status}
                disabled={denied}
                onClick={() =>
                  replaceQuery({
                    ...query,
                    status: "",
                  })
                }
              />
              {documentedExecutionStatuses().map((status) => (
                <StatusChip
                  key={status}
                  label={status}
                  active={query.status === status}
                  disabled={denied}
                  onClick={() =>
                    replaceQuery({
                      ...query,
                      status,
                    })
                  }
                />
              ))}
            </div>
          </div>

          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => event.preventDefault()}
          >
            <label className="text-sm">
              <span className="font-medium">Workflow</span>
              <select
                value={query.workflowId ?? ""}
                onChange={(event) =>
                  replaceQuery({
                    ...query,
                    workflowId: event.target.value,
                  })
                }
                disabled={denied}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">Workspace (all)</option>
                {query.workflowId &&
                !workflows.some((workflow) => workflow.id === query.workflowId) ? (
                  <option value={query.workflowId}>{query.workflowId}</option>
                ) : null}
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name || workflow.slug}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="font-medium">Limit</span>
              <select
                value={String(query.limit ?? EXECUTION_INBOX_DEFAULT_LIMIT)}
                onChange={(event) =>
                  replaceQuery({
                    ...query,
                    limit: Number(event.target.value),
                  })
                }
                disabled={denied}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                {EXECUTION_INBOX_LIMITS.map((limit) => (
                  <option key={limit} value={limit}>
                    {limit}
                  </option>
                ))}
              </select>
            </label>
          </form>
          <p className="text-sm text-zinc-500" aria-live="polite">
            {pending
              ? "Loading runs…"
              : `${visible.length} run${visible.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </section>

      {forbidden || denied ? null : visible.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center">
          <h2 className="text-lg font-semibold">
            {filtersActive ? "No runs match these filters" : "No executions yet"}
          </h2>
          <p className="mt-2 text-sm text-zinc-600">
            Start a published version from workflow home or the panel below.
            Duplicate idempotency keys replay the existing run (
            <code className="font-mono text-xs">200</code>). Same key +
            different input is <code className="font-mono text-xs">409</code>.
            Drafts never run.
          </p>
          <p className="mt-4 flex flex-wrap justify-center gap-4">
            {filtersActive ? (
              <button
                type="button"
                onClick={() => replaceQuery({ limit: EXECUTION_INBOX_DEFAULT_LIMIT })}
                className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
              >
                Clear filters
              </button>
            ) : null}
            <Link
              href="/workflows?start=1"
              className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            >
              Open authenticated manual start
            </Link>
          </p>
        </section>
      ) : (
        <ExecutionHistoryListbox
          rows={visible}
          layout="inbox"
          operateActions={(row) => (
            <ExecutionOperateActions
              identity={identity}
              executionId={row.id}
              workflowId={
                items.find((item) => item.id === row.id)?.workflowId ??
                query.workflowId
              }
              status={row.status}
              permissions={permissions}
              detail={operateDetails[row.id]}
              surface="inbox"
              onOperated={() => void refresh()}
            />
          )}
        />
      )}

      {!forbidden && !denied && publishedWorkflows.length > 0 ? (
        <details className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold">
            Start a published version
          </summary>
          <p className="mt-2 text-sm text-zinc-600">
            Authenticated manual start from the inbox. Drafts never run.
          </p>
          <label className="mt-3 block text-sm">
            <span className="text-zinc-600">Workflow</span>
            <select
              value={startWorkflowId}
              onChange={(event) => setStartWorkflowId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
            >
              <option value="">Select a published workflow</option>
              {publishedWorkflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name || workflow.slug}
                </option>
              ))}
            </select>
          </label>
          {startWorkflowId && canExecute ? (
            <div className="mt-4">
              <ManualStartPanel
                identity={identity}
                workflowId={startWorkflowId}
                workflowName={
                  publishedWorkflows.find((item) => item.id === startWorkflowId)
                    ?.name
                }
                permissions={permissions}
                onClose={() => setStartWorkflowId("")}
              />
            </div>
          ) : startWorkflowId && !canExecute ? (
            <p className="mt-3 text-sm font-medium text-rose-950">
              Start requires workflow.execute. This surface is fail-closed.
            </p>
          ) : null}
        </details>
      ) : null}

      {forbidden || denied ? null : visible.length > 1 ? (
        <details className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold">
            Compare executions
          </summary>
          <p className="mt-2 text-sm text-zinc-600">
            Two redacted summaries. YAML compare uses the existing workflow
            compare route when both pins share a workflow. No invented compare
            route.
          </p>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                const [left, right] = await Promise.all([
                  loadExecutionHistory(identity, compareLeftId),
                  loadExecutionHistory(identity, compareRightId),
                ]);
                if (!left.ok) {
                  setProblem(left.problem);
                  return;
                }
                if (!right.ok) {
                  setProblem(right.problem);
                  return;
                }
                setCompareResult(
                  compareRedactedExecutions(left.execution, right.execution),
                );
                const leftRef = versionCompareRef(left.execution.workflowVersionId);
                const rightRef = versionCompareRef(
                  right.execution.workflowVersionId,
                );
                if (
                  left.execution.workflowId &&
                  left.execution.workflowId === right.execution.workflowId &&
                  leftRef &&
                  rightRef
                ) {
                  const yaml = await compareWorkflow(
                    identity,
                    left.execution.workflowId,
                    { left: leftRef, right: rightRef },
                  );
                  setVersionCompare(yaml.ok ? yaml.compare : null);
                } else {
                  setVersionCompare(null);
                }
              })();
            }}
          >
            <label className="text-sm">
              <span className="font-medium">Left</span>
              <select
                value={compareLeftId}
                onChange={(event) => setCompareLeftId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">Select an execution</option>
                {visible.map((row) => (
                  <option key={`left-${row.id}`} value={row.id}>
                    {row.workflowLabel} · {row.status}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="font-medium">Right</span>
              <select
                value={compareRightId}
                onChange={(event) => setCompareRightId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">Select an execution</option>
                {visible.map((row) => (
                  <option key={`right-${row.id}`} value={row.id}>
                    {row.workflowLabel} · {row.status}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={!compareLeftId || !compareRightId}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                Compare
              </button>
            </div>
          </form>
          <div className="mt-4">
            <ExecutionCompare result={compareResult} versionCompare={versionCompare} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function StatusChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={
        active
          ? "rounded-full border border-teal-800 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-950 disabled:opacity-60"
          : "rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      }
    >
      {label}
    </button>
  );
}
