"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ConfigPinList } from "@/components/config/ConfigPinList";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { loadExecutionHistory } from "@/lib/execution-client";
import {
  IDEMPOTENCY_KEY_HELP,
  REDACTED_HELP,
} from "@/lib/execution-contract";
import {
  canSeeExecutionsNav,
  executionDetailDisplay,
  isExecutionForbidden,
  isIndeterminateStatus,
  redactedJson,
} from "@/lib/execution";
import type { ExecutionDetail as ExecutionDetailModel } from "@/lib/execution-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type ExecutionDetailProps = {
  executionId: string;
  workflowId?: string;
};

export function ExecutionDetail({
  executionId,
  workflowId,
}: ExecutionDetailProps) {
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

  const [detail, setDetail] = useState<ExecutionDetailModel | null>(null);
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
  const view = detail && !forbidden && !denied ? executionDetailDisplay(detail) : null;

  async function refresh() {
    setPending(true);
    setProblem(null);
    const [result, workspace] = await Promise.all([
      loadExecutionHistory(identity, executionId, workflowId),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
    ]);
    setLastRequestId(result.requestId);
    setPending(false);
    if (workspace.ok) {
      setPermissions(workspace.data.permissions ?? []);
    } else if (workspace.statusCode === 403 || workspace.statusCode === 401) {
      setPermissions([]);
    }
    if (!result.ok) {
      setProblem(result.problem);
      if (result.forbidden) {
        setDetail(null);
      }
      return;
    }
    setDetail(result.execution);
    setStrippedKeys(result.strippedKeys);
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
  }, [ready, identity, executionId, workflowId]);

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />

      <p>
        <Link
          href="/executions"
          className="text-sm text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Back to executions
        </Link>
      </p>

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and tenant + workbench before reading an
          execution.
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

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pending || !ready || denied}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Refresh"}
        </button>
      </div>

      {view ? (
        <>
          <section
            className={
              view.header.indeterminate
                ? "rounded-2xl border-2 border-amber-700 bg-amber-50 p-6 shadow-sm"
                : "rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{view.header.workflowLabel}</h2>
                <p className="mt-1 font-mono text-xs break-all text-zinc-600">
                  {view.header.id}
                </p>
              </div>
              <ExecutionStatusBadge status={view.header.status} />
            </div>
            {view.header.indeterminate ? (
              <p className="mt-3 text-sm text-amber-950">
                Indeterminate means a remote side effect may have occurred and
                was not verified. Do not assume the action did not run.
              </p>
            ) : null}
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Version pin</dt>
                <dd className="font-mono text-xs break-all">
                  {view.header.versionPin}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Correlation id</dt>
                <dd className="font-mono text-xs break-all">
                  {view.header.correlationId}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Started</dt>
                <dd className="font-mono text-xs">{view.header.startedAt}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Finished</dt>
                <dd className="font-mono text-xs">{view.header.finishedAt}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Idempotency key</dt>
                <dd className="font-mono text-xs break-all">
                  {view.header.idempotencyKey}
                </dd>
              </div>
            </dl>
            {view.replayedMessage ? (
              <p role="status" className="mt-4 text-sm text-zinc-800">
                {view.replayedMessage}
              </p>
            ) : view.header.idempotencyKey !== "—" ? (
              <p className="mt-4 text-sm text-zinc-600">{IDEMPOTENCY_KEY_HELP}</p>
            ) : null}
            <div className="mt-4">
              <p className="text-xs font-medium text-zinc-600">Config pins</p>
              <ConfigPinList
                pins={view.pins}
                empty="No ops-config pins on this execution."
              />
            </div>
            <div className="mt-4">
              <p className="text-xs font-medium text-zinc-600">
                Redacted input
              </p>
              <p className="mt-1 text-xs text-zinc-500">{REDACTED_HELP}</p>
              <pre className="mt-2 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
                {redactedJson(view.input)}
              </pre>
            </div>
            {detail?.workflowId ? (
              <p className="mt-4 text-sm">
                <Link
                  href="/workflows"
                  className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                >
                  Open workflow operator
                </Link>
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Steps</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Redacted step summary. Secret values show as{" "}
              <code className="font-mono text-xs">[redacted]</code>. Graph
              replay is E5.3 / E6.
            </p>
            {view.steps.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">
                No steps returned yet.
              </p>
            ) : (
              <ul className="mt-4 grid gap-3">
                {view.steps.map((step) => (
                  <li
                    key={step.id}
                    className={
                      isIndeterminateStatus(step.status)
                        ? "rounded-xl border-2 border-amber-700 bg-amber-50 p-4"
                        : "rounded-xl border border-zinc-200 p-4"
                    }
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{step.nodeId}</p>
                        <p className="font-mono text-xs text-zinc-600">
                          {step.nodeType || "node"} · attempt {step.attempt}
                        </p>
                      </div>
                      <ExecutionStatusBadge status={step.status} />
                    </div>
                    <pre className="mt-3 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
                      {redactedJson(step.output ?? step.error ?? step.input)}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Jobs</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Dispatch records. Lease and fencing fields are reserved for
              E5.2 — this UI does not claim jobs.
            </p>
            {view.jobs.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">No jobs returned.</p>
            ) : (
              <ul className="mt-4 grid gap-2">
                {view.jobs.map((job) => (
                  <li
                    key={job.id}
                    className="rounded-xl border border-zinc-200 px-4 py-3 text-sm"
                  >
                    <p className="font-medium">{job.status}</p>
                    <p className="font-mono text-xs break-all text-zinc-600">
                      {job.id}
                      {job.executionStepId ? ` · step ${job.executionStepId}` : ""}
                      {job.workerId ? ` · worker ${job.workerId}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Audit events</h2>
            <p className="mt-1 text-sm text-zinc-600">
              From{" "}
              <code className="font-mono text-xs">
                GET /executions/{"{id}"}/audit-events
              </code>{" "}
              or workspace{" "}
              <code className="font-mono text-xs">GET /audit-events</code>
              — not the E2.2 isolation stub. {REDACTED_HELP}
            </p>
            {view.auditEvents.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">No audit events returned.</p>
            ) : (
              <ul className="mt-4 grid gap-2">
                {view.auditEvents.map((event) => (
                  <li
                    key={event.id}
                    className="rounded-xl border border-zinc-200 px-4 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <p className="font-medium">{event.action}</p>
                      <p className="text-xs text-zinc-600">
                        {event.outcome || "—"}
                      </p>
                    </div>
                    <p className="mt-1 font-mono text-xs text-zinc-500">
                      {event.occurredAt || "—"}
                      {event.correlationId ? ` · ${event.correlationId}` : ""}
                    </p>
                    {event.details != null ? (
                      <pre className="mt-2 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
                        {redactedJson(event.details)}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
