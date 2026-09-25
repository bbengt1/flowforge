"use client";

import { useState } from "react";
import { ConfirmDestructive } from "@/components/a11y/ConfirmDestructive";
import { emergencyStopImpact } from "@/lib/confirm-destructive";
import {
  cancelExecution,
  retryExecution,
} from "@/lib/execution-client";
import { RETRY_FORBIDDEN_MESSAGE } from "@/lib/execution-contract";
import {
  retryFailureCopy,
  retryProblemShouldRefetch,
} from "@/lib/execution-retry";
import {
  EXECUTION_OPERATE_CANCEL_LABEL,
  EXECUTION_OPERATE_HELP,
  EXECUTION_OPERATE_RETRY_LABEL,
  EXECUTION_OPERATE_STOP_CONFIRM_LABEL,
  EXECUTION_OPERATE_STOP_LABEL,
  executionOperateAffordances,
  type ExecutionOperateSurface,
} from "@/lib/execution-operate";
import type { ExecutionDetail, ExecutionStatus } from "@/lib/execution-types";
import type { DevIdentity } from "@/lib/identity-headers";
import { emergencyStopExecution } from "@/lib/script-ops-client";
import {
  SCRIPT_EMERGENCY_STOP_CONFIRM_HELP,
  SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
  emergencyStopShouldMarkUncertain,
} from "@/lib/script-ops-contract";
import {
  FF_INBOX_DANGER_CLASS,
  FF_INBOX_GHOST_CLASS,
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PRIMARY_CLASS,
  FF_LOUD_DANGER_CLASS,
  FF_LOUD_INDETERMINATE_CLASS,
} from "@/lib/vault-executions-visual";

type ExecutionOperateActionsProps = {
  identity: DevIdentity;
  executionId: string;
  workflowId?: string;
  status?: ExecutionStatus;
  permissions?: readonly string[] | null;
  detail?: Pick<
    ExecutionDetail,
    "status" | "steps" | "capabilities" | "capabilitiesInvalid"
  > | null;
  surface?: ExecutionOperateSurface;
  compact?: boolean;
  disabled?: boolean;
  onOperated?: () => void;
};

export function ExecutionOperateActions({
  identity,
  executionId,
  workflowId,
  status,
  permissions,
  detail,
  surface = "inbox",
  compact = false,
  disabled = false,
  onOperated,
}: ExecutionOperateActionsProps) {
  const [cancelPending, setCancelPending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [stoppedUncertain, setStoppedUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const resolvedStatus = detail?.status ?? status;
  // Retry stays gated by capabilities.retry.allowed on the execution.
  const affordances = executionOperateAffordances({
    permissions,
    status: resolvedStatus,
    steps: detail?.steps,
    stoppedUncertain,
    capabilities: detail?.capabilities,
    capabilitiesInvalid: detail?.capabilitiesInvalid,
  });
  const busy = cancelPending || retryPending || stopPending || disabled;
  const pad = compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  async function onCancel() {
    if (!affordances.cancel || busy) {
      return;
    }
    setCancelPending(true);
    setMessage(null);
    const result = await cancelExecution(identity, executionId, {
      workflowId,
      previousStatus: resolvedStatus,
    });
    setCancelPending(false);
    if (!result.ok) {
      setMessage(result.problem.detail || result.problem.title);
      return;
    }
    setMessage(result.message);
    onOperated?.();
  }

  async function onRetry() {
    if (!affordances.retry || busy) {
      return;
    }
    setRetryPending(true);
    setMessage(null);
    const result = await retryExecution(identity, executionId, {
      workflowId,
    });
    setRetryPending(false);
    if (!result.ok) {
      if (result.forbidden) {
        setMessage(RETRY_FORBIDDEN_MESSAGE);
      } else if (result.statusCode === 409) {
        setMessage(
          retryFailureCopy(result.problem, result.statusCode) ??
            (result.problem.detail || result.problem.title),
        );
        if (retryProblemShouldRefetch(result.problem)) {
          onOperated?.();
        }
      } else {
        setMessage(result.problem.detail || result.problem.title);
      }
      return;
    }
    setMessage(result.message);
    onOperated?.();
  }

  async function onStop() {
    if (!affordances.stop || busy) {
      return;
    }
    setStopPending(true);
    setMessage(null);
    const result = await emergencyStopExecution(identity, executionId, {
      uncertain: emergencyStopShouldMarkUncertain(resolvedStatus),
      status: resolvedStatus,
    });
    setStopPending(false);
    setStopOpen(false);
    if (!result.ok) {
      setMessage(
        result.forbidden
          ? SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE
          : result.problem.detail || result.problem.title,
      );
      return;
    }
    setStoppedUncertain(result.uncertain || result.outcome === "indeterminate");
    setMessage(result.message);
    onOperated?.();
  }

  if (
    !affordances.cancel &&
    !affordances.retry &&
    !affordances.stop &&
    !affordances.indeterminate
  ) {
    return null;
  }

  return (
    <div
      data-execution-operate={surface}
      className="space-y-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {affordances.cancel ? (
          <button
            type="button"
            data-execution-operate-action="cancel"
            disabled={busy}
            onClick={() => void onCancel()}
            className={`${FF_INBOX_GHOST_CLASS} ${pad}`}
          >
            {cancelPending ? "Canceling…" : EXECUTION_OPERATE_CANCEL_LABEL}
          </button>
        ) : null}
        {affordances.stop ? (
          <button
            type="button"
            data-execution-operate-action="stop"
            disabled={busy}
            onClick={() => setStopOpen(true)}
            className={`${FF_LOUD_DANGER_CLASS} ${pad}`}
          >
            {stopPending ? "Stopping…" : EXECUTION_OPERATE_STOP_LABEL}
          </button>
        ) : null}
        {affordances.retry ? (
          <button
            type="button"
            data-execution-operate-action="retry"
            disabled={busy}
            onClick={() => void onRetry()}
            className={`${FF_INBOX_PRIMARY_CLASS} ${pad}`}
          >
            {retryPending ? "Retrying…" : EXECUTION_OPERATE_RETRY_LABEL}
          </button>
        ) : null}
      </div>
      {affordances.indeterminate ? (
        <p
          data-execution-operate-indeterminate=""
          className={`text-[11px] font-medium ${FF_LOUD_INDETERMINATE_CLASS}`}
        >
          {affordances.loudIndeterminateCopy}
        </p>
      ) : affordances.retry ? null : affordances.retryBlockedReason &&
        (resolvedStatus === "failed" || resolvedStatus === "canceled") ? (
        <p className={`text-[11px] ${FF_INBOX_MUTED_CLASS}`}>
          {affordances.retryBlockedReason}
        </p>
      ) : null}
      {message ? (
        <p role="status" className={`text-[11px] ${FF_INBOX_DANGER_CLASS}`}>
          {message}
        </p>
      ) : compact ? null : (
        <p className="sr-only">{EXECUTION_OPERATE_HELP}</p>
      )}
      <ConfirmDestructive
        open={stopOpen}
        title="Emergency stop this execution?"
        description={SCRIPT_EMERGENCY_STOP_CONFIRM_HELP}
        reversibility="irreversible"
        confirmLabel={EXECUTION_OPERATE_STOP_CONFIRM_LABEL}
        pending={stopPending}
        pendingLabel="Stopping…"
        impact={emergencyStopImpact({
          executionId,
          status: resolvedStatus,
        })}
        onClose={() => setStopOpen(false)}
        onConfirm={() => {
          setStopOpen(false);
          void onStop();
        }}
      />
    </div>
  );
}
