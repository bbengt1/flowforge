"use client";

import { useState } from "react";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  approvalDecideControlsState,
  failClosedProblemTitle,
  problemClosesApproval,
} from "@/lib/approval";
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
};

export function ApprovalDecideControls({
  identity,
  approval,
  actorUserId,
  permissions,
  onUpdated,
}: ApprovalDecideControlsProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const { canDecide, selfRequested } = approvalDecideControlsState(
    approval,
    actorUserId,
    permissions,
  );

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
      {problem ? (
        <ProblemBanner
          problem={{
            ...problem,
            title: failClosedProblemTitle(problem),
          }}
        />
      ) : null}
      {selfRequested ? (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          You requested this approval. Another operator with{" "}
          <code className="font-mono text-xs">approval.decide</code> must
          approve or reject it. Self-approval is forbidden.
        </p>
      ) : (
        <label className="block text-sm">
          <span className="text-zinc-600">Decision note</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
          />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {selfRequested ? null : (
          <>
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
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
            >
              {pending === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        {APPROVAL_SOD_HELP} {APPROVAL_DECIDE_HELP}
      </p>
    </div>
  );
}
