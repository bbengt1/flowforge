"use client";

import Link from "next/link";
import { useState } from "react";
import {
  failClosedProblemTitle,
  problemClosesApproval,
} from "@/lib/approval";
import { approveApproval, rejectApproval } from "@/lib/approval-client";
import type { ApprovalRequest } from "@/lib/approval-types";
import {
  EXECUTION_DECIDE_APPROVE_LABEL,
  EXECUTION_DECIDE_HELP,
  EXECUTION_DECIDE_MISSING_COPY,
  EXECUTION_DECIDE_OPEN_LABEL,
  EXECUTION_DECIDE_REJECT_LABEL,
  EXECUTION_DECIDE_SELF_REQUESTED_COPY,
  EXECUTION_DECIDE_WAITING_COPY,
  executionDecideAffordances,
  type ExecutionDecideSurface,
} from "@/lib/execution-decide";
import type { ExecutionStatus } from "@/lib/execution-types";
import type { DevIdentity } from "@/lib/identity-headers";

type ExecutionDecideActionsProps = {
  identity: DevIdentity;
  executionId: string;
  status?: ExecutionStatus;
  approvals?: readonly ApprovalRequest[] | null;
  actorUserId?: string;
  permissions?: readonly string[] | null;
  surface?: ExecutionDecideSurface;
  compact?: boolean;
  disabled?: boolean;
  onDecided?: () => void;
};

export function ExecutionDecideActions({
  identity,
  executionId,
  status,
  approvals,
  actorUserId = "",
  permissions,
  surface = "inbox",
  compact = false,
  disabled = false,
  onDecided,
}: ExecutionDecideActionsProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const affordances = executionDecideAffordances({
    status,
    approvals,
    actorUserId,
    permissions,
  });
  const busy = pendingAction !== null || disabled;
  const pad = compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  if (!affordances.waiting && affordances.pending.length === 0) {
    return null;
  }

  async function decide(approval: ApprovalRequest, action: "approve" | "reject") {
    if (busy) {
      return;
    }
    setPendingAction(`${action}:${approval.id}`);
    setMessage(null);
    const result =
      action === "approve"
        ? await approveApproval(identity, approval.id)
        : await rejectApproval(identity, approval.id);
    setPendingAction(null);
    if (!result.ok) {
      setMessage(
        failClosedProblemTitle(result.problem) ||
          result.problem.detail ||
          result.problem.title,
      );
      if (
        result.expired ||
        result.invalidated ||
        result.selfApproval ||
        problemClosesApproval(result.problem)
      ) {
        return;
      }
      return;
    }
    setMessage(
      action === "approve" ? "Approved — resume is decide." : "Rejected.",
    );
    onDecided?.();
  }

  return (
    <div
      data-execution-decide={surface}
      className="space-y-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <p
        data-execution-decide-waiting=""
        className={
          compact
            ? "text-[11px] font-medium text-sky-950"
            : "text-xs font-medium text-sky-950"
        }
      >
        {affordances.approvalsLoaded
          ? affordances.pending.length === 0
            ? EXECUTION_DECIDE_MISSING_COPY
            : EXECUTION_DECIDE_WAITING_COPY
          : EXECUTION_DECIDE_WAITING_COPY}
      </p>
      {affordances.selfRequested ? (
        <p role="status" className="text-[11px] text-amber-950">
          {EXECUTION_DECIDE_SELF_REQUESTED_COPY}
        </p>
      ) : null}
      {affordances.pending.map((approval) => {
        const canDecide = affordances.decidable.some(
          (item) => item.id === approval.id,
        );
        return (
          <div key={approval.id} className="flex flex-wrap items-center gap-1.5">
            {canDecide ? (
              <>
                <button
                  type="button"
                  data-execution-decide-action="approve"
                  disabled={busy}
                  onClick={() => void decide(approval, "approve")}
                  className={`rounded-md border border-teal-800 bg-teal-800 font-medium text-white hover:bg-teal-900 disabled:opacity-60 ${pad}`}
                >
                  {pendingAction === `approve:${approval.id}`
                    ? "Approving…"
                    : EXECUTION_DECIDE_APPROVE_LABEL}
                </button>
                <button
                  type="button"
                  data-execution-decide-action="reject"
                  disabled={busy}
                  onClick={() => void decide(approval, "reject")}
                  className={`rounded-md border border-zinc-300 bg-white font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 ${pad}`}
                >
                  {pendingAction === `reject:${approval.id}`
                    ? "Rejecting…"
                    : EXECUTION_DECIDE_REJECT_LABEL}
                </button>
              </>
            ) : null}
            <Link
              href={`/approvals/${approval.id}`}
              data-execution-decide-open=""
              className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            >
              {EXECUTION_DECIDE_OPEN_LABEL}
            </Link>
            <span className="font-mono text-[11px] break-all text-zinc-500">
              {approval.id}
            </span>
          </div>
        );
      })}
      {affordances.waiting && affordances.approvalsLoaded && affordances.pending.length === 0 ? (
        <p className="text-[11px] text-zinc-500">
          Open{" "}
          <Link
            href={`/executions/${executionId}`}
            className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
          >
            /executions/{executionId}
          </Link>{" "}
          for bound approval detail.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-[11px] text-zinc-800">
          {message}
        </p>
      ) : compact ? null : (
        <p className="sr-only">{EXECUTION_DECIDE_HELP}</p>
      )}
    </div>
  );
}
