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
import {
  FF_INBOX_GHOST_CLASS,
  FF_INBOX_LINK_CLASS,
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PRIMARY_CLASS,
  FF_INBOX_TITLE_CLASS,
  FF_LOUD_WARNING_CLASS,
} from "@/lib/vault-executions-visual";

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
            ? `text-[11px] font-medium ${FF_INBOX_TITLE_CLASS}`
            : `text-xs font-medium ${FF_INBOX_TITLE_CLASS}`
        }
      >
        {affordances.approvalsLoaded
          ? affordances.pending.length === 0
            ? EXECUTION_DECIDE_MISSING_COPY
            : EXECUTION_DECIDE_WAITING_COPY
          : EXECUTION_DECIDE_WAITING_COPY}
      </p>
      {affordances.selfRequested ? (
        <p role="status" className={`text-[11px] ${FF_LOUD_WARNING_CLASS}`}>
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
                  className={`${FF_INBOX_PRIMARY_CLASS} ${pad}`}
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
                  className={`${FF_INBOX_GHOST_CLASS} ${pad}`}
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
              className={FF_INBOX_LINK_CLASS}
            >
              {EXECUTION_DECIDE_OPEN_LABEL}
            </Link>
            <span className={`font-mono text-[11px] break-all ${FF_INBOX_MUTED_CLASS}`}>
              {approval.id}
            </span>
          </div>
        );
      })}
      {affordances.waiting && affordances.approvalsLoaded && affordances.pending.length === 0 ? (
        <p className={`text-[11px] ${FF_INBOX_MUTED_CLASS}`}>
          Open{" "}
          <Link
            href={`/executions/${executionId}`}
            className={FF_INBOX_LINK_CLASS}
          >
            /executions/{executionId}
          </Link>{" "}
          for bound approval detail.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-[11px]">
          {message}
        </p>
      ) : compact ? null : (
        <p className="sr-only">{EXECUTION_DECIDE_HELP}</p>
      )}
    </div>
  );
}
