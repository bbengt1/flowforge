"use client";

import { useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  approvalDecideControlsState,
  failClosedProblemTitle,
  problemClosesApproval,
} from "@/lib/approval";
import { isTerminalRunStatus } from "@/lib/execution";
import {
  APPROVAL_CLOSED_MESSAGE,
  retryProblemShouldRefetch,
} from "@/lib/execution-retry";
import { approveApproval, rejectApproval } from "@/lib/approval-client";
import {
  APPROVAL_DECIDE_HELP,
  APPROVAL_SOD_HELP,
} from "@/lib/approval-contract";
import type { ApprovalRequest } from "@/lib/approval-types";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";

type ApprovalDecideControlsProps = {
  identity: DevIdentity;
  approval: ApprovalRequest;
  actorUserId: string;
  permissions?: string[] | null;
  onUpdated?: (approval: ApprovalRequest) => void;
  onRefetch?: () => void;
};

export function ApprovalDecideControls({
  identity,
  approval,
  actorUserId,
  permissions,
  onUpdated,
  onRefetch,
}: ApprovalDecideControlsProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const { canDecide, selfRequested } = approvalDecideControlsState(
    approval,
    actorUserId,
    permissions,
  );
  const offerDecision =
    approval.status === "pending" &&
    !isTerminalRunStatus(approval.executionStatus);

  async function decide(action: "approve" | "reject") {
    setPending(action);
    setProblem(null);
    const result =
      action === "approve"
        ? await approveApproval(identity, approval.id, note)
        : await rejectApproval(identity, approval.id, note);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      if (retryProblemShouldRefetch(result.problem)) {
        onRefetch?.();
      }
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
    setNote("");
    onUpdated?.(result.approval);
  }

  return (
    <div className="space-y-3">
      {problem?.code === "approval_closed" ? (
        <p role="status" className="text-sm text-[var(--ff-text)]">
          {APPROVAL_CLOSED_MESSAGE}
        </p>
      ) : problem ? (
        <ProblemBanner
          problem={{
            ...problem,
            title: failClosedProblemTitle(problem),
          }}
        />
      ) : null}
      {approval.status === "canceled" ? (
        <p role="status" className="text-sm text-[var(--ff-text)]">
          {APPROVAL_CLOSED_MESSAGE}
        </p>
      ) : null}
      {offerDecision && selfRequested ? (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          You requested this approval. Another operator with{" "}
          <code className="font-mono text-xs">approval.decide</code> must
          approve or reject it. Self-approval is forbidden.
        </p>
      ) : null}
      {offerDecision && !selfRequested ? (
        <label className="block text-sm">
          <span className="text-[var(--ff-muted)]">Decision note</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-[var(--ff-border)] bg-[var(--ff-canvas)] px-3 py-2 text-sm text-[var(--ff-text)]"
          />
        </label>
      ) : null}
      {offerDecision && !selfRequested ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void decide("approve")}
            disabled={!canDecide || pending !== null}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
          >
            {pending === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => void decide("reject")}
            disabled={!canDecide || pending !== null}
            className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-surface)] px-3 py-1.5 text-sm text-[var(--ff-text)] hover:bg-[var(--ff-canvas)] disabled:opacity-60"
          >
            {pending === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      ) : null}
      {offerDecision ? (
        <p className="text-xs text-[var(--ff-muted)]">
          {APPROVAL_SOD_HELP} {APPROVAL_DECIDE_HELP}
        </p>
      ) : null}
    </div>
  );
}
