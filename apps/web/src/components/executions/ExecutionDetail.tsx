"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExecutionApprovalState } from "@/components/approvals/ExecutionApprovalState";
import { ConfigPinList } from "@/components/config/ConfigPinList";
import { ExecutionArtifacts } from "@/components/executions/ExecutionArtifacts";
import { ExecutionCompare } from "@/components/executions/ExecutionCompare";
import { ExecutionReplay } from "@/components/executions/ExecutionReplay";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { RolloutObservationPanel } from "@/components/executions/RolloutObservationPanel";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import type { EditorSelection } from "@/components/workflows/WorkflowCanvas";
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
import { manualStartHref } from "@/lib/manual-start-contract";
import { listExecutionApprovals } from "@/lib/approval-client";
import type { ApprovalRequest } from "@/lib/approval-types";
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
import {
  compareRedactedExecutions,
  executionErrorNavLinks,
} from "@/lib/execution-replay";
import { adaptActionLibrary } from "@/lib/workflow-action-library";
import { compareWorkflow, fetchWorkflowCatalog, getWorkflowVersion } from "@/lib/workflow-client";
import { versionCompareRef } from "@/lib/workflow";
import type {
  CompareWorkflowResult,
  WorkflowCatalog,
  WorkflowVersion,
} from "@/lib/workflow-types";
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
import {
  KUBERNETES_ROLLOUT_CANCEL_HELP,
  collectRolloutAuditSnapshots,
  collectRolloutObservations,
  executionHasRolloutObservation,
} from "@/lib/kubernetes-rollout-contract";
import {
  SSH_NO_BLIND_RETRY_HELP,
  SSH_RETRY_DENIED_MESSAGE,
  canOfferSshRetry,
  executionHasSshIndeterminate,
  executionHasSshRun,
  isSshRunType,
  parseSshRetryResult,
  sshIndeterminateCopy,
  sshRetryBlockedMessage,
  sshVerificationOutcomeCopy,
} from "@/lib/ssh-retry-contract";
import { ScriptIoResultPanel } from "@/components/executions/ScriptIoResultPanel";
import {
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  canOfferScriptRetry,
  executionHasScriptIndeterminate,
  executionHasScriptRun,
  isScriptIoActionType,
  parseScriptIoRetryResult,
  scriptIndeterminateCopy,
  scriptRetryBlockedMessage,
} from "@/lib/script-io-contract";
import { emergencyStopExecution } from "@/lib/script-ops-client";
import {
  SCRIPT_EMERGENCY_STOP_CONFIRM_HELP,
  SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
  SCRIPT_EMERGENCY_STOP_HELP,
  SCRIPT_EMERGENCY_STOP_PERMISSION,
  SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP,
  canOfferScriptEmergencyStop,
  emergencyStopShouldMarkUncertain,
  scriptEmergencyStopCopy,
} from "@/lib/script-ops-contract";

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
  const [stopPending, setStopPending] = useState<string | null>(null);
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState<string | null>(null);
  const [stoppedUncertain, setStoppedUncertain] = useState(false);
  const [downloadPending, setDownloadPending] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [stepLogs, setStepLogs] = useState<Record<string, ExecutionLogSlice>>(
    {},
  );
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [version, setVersion] = useState<WorkflowVersion | null>(null);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [selection, setSelection] = useState<EditorSelection>({ kind: "workflow" });
  const [compareId, setCompareId] = useState("");
  const [compareDetail, setCompareDetail] = useState<ExecutionDetailModel | null>(
    null,
  );
  const [versionCompare, setVersionCompare] =
    useState<CompareWorkflowResult | null>(null);
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
  const sshRetryAllowed = Boolean(
    view?.steps.some((step) =>
      canOfferSshRetry({
        permissions,
        nodeType: step.nodeType,
        status: step.status,
        output: step.output,
        error: step.error,
        input: step.input,
      }),
    ),
  );
  const scriptRetryAllowed = Boolean(
    view?.steps.some((step) =>
      canOfferScriptRetry({
        permissions,
        nodeType: step.nodeType,
        status: step.status,
        output: step.output,
        error: step.error,
        input: step.input,
      }),
    ),
  );
  const showRetry =
    !stoppedUncertain &&
    (sshRetryAllowed ||
      scriptRetryAllowed ||
      canRetryExecution({
        permissions,
        permittedActions: view?.permittedActions,
        status: view?.header.status,
        steps: view?.steps,
      }));
  const canEmergencyStop = canOfferScriptEmergencyStop({
    permissions,
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
    const workflowIdForPin = result.execution.workflowId || workflowId;
    if (workflowIdForPin && result.execution.workflowVersionId) {
      const [versionResult, catalogResult, approvalResult] = await Promise.all([
        getWorkflowVersion(
          identity,
          workflowIdForPin,
          result.execution.workflowVersionId,
        ),
        fetchWorkflowCatalog(identity),
        listExecutionApprovals(identity, workflowIdForPin, result.execution.id),
      ]);
      if (versionResult.ok) {
        setVersion(versionResult.version);
      }
      if (catalogResult.ok) {
        setCatalog(catalogResult.catalog);
      }
      if (approvalResult.ok) {
        setApprovals(approvalResult.items);
      }
    }
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

  async function onEmergencyStop(stepId?: string) {
    if (!canEmergencyStop || stopPending) {
      return;
    }
    const confirmKey = stepId ?? "execution";
    if (stopConfirm !== confirmKey) {
      setStopConfirm(confirmKey);
      setStopMessage(null);
      return;
    }
    setStopPending(confirmKey);
    setProblem(null);
    setStopMessage(null);
    const status = stepId
      ? view?.steps.find((step) => step.id === stepId)?.status
      : view?.header.status;
    const result = await emergencyStopExecution(identity, executionId, {
      stepId,
      uncertain: emergencyStopShouldMarkUncertain(status),
      status,
    });
    setLastRequestId(result.requestId);
    setStopPending(null);
    setStopConfirm(null);
    if (!result.ok) {
      setProblem(result.problem);
      if (result.forbidden) {
        setStopMessage(SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE);
      }
      return;
    }
    setStoppedUncertain(result.uncertain || result.outcome === "indeterminate");
    setStopMessage(result.message);
    await refresh();
  }

  async function onRetry(stepId?: string) {
    if (retryPending || stoppedUncertain) {
      return;
    }
    if (stepId) {
      const step = view?.steps.find((item) => item.id === stepId);
      const sshOffer = canOfferSshRetry({
        permissions,
        nodeType: step?.nodeType,
        status: step?.status,
        output: step?.output,
        error: step?.error,
        input: step?.input,
      });
      const scriptOffer = canOfferScriptRetry({
        permissions,
        nodeType: step?.nodeType,
        status: step?.status,
        output: step?.output,
        error: step?.error,
        input: step?.input,
      });
      if (
        !sshOffer &&
        !scriptOffer &&
        !canRetryExecutionStep({
          permissions,
          permittedActions: view?.permittedActions,
          executionStatus: view?.header.status,
          stepStatus: step?.status,
          nodeType: step?.nodeType,
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
        setRetryMessage(
          result.problem.code === "retry-denied"
            ? result.problem.detail || SSH_RETRY_DENIED_MESSAGE
            : RETRY_CONFLICT_MESSAGE,
        );
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
        save: (blob, filename) => {
          const objectUrl = URL.createObjectURL(blob);
          try {
            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = filename;
            link.rel = "noopener noreferrer";
            link.click();
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
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

      <nav aria-label="Execution errors" className="text-sm">
        <a
          href="#execution-errors"
          className="sr-only focus:not-sr-only focus:rounded-md focus:border focus:border-teal-800 focus:bg-white focus:px-3 focus:py-2"
        >
          Skip to errors
        </a>
        <a
          href="#graph-replay-heading"
          className="sr-only focus:not-sr-only focus:ml-2 focus:rounded-md focus:border focus:border-teal-800 focus:bg-white focus:px-3 focus:py-2"
        >
          Skip to graph replay
        </a>
      </nav>

      <div id="execution-errors">
        {problem ? <ProblemBanner problem={problem} /> : null}
      </div>
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

      {view && detail ? (
        <>
          {(() => {
            const errorLinks = executionErrorNavLinks({
              steps: view.steps,
              problem,
            });
            if (errorLinks.length === 0) {
              return null;
            }
            return (
              <nav
                aria-label="Failed and indeterminate steps"
                className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm"
              >
                <p className="font-medium">Error navigation</p>
                <ul className="mt-2 space-y-1">
                  {errorLinks.map((link) => (
                    <li key={`${link.href}-${link.label}`}>
                      <a
                        href={link.href}
                        onClick={(event) => {
                          if (link.nodeId) {
                            event.preventDefault();
                            setSelection({ kind: "node", id: link.nodeId });
                            document.getElementById(link.id)?.focus();
                          }
                        }}
                        className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            );
          })()}
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
                {executionHasSshRun(view.steps) ||
                executionHasSshIndeterminate(view.steps)
                  ? sshIndeterminateCopy({
                      status: view.header.status,
                      nodeType: view.steps.find((step) =>
                        isSshRunType(step.nodeType),
                      )?.nodeType,
                      verificationOutcome: parseSshRetryResult(
                        view.steps.find((step) => isSshRunType(step.nodeType))
                          ?.output,
                        view.steps.find((step) => isSshRunType(step.nodeType))
                          ?.error,
                      )?.verificationOutcome,
                    })
                  : executionHasScriptRun(view.steps) ||
                      executionHasScriptIndeterminate(view.steps)
                    ? scriptIndeterminateCopy({
                        status: view.header.status,
                        nodeType: view.steps.find((step) =>
                          isScriptIoActionType(step.nodeType),
                        )?.nodeType,
                        errorCode: parseScriptIoRetryResult(
                          view.steps.find((step) =>
                            isScriptIoActionType(step.nodeType),
                          )?.output,
                          view.steps.find((step) =>
                            isScriptIoActionType(step.nodeType),
                          )?.error,
                        )?.verificationOutcome,
                      })
                    : INDETERMINATE_STATUS_HELP}
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
                  disabled={cancelPending || pending || Boolean(stopPending)}
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
              {canEmergencyStop ? (
                <button
                  type="button"
                  onClick={() => void onEmergencyStop()}
                  disabled={Boolean(stopPending) || pending || cancelPending}
                  className="rounded-lg border-2 border-rose-800 bg-rose-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-900 disabled:opacity-60"
                >
                  {stopPending === "execution"
                    ? "Stopping…"
                    : stopConfirm === "execution"
                      ? "Confirm emergency stop"
                      : "Emergency stop"}
                </button>
              ) : executionHasScriptRun(view.steps) &&
                permissions != null &&
                !permissions.includes(SCRIPT_EMERGENCY_STOP_PERMISSION) ? (
                <p className="text-sm text-zinc-600">
                  {SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE}
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
                  {executionHasSshRun(view.steps) ||
                  executionHasSshIndeterminate(view.steps)
                    ? sshRetryBlockedMessage({
                        status: view.header.status,
                        steps: view.steps,
                        output: view.steps.find((step) =>
                          isSshRunType(step.nodeType),
                        )?.output,
                        error: view.steps.find((step) =>
                          isSshRunType(step.nodeType),
                        )?.error,
                      })
                    : executionHasScriptRun(view.steps) ||
                        executionHasScriptIndeterminate(view.steps)
                      ? scriptRetryBlockedMessage({
                          status: view.header.status,
                          nodeType: view.steps.find((step) =>
                            isScriptIoActionType(step.nodeType),
                          )?.nodeType,
                          output: view.steps.find((step) =>
                            isScriptIoActionType(step.nodeType),
                          )?.output,
                          error: view.steps.find((step) =>
                            isScriptIoActionType(step.nodeType),
                          )?.error,
                        })
                      : RETRY_INDETERMINATE_MESSAGE}
                </p>
              ) : executionHasSshRun(view.steps) ? (
                <p className="text-xs text-zinc-500">{SSH_NO_BLIND_RETRY_HELP}</p>
              ) : executionHasScriptRun(view.steps) ? (
                <p className="text-xs text-zinc-500">{SCRIPT_IO_NO_BLIND_RETRY_HELP}</p>
              ) : (
                <p className="text-xs text-zinc-500">
                  {retryAffordanceMessage(view.header.status)}
                </p>
              )}
            </div>
            {executionHasRolloutObservation(view.steps) ? (
              <p className="mt-2 text-sm text-zinc-700">
                {KUBERNETES_ROLLOUT_CANCEL_HELP}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-zinc-500">{CANCEL_CSRF_HELP}</p>
            <p className="mt-1 text-xs text-zinc-500">{RETRY_CSRF_HELP}</p>
            <p className="mt-1 text-xs text-zinc-500">{STATUS_POLL_HELP}</p>
            {canEmergencyStop || stoppedUncertain ? (
              <p className="mt-2 text-xs text-rose-900">
                {SCRIPT_EMERGENCY_STOP_HELP} {SCRIPT_EMERGENCY_STOP_CONFIRM_HELP}{" "}
                {SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP}
              </p>
            ) : null}
            {cancelMessage ? (
              <p role="status" className="mt-3 text-sm text-zinc-800">
                {cancelMessage}
              </p>
            ) : null}
            {stopMessage ? (
              <p role="status" className="mt-3 text-sm font-medium text-rose-950">
                {stopMessage}
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
              <p className="mt-4 flex flex-wrap gap-3 text-sm">
                <Link
                  href={manualStartHref(detail.workflowId)}
                  className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                >
                  Start another published version
                </Link>
                <Link
                  href={`/workflows/${detail.workflowId}`}
                  className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                >
                  Open workflow operator
                </Link>
              </p>
            ) : null}
          </section>

          <ExecutionReplay
            detail={detail}
            version={version}
            catalog={catalog}
            entries={adaptActionLibrary(catalog)}
            approvals={approvals}
            artifacts={view.artifacts}
            selection={selection}
            onSelect={setSelection}
            logsText={
              selection.kind === "node"
                ? stepLogs[
                    view.steps.find((step) => step.nodeId === selection.id)?.id ??
                      ""
                  ]?.text
                : undefined
            }
          />

          <ExecutionApprovalState
            executionStatus={view.header.status}
            approvals={approvals}
          />

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Compare another run</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Client-side diff of redacted summaries. Secrets stay{" "}
              <code className="font-mono text-xs">[redacted]</code>.
            </p>
            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const id = compareId.trim();
                if (!id) {
                  return;
                }
                void loadExecutionHistory(
                  identity,
                  id,
                  workflowId || detail?.workflowId,
                ).then(async (result) => {
                  setLastRequestId(result.requestId);
                  if (!result.ok) {
                    setProblem(result.problem);
                    return;
                  }
                  setCompareDetail(result.execution);
                  const leftRef = versionCompareRef(detail.workflowVersionId);
                  const rightRef = versionCompareRef(result.execution.workflowVersionId);
                  if (
                    detail.workflowId &&
                    detail.workflowId === result.execution.workflowId &&
                    leftRef &&
                    rightRef
                  ) {
                    const yaml = await compareWorkflow(identity, detail.workflowId, {
                      left: leftRef,
                      right: rightRef,
                    });
                    setVersionCompare(yaml.ok ? yaml.compare : null);
                  } else {
                    setVersionCompare(null);
                  }
                });
              }}
            >
              <label className="text-sm">
                <span className="font-medium">Other execution id</span>
                <input
                  value={compareId}
                  onChange={(event) => setCompareId(event.target.value)}
                  className="mt-1 block w-80 rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
              >
                Compare
              </button>
            </form>
            {compareDetail ? (
              <div className="mt-4">
                <ExecutionCompare
                  result={compareRedactedExecutions(detail, compareDetail)}
                  versionCompare={versionCompare}
                />
              </div>
            ) : null}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Steps</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Redacted step state with bounded logs and output. Secret
              values show as{" "}
              <code className="font-mono text-xs">[redacted]</code>. Graph
              replay above uses the pinned published version when YAML is
              available.
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
                    {canOfferSshRetry({
                      permissions,
                      nodeType: step.nodeType,
                      status: step.status,
                      output: step.output,
                      error: step.error,
                      input: step.input,
                    }) ||
                    (!stoppedUncertain &&
                      canOfferScriptRetry({
                      permissions,
                      nodeType: step.nodeType,
                      status: step.status,
                      output: step.output,
                      error: step.error,
                      input: step.input,
                    })) ||
                    canRetryExecutionStep({
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
                        {isSshRunType(step.nodeType)
                          ? sshRetryBlockedMessage({
                              status: step.status,
                              nodeType: step.nodeType,
                              output: step.output,
                              error: step.error,
                            })
                          : isScriptIoActionType(step.nodeType)
                            ? scriptRetryBlockedMessage({
                                status: step.status,
                                nodeType: step.nodeType,
                                output: step.output,
                                error: step.error,
                              })
                            : RETRY_INDETERMINATE_MESSAGE}
                      </p>
                    ) : isSshRunType(step.nodeType) ? (
                      <p className="mt-3 text-xs text-zinc-500">
                        {SSH_NO_BLIND_RETRY_HELP}
                      </p>
                    ) : isScriptIoActionType(step.nodeType) ? (
                      <p className="mt-3 text-xs text-zinc-500">
                        {stoppedUncertain
                          ? scriptEmergencyStopCopy({
                              outcome: "indeterminate",
                              uncertain: true,
                              status: step.status,
                            })
                          : SCRIPT_IO_NO_BLIND_RETRY_HELP}
                      </p>
                    ) : null}
                    {canOfferScriptEmergencyStop({
                      permissions,
                      status: step.status,
                      nodeType: step.nodeType,
                    }) ? (
                      <button
                        type="button"
                        onClick={() => void onEmergencyStop(step.id)}
                        disabled={Boolean(stopPending) || pending || cancelPending}
                        className="mt-3 ml-2 rounded-lg border-2 border-rose-800 bg-rose-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-900 disabled:opacity-60"
                      >
                        {stopPending === step.id
                          ? "Stopping…"
                          : stopConfirm === step.id
                            ? "Confirm emergency stop"
                            : "Emergency stop step"}
                      </button>
                    ) : null}
                    {isSshRunType(step.nodeType)
                      ? (() => {
                          const retry = parseSshRetryResult(
                            step.output,
                            step.error,
                            step.input,
                          );
                          return retry?.verificationOutcome ? (
                            <p className="mt-2 text-xs text-zinc-700">
                              {sshVerificationOutcomeCopy(retry.verificationOutcome)}
                            </p>
                          ) : null;
                        })()
                      : null}
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

          <ScriptIoResultPanel steps={view.steps} />

          <RolloutObservationPanel
            observations={collectRolloutObservations({
              steps: view.steps,
              auditEvents: view.auditEvents,
            })}
            auditSnapshots={collectRolloutAuditSnapshots(
              view.auditEvents,
              view.steps,
            )}
          />

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
                        {boundRedactedDisplay(event.details).text}
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
