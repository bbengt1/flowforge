import {
  APPROVAL_VALIDITY_BANNER_HELP,
  approvalValidityBannerState,
} from "@/lib/approval";
import type { ApprovalRequest } from "@/lib/approval-types";

type ApprovalValidityBannerProps = {
  approval: ApprovalRequest;
};

export function ApprovalValidityBanner({ approval }: ApprovalValidityBannerProps) {
  const banner = approvalValidityBannerState(approval);
  if (!banner.visible) {
    return null;
  }

  return (
    <div
      role={banner.role}
      className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950"
    >
      <p className="font-medium">{banner.title}</p>
      <p className="mt-1">{banner.detail}</p>
      <p className="mt-2 text-xs text-rose-900/80">
        {APPROVAL_VALIDITY_BANNER_HELP}
      </p>
    </div>
  );
}
