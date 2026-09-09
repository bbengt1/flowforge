import Link from "next/link";
import { ApprovalBindingSnapshot } from "@/components/approvals/ApprovalBindingSnapshot";
import { ApprovalDecideControls } from "@/components/approvals/ApprovalDecideControls";
import { ApprovalValidityBanner } from "@/components/approvals/ApprovalValidityBanner";
import { approvalStatusLabel, isExecutionAwaitingApproval } from "@/lib/approval";
import {
  APPROVAL_BINDING_HELP,
  APPROVAL_WAIT_DURABLE_HELP,
} from "@/lib/approval-contract";
import type { ApprovalRequest } from "@/lib/approval-types";
import { approvalWaitControls } from "@/lib/execution-replay";
import type { DevIdentity } from "@/lib/identity-headers";

type ExecutionApprovalStateProps = {
  executionStatus: string;
  approvals: ApprovalRequest[];
  identity?: DevIdentity;
  actorUserId?: string;
  permissions?: string[] | null;
  onApprovalUpdated?: (approval: ApprovalRequest) => void;
};

export function ExecutionApprovalState({
  executionStatus,
  approvals,
  identity,
  actorUserId = "",
  permissions,
  onApprovalUpdated,
}: ExecutionApprovalStateProps) {
  const waiting = isExecutionAwaitingApproval(executionStatus);
  const waitControls = approvalWaitControls();
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
          ? "This pin is waiting on a current approval. Dispatch does not proceed on a stale decision. The wait state survives worker or pod loss."
          : "Approvals bound to this execution."}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{APPROVAL_BINDING_HELP}</p>
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
            {identity && item.status === "pending" ? (
              <ApprovalDecideControls
                identity={identity}
                approval={item}
                actorUserId={actorUserId}
                permissions={permissions}
                onUpdated={onApprovalUpdated}
              />
            ) : (
              <p className="text-sm">
                <Link
                  href={`/approvals/${item.id}`}
                  className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                >
                  Open {item.id}
                </Link>
              </p>
            )}
          </li>
        ))}
      </ul>
      {waitControls.waitEnabled ? (
        <p role="status" className="mt-4 text-sm text-zinc-700">
          {APPROVAL_WAIT_DURABLE_HELP}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled
            title={waitControls.waitHelp}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Wait for approval
          </button>
          <button
            type="button"
            disabled
            title={waitControls.resumeHelp}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Resume
          </button>
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-500">{waitControls.resumeHelp}</p>
    </section>
  );
}
