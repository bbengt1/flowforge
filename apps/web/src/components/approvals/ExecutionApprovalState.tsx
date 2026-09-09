import Link from "next/link";
import { ApprovalBindingSnapshot } from "@/components/approvals/ApprovalBindingSnapshot";
import { ApprovalValidityBanner } from "@/components/approvals/ApprovalValidityBanner";
import { approvalStatusLabel, isExecutionAwaitingApproval } from "@/lib/approval";
import type { ApprovalRequest } from "@/lib/approval-types";

type ExecutionApprovalStateProps = {
  executionStatus: string;
  approvals: ApprovalRequest[];
};

export function ExecutionApprovalState({
  executionStatus,
  approvals,
}: ExecutionApprovalStateProps) {
  const waiting = isExecutionAwaitingApproval(executionStatus);
  if (!waiting && approvals.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="execution-approval-heading"
      className="rounded-xl border border-zinc-200 bg-white px-4 py-3"
    >
      <h3 id="execution-approval-heading" className="text-sm font-semibold">
        Execution approval state
      </h3>
      <p className="mt-1 text-sm text-zinc-600">
        {waiting
          ? "This pin is waiting on a current approval. Dispatch does not proceed on a stale decision."
          : "Approvals bound to this execution."}
      </p>
      <ul className="mt-3 space-y-3">
        {approvals.map((item) => (
          <li key={item.id} className="space-y-2">
            <p className="text-sm font-medium">
              {approvalStatusLabel(item.status)} ·{" "}
              <Link
                href={`/approvals/${item.id}`}
                className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
              >
                {item.id}
              </Link>
            </p>
            <ApprovalValidityBanner approval={item} />
            <ApprovalBindingSnapshot binding={item.binding} />
          </li>
        ))}
      </ul>
    </section>
  );
}
