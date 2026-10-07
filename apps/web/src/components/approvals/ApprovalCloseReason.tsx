import { approvalClosedExplanation } from "@/lib/approval";

type ApprovalCloseReasonProps = {
  status: string;
  closeReason?: string;
  closeReasonCause?: string;
  runStatus?: string;
};

/** Real text next to a closed approval. Unknown reasons render nothing. */
export function ApprovalCloseReason({
  status,
  closeReason,
  closeReasonCause,
  runStatus,
}: ApprovalCloseReasonProps) {
  const sentence = approvalClosedExplanation({
    status,
    closeReason,
    closeReasonCause,
    runStatus,
  });
  if (!sentence) {
    return null;
  }
  return <p className="text-sm text-inherit">{sentence}</p>;
}
