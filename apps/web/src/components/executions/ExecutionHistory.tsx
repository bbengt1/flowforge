"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  listExecutions,
  listWorkflowExecutions,
} from "@/lib/execution-client";
import { IDEMPOTENCY_REPLAY_MESSAGE } from "@/lib/execution-contract";
import {
  canSeeExecutionsNav,
  documentedExecutionStatuses,
  executionListDisplay,
  isExecutionForbidden,
} from "@/lib/execution";
import type { ExecutionListQuery, ExecutionRecord } from "@/lib/execution-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { listWorkflows } from "@/lib/workflow-client";
import type { WorkflowRecord } from "@/lib/workflow-types";

const DEFAULT_LIMIT = 50;

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

  const [items, setItems] = useState<ExecutionRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [query, setQuery] = useState<ExecutionListQuery>({
    workflowId: "",
    status: "",
    limit: DEFAULT_LIMIT,
  });
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[] | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  const denied = ready && permissions != null && !canSeeExecutionsNav(permissions);
  const forbidden = isExecutionForbidden(problem);
  const visible = useMemo(
    () => (forbidden || denied ? [] : executionListDisplay(items)),
    [items, forbidden, denied],
  );
  const perWorkflow = Boolean(query.workflowId?.trim());

  async function refresh() {
    setPending(true);
    setProblem(null);
    const filter = {
      status: query.status,
      limit: query.limit || DEFAULT_LIMIT,
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
      <IsolationIdentityPanel />

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and tenant + workbench before listing
          executions.
        </p>
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

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {perWorkflow ? "Workflow executions" : "Workspace executions"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600">
              {perWorkflow ? (
                <>
                  <code className="font-mono text-xs">
                    GET /workflows/{"{id}"}/executions
                  </code>
                </>
              ) : (
                <>
                  <code className="font-mono text-xs">GET /executions</code>
                </>
              )}{" "}
              · query <code className="font-mono text-xs">status</code>,{" "}
              <code className="font-mono text-xs">limit</code>
              {perWorkflow ? null : (
                <>
                  . Pick a workflow to use the per-workflow list.
                </>
              )}{" "}
              Cards show safe metadata only. Secrets appear as{" "}
              <code className="font-mono text-xs">[redacted]</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending || !ready || denied}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending ? "Loading…" : "Refresh"}
          </button>
        </div>

        <form
          className="mt-5 grid gap-3 sm:grid-cols-3"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="text-sm">
            <span className="font-medium">Workflow</span>
            <select
              value={query.workflowId ?? ""}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  workflowId: event.target.value,
                }))
              }
              disabled={denied}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">Workspace (all)</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name || workflow.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium">Status</span>
            <select
              value={query.status ?? ""}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  status: event.target.value,
                }))
              }
              disabled={denied}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">Any</option>
              {documentedExecutionStatuses().map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium">Limit</span>
            <select
              value={String(query.limit ?? DEFAULT_LIMIT)}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  limit: Number(event.target.value),
                }))
              }
              disabled={denied}
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            >
              {[10, 25, 50, 100].map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
          </label>
        </form>
      </section>

      {forbidden || denied ? null : visible.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center">
          <h2 className="text-lg font-semibold">No executions yet</h2>
          <p className="mt-2 text-sm text-zinc-600">
            Start a published version from the workflow operator. Duplicate
            idempotency keys replay the existing run (
            <code className="font-mono text-xs">200</code>). Same key +
            different input is <code className="font-mono text-xs">409</code>.
          </p>
          <p className="mt-4">
            <Link
              href="/workflows"
              className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            >
              Open workflow run control
            </Link>
          </p>
        </section>
      ) : (
        <ul className="grid gap-3">
          {visible.map((row) => (
            <li
              key={row.id}
              className={
                row.indeterminate
                  ? "rounded-xl border-2 border-amber-700 bg-amber-50 p-4 shadow-sm"
                  : "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">
                    <Link
                      href={row.href}
                      className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                    >
                      {row.workflowLabel}
                    </Link>
                  </h3>
                  <p className="mt-1 font-mono text-xs break-all text-zinc-600">
                    {row.id}
                  </p>
                </div>
                <ExecutionStatusBadge status={row.status} />
              </div>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Version pin</dt>
                  <dd className="font-mono text-xs">{row.versionPin}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Correlation id</dt>
                  <dd className="font-mono text-xs break-all">
                    {row.correlationId}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Started</dt>
                  <dd className="font-mono text-xs">{row.startedAt}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Finished</dt>
                  <dd className="font-mono text-xs">{row.finishedAt}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-zinc-500">Idempotency key</dt>
                  <dd className="font-mono text-xs break-all">
                    {row.idempotencyKey}
                  </dd>
                </div>
              </dl>
              {row.replayed ? (
                <p className="mt-3 text-sm text-zinc-700">
                  {IDEMPOTENCY_REPLAY_MESSAGE}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
