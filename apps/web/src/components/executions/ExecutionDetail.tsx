"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConfigPinList } from "@/components/config/ConfigPinList";
import { ExecutionArtifacts } from "@/components/executions/ExecutionArtifacts";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  cancelExecution,
  downloadExecutionArtifact,
  getExecutionStepLogs,
  loadExecutionHistory,
  pollExecutionStatus,
  retryExecution,
  retryExecutionStep,
} from "@/lib/execution-client";
import {
  BOUNDED_LOG_HELP,
  CANCEL_CSRF_HELP,
  CANCEL_FORBIDDEN_MESSAGE,
  EXECUTION_STATUS_POLL_MS,
  IDEMPOTENCY_KEY_HELP,
  INDETERMINATE_STATUS_HELP,
  REDACTED_HELP,
  RETENTION_HELP,
  RETRY_CONFLICT_MESSAGE,
  RETRY_CSRF_HELP,
  RETRY_FORBIDDEN_MESSAGE,
  RETRY_INDETERMINATE_MESSAGE,
  STATUS_POLL_HELP,
} from "@/lib/execution-contract";
import {
  boundRedactedDisplay,
  canCancelExecution,
  canRetryExecution,
  canRetryExecutionStep,
  canSeeExecutionsNav,
  downloadGrantFailureMessage,
  executionDetailDisplay,
  isExecutionForbidden,
  isIndeterminateStatus,
  normalizeExecutionStatus,
  retentionStatusMessage,
  retryAffordanceMessage,
} from "@/lib/execution";
import type { ExecutionLogSlice } from "@/lib/execution-types";
import { EXECUTION_CANCEL_PERMISSION } from "@/lib/execution-types";
import type { ExecutionDetail as ExecutionDetailModel } from "@/lib/execution-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { createGenerationGate } from "@/lib/request-generation";
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
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [retryPending, setRetryPending] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [stepLogs, setStepLogs] = useState<Record<string, ExecutionLogSlice>>(
    {},
  );
  const requestGate = useRef(createGenerationGate());

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const denied = ready && permissions != null && !canSeeExecutionsNav(permissions);
  const forbidden = isExecutionForbidden(problem);
  const view = detail && !forbidden && !denied ? executionDetailDisplay(detail) : null;
  const canCancel =
    Boolean(view) &&
    canCancelExecution({
      permissions,
      status: view?.header.status,
      permittedActions: view?.permittedActions,
    });
  const showRetry = canRetryExecution({
    permissions,
    permittedActions: view?.permittedActions,
    status: view?.header.status,
    steps: view?.steps,
  });
  const indeterminate = Boolean(view?.header.indeterminate);
  const live =
    normalizeExecutionStatus(view?.header.status) === "queued" ||
    normalizeExecutionStatus(view?.header.status) === "running";

  async function refresh() {
    const token = requestGate.current.begin();
    setPending(true);
    setProblem(null);
    const [result, workspace] = await Promise.all([
      loadExecutionHistory(identity, executionId, workflowId),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
    ]);
    if (!requestGate.current.isCurrent(token)) {
      return;
    }
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
    void loadStepLogs(result.execution.steps.map((step) => step.id));
  }

  async function loadStepLogs(stepIds: string[]) {
    const next: Record<string, ExecutionLogSlice> = {};
    await Promise.all(
      stepIds.map(async (stepId) => {
        const logs = await getExecutionStepLogs(identity, executionId, stepId);
        if (logs.ok) {
          next[stepId] = logs.logs;
        }
      }),
    );
    if (Object.keys(next).length > 0) {
      setStepLogs((current) => ({ ...current, ...next }));
    }
  }

  async function onCancel() {
    if (!canCancel || cancelPending) {
      return;
    }
    setCancelPending(true);
    setProblem(null);
    setCancelMessage(null);
    const result = await cancelExecution(identity, executionId, {
      workflowId: workflowId || detail?.workflowId,
      previousStatus: detail?.status,
    });
    setLastRequestId(result.requestId);
    setCancelPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      if (result.forbidden && result.problem.code === "forbidden") {
        setCancelMessage(CANCEL_FORBIDDEN_MESSAGE);
      }
      return;
    }
    setCancelMessage(result.message);
    if (result.execution) {
      setDetail(result.execution);
      setStrippedKeys(result.strippedKeys);
    }
    await refresh();
  }

  async function onRetry(stepId?: string) {
    if (indeterminate || retryPending) {
      return;
    }
    if (stepId) {
      if (
        !canRetryExecutionStep({
          permissions,
          permittedActions: view?.permittedActions,
          executionStatus: view?.header.status,
          stepStatus: view?.steps.find((step) => step.id === stepId)?.status,
          nodeType: view?.steps.find((step) => step.id === stepId)?.nodeType,
        })
      ) {
        return;
      }
    } else if (!showRetry) {
      return;
    }
    setRetryPending(stepId ?? "execution");
    setProblem(null);
    setRetryMessage(null);
    const result = stepId
      ? await retryExecutionStep(identity, executionId, stepId)
      : await retryExecution(identity, executionId, {
          workflowId: workflowId || detail?.workflowId,
        });
    setLastRequestId(result.requestId);
    setRetryPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      if (result.forbidden) {
        setRetryMessage(RETRY_FORBIDDEN_MESSAGE);
      } else if (result.statusCode === 409) {
        setRetryMessage(RETRY_CONFLICT_MESSAGE);
      }
      return;
    }
    setRetryMessage(result.message);
    if (result.execution) {
      setDetail(result.execution);
      setStrippedKeys(result.strippedKeys);
    }
    await refresh();
  }

  async function onDownload(artifactId: string) {
    if (downloadPending) {
      return;
    }
    const artifact = detail?.artifacts.find((item) => item.id === artifactId);
    setDownloadPending(artifactId);
    setProblem(null);
    setDownloadMessage(null);
    const result = await downloadExecutionArtifact(
      identity,
      executionId,
      artifactId,
      {
        artifact,
        open: (url) => {
          const link = document.createElement("a");
          link.href = url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          link.click();
        },
      },
    );
    setLastRequestId(result.requestId);
    setDownloadPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      setDownloadMessage(
        downloadGrantFailureMessage({
          forbidden: result.forbidden,
          expired: result.statusCode === 410,
          statusCode: result.statusCode,
        }),
      );
      return;
    }
    setDownloadMessage(result.message);
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

  useEffect(() => {
    const gate = requestGate.current;
    if (!ready || denied || !live) {
      return;
    }
    const timer = window.setInterval(() => {
      const token = gate.begin();
      void pollExecutionStatus(identity, executionId, workflowId).then(
        (result) => {
          if (!gate.isCurrent(token)) {
            return;
          }
          setLastRequestId(result.requestId);
          if (!result.ok) {
            if (result.forbidden) {
              setProblem(result.problem);
              setDetail(null);
            }
            return;
          }
          setDetail((current) => {
            if (!current) {
              return result.execution;
            }
            return {
              ...result.execution,
              auditEvents:
                result.execution.auditEvents.length > 0
                  ? result.execution.auditEvents
                  : current.auditEvents,
              artifacts:
                result.execution.artifacts.length > 0
                  ? result.execution.artifacts
                  : current.artifacts,
            };
          });
          setStrippedKeys(result.strippedKeys);
        },
      );
    }, EXECUTION_STATUS_POLL_MS);
    return () => {
      gate.begin();
      window.clearInterval(timer);
    };
  }, [ready, denied, live, identity, executionId, workflowId]);

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
                {INDETERMINATE_STATUS_HELP}
              </p>
            ) : null}
            {view.legalHold ? (
              <p role="status" className="mt-3 text-sm font-medium text-amber-950">
                {retentionStatusMessage({
                  retentionUntil: view.retentionUntil,
                  legalHold: true,
                })}
              </p>
            ) : view.retentionUntil ? (
              <p className="mt-3 text-sm text-zinc-600">
                {retentionStatusMessage({
                  retentionUntil: view.retentionUntil,
                })}
              </p>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">{RETENTION_HELP}</p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {canCancel ? (
                <button
                  type="button"
                  onClick={() => void onCancel()}
                  disabled={cancelPending || pending}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
                >
                  {cancelPending ? "Canceling…" : "Cancel execution"}
                </button>
              ) : permissions != null &&
                !permissions.includes(EXECUTION_CANCEL_PERMISSION) ? (
                <p className="text-sm text-zinc-600">
                  Cancel requires{" "}
                  <code className="font-mono text-xs">
                    {EXECUTION_CANCEL_PERMISSION}
                  </code>
                  . This action is separately authorized.
                </p>
              ) : null}
              {showRetry ? (
                <button
                  type="button"
                  onClick={() => void onRetry()}
                  disabled={Boolean(retryPending) || pending || cancelPending}
                  className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
                >
                  {retryPending === "execution" ? "Retrying…" : "Retry execution"}
                </button>
              ) : indeterminate ? (
                <p className="text-sm font-medium text-amber-950">
                  {RETRY_INDETERMINATE_MESSAGE}
                </p>
              ) : (
                <p className="text-xs text-zinc-500">
                  {retryAffordanceMessage(view.header.status)}
                </p>
              )}
            </div>
            <p className="mt-2 text-xs text-zinc-500">{CANCEL_CSRF_HELP}</p>
            <p className="mt-1 text-xs text-zinc-500">{RETRY_CSRF_HELP}</p>
            <p className="mt-1 text-xs text-zinc-500">{STATUS_POLL_HELP}</p>
            {cancelMessage ? (
              <p role="status" className="mt-3 text-sm text-zinc-800">
                {cancelMessage}
              </p>
            ) : null}
            {retryMessage ? (
              <p role="status" className="mt-3 text-sm text-zinc-800">
                {retryMessage}
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
                {boundRedactedDisplay(view.input).text}
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
              Redacted step state with bounded logs and output. Secret
              values show as{" "}
              <code className="font-mono text-xs">[redacted]</code>. Graph
              replay stays E6.
            </p>
            <p className="mt-1 text-xs text-zinc-500">{BOUNDED_LOG_HELP}</p>
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
                    {step.workerId || step.leaseId || step.fencingToken != null ? (
                      <p className="mt-2 font-mono text-xs text-zinc-600">
                        {step.workerId ? `worker ${step.workerId}` : ""}
                        {step.leaseId ? ` · lease ${step.leaseId}` : ""}
                        {step.fencingToken != null
                          ? ` · fence ${step.fencingToken}`
                          : ""}
                      </p>
                    ) : null}
                    {canRetryExecutionStep({
                      permissions,
                      permittedActions: view.permittedActions,
                      executionStatus: view.header.status,
                      stepStatus: step.status,
                      nodeType: step.nodeType,
                    }) ? (
                      <button
                        type="button"
                        onClick={() => void onRetry(step.id)}
                        disabled={Boolean(retryPending) || pending || cancelPending}
                        className="mt-3 rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
                      >
                        {retryPending === step.id ? "Retrying…" : "Retry step"}
                      </button>
                    ) : isIndeterminateStatus(step.status) ||
                      isIndeterminateStatus(view.header.status) ? (
                      <p className="mt-3 text-sm font-medium text-amber-950">
                        {RETRY_INDETERMINATE_MESSAGE}
                      </p>
                    ) : null}
                    {(() => {
                      const logs =
                        stepLogs[step.id] ??
                        boundRedactedDisplay(
                          step.output ?? step.error ?? step.input,
                        );
                      return (
                        <div className="mt-3">
                          <p className="text-xs font-medium text-zinc-600">
                            Bounded logs / output
                          </p>
                          <pre className="mt-1 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
                            {logs.text}
                          </pre>
                          {logs.truncated ? (
                            <p className="mt-1 text-xs text-zinc-500">
                              Output truncated at {logs.maxBytes} characters.
                            </p>
                          ) : null}
                        </div>
                      );
                    })()}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <ExecutionArtifacts
            artifacts={view.artifacts}
            retentionUntil={view.retentionUntil}
            legalHold={view.legalHold}
            pendingId={downloadPending}
            message={downloadMessage}
            disabled={pending || cancelPending}
            onDownload={(artifact) => void onDownload(artifact.id)}
          />

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Jobs</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Dispatch records with safe lease/claim/heartbeat metadata when
              the API returns them. Worker secrets are never shown. This UI
              does not claim jobs.
            </p>
            {view.jobViews.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-600">No jobs returned.</p>
            ) : (
              <ul className="mt-4 grid gap-2">
                {view.jobViews.map((job) => (
                  <li
                    key={job.id}
                    className={
                      job.presentation.indeterminate
                        ? "rounded-xl border-2 border-amber-700 bg-amber-50 px-4 py-3 text-sm"
                        : "rounded-xl border border-zinc-200 px-4 py-3 text-sm"
                    }
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <p className="font-medium">
                        <span aria-hidden="true">{job.presentation.icon} </span>
                        {job.presentation.label}
                        {job.claimed ? " · lease/claim" : ""}
                      </p>
                      <ExecutionStatusBadge status={job.status} />
                    </div>
                    <p className="mt-1 font-mono text-xs break-all text-zinc-600">
                      {job.id}
                      {job.executionStepId ? ` · step ${job.executionStepId}` : ""}
                    </p>
                    <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                      {job.workerId ? (
                        <div>
                          <dt className="text-zinc-500">Worker id</dt>
                          <dd className="font-mono break-all">{job.workerId}</dd>
                        </div>
                      ) : null}
                      {job.leaseId ? (
                        <div>
                          <dt className="text-zinc-500">Lease id</dt>
                          <dd className="font-mono break-all">{job.leaseId}</dd>
                        </div>
                      ) : null}
                      {job.leaseExpiresAt ? (
                        <div>
                          <dt className="text-zinc-500">Lease expires</dt>
                          <dd className="font-mono">{job.leaseExpiresAt}</dd>
                        </div>
                      ) : null}
                      {job.heartbeatAt ? (
                        <div>
                          <dt className="text-zinc-500">Heartbeat</dt>
                          <dd className="font-mono">{job.heartbeatAt}</dd>
                        </div>
                      ) : null}
                      {job.fencingToken != null ? (
                        <div>
                          <dt className="text-zinc-500">Fencing token</dt>
                          <dd className="font-mono">{job.fencingToken}</dd>
                        </div>
                      ) : null}
                    </dl>
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
