import {
  invalidationSummary,
  isApprovalExpired,
  isApprovalInvalidated,
} from "@/lib/approval";
import type { ApprovalRequest } from "@/lib/approval-types";

type ApprovalValidityBannerProps = {
  approval: ApprovalRequest;
};

export function ApprovalValidityBanner({ approval }: ApprovalValidityBannerProps) {
  const expired = isApprovalExpired(approval);
  const invalidated = isApprovalInvalidated(approval);
  if (!expired && !invalidated && approval.validity.current) {
    return null;
  }

  const title = expired
    ? "Approval expired"
    : invalidated
      ? "Approval invalidated"
      : "Approval is not current";
  const detail =
    invalidationSummary(approval) ||
    "Server-side recheck failed closed. A prior local approval is not sufficient.";

  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1">{detail}</p>
      <p className="mt-2 text-xs text-rose-900/80">
        Authorization is rechecked on the server. Approve and reject stay
        disabled until a new evaluation produces a current pending request.
      </p>
    </div>
  );
}
