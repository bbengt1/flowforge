"use client";

import { useState } from "react";
import {
  cancelExecution,
  retryExecution,
} from "@/lib/execution-client";
import {
  RETRY_CONFLICT_MESSAGE,
  RETRY_FORBIDDEN_MESSAGE,
} from "@/lib/execution-contract";
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
  SCRIPT_EMERGENCY_STOP_FORBIDDEN_MESSAGE,
  emergencyStopShouldMarkUncertain,
} from "@/lib/script-ops-contract";
import { SSH_RETRY_DENIED_MESSAGE } from "@/lib/ssh-retry-contract";

type ExecutionOperateActionsProps = {
  identity: DevIdentity;
  executionId: string;
  workflowId?: string;
  status?: ExecutionStatus;
  permissions?: readonly string[] | null;
  detail?: Pick<ExecutionDetail, "status" | "steps"> | null;
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
  const [stopConfirm, setStopConfirm] = useState(false);
  const [stoppedUncertain, setStoppedUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const resolvedStatus = detail?.status ?? status;
  const affordances = executionOperateAffordances({
    permissions,
    status: resolvedStatus,
    steps: detail?.steps,
    stoppedUncertain,
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
          result.problem.code === "retry-denied"
            ? result.problem.detail || SSH_RETRY_DENIED_MESSAGE
            : RETRY_CONFLICT_MESSAGE,
        );
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
    if (!stopConfirm) {
      setStopConfirm(true);
      setMessage(null);
      return;
    }
    setStopPending(true);
    setMessage(null);
    const result = await emergencyStopExecution(identity, executionId, {
      uncertain: emergencyStopShouldMarkUncertain(resolvedStatus),
      status: resolvedStatus,
    });
    setStopPending(false);
    setStopConfirm(false);
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
            className={`rounded-md border border-zinc-800 bg-zinc-900 font-medium text-white hover:bg-zinc-800 disabled:opacity-60 ${pad}`}
          >
            {cancelPending ? "Canceling…" : EXECUTION_OPERATE_CANCEL_LABEL}
          </button>
        ) : null}
        {affordances.stop ? (
          <button
            type="button"
            data-execution-operate-action="stop"
            disabled={busy}
            onClick={() => void onStop()}
            className={`rounded-md border-2 border-rose-800 bg-rose-800 font-semibold text-white hover:bg-rose-900 disabled:opacity-60 ${pad}`}
          >
            {stopPending
              ? "Stopping…"
              : stopConfirm
                ? EXECUTION_OPERATE_STOP_CONFIRM_LABEL
                : EXECUTION_OPERATE_STOP_LABEL}
          </button>
        ) : null}
        {affordances.retry ? (
          <button
            type="button"
            data-execution-operate-action="retry"
            disabled={busy}
            onClick={() => void onRetry()}
            className={`rounded-md border border-teal-800 bg-teal-800 font-medium text-white hover:bg-teal-900 disabled:opacity-60 ${pad}`}
          >
            {retryPending ? "Retrying…" : EXECUTION_OPERATE_RETRY_LABEL}
          </button>
        ) : null}
      </div>
      {affordances.indeterminate ? (
        <p
          data-execution-operate-indeterminate=""
          className="text-[11px] font-medium text-amber-950"
        >
          {affordances.loudIndeterminateCopy}
        </p>
      ) : affordances.retry ? null : affordances.retryBlockedReason &&
        (resolvedStatus === "failed" || resolvedStatus === "canceled") ? (
        <p className="text-[11px] text-zinc-500">
          {affordances.retryBlockedReason}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-[11px] text-zinc-800">
          {message}
        </p>
      ) : compact ? null : (
        <p className="sr-only">{EXECUTION_OPERATE_HELP}</p>
      )}
    </div>
  );
}
