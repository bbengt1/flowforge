import {
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
} from "@/lib/aesthetic-usability-density";
import { executionStatusPresentation } from "@/lib/execution";
import type { ExecutionStatus } from "@/lib/execution-types";

type ExecutionStatusBadgeProps = {
  status: ExecutionStatus | undefined;
};

const TONE_CLASS: Record<
  ReturnType<typeof executionStatusPresentation>["tone"],
  string
> = {
  indeterminate: LOUD_INDETERMINATE_CLASS,
  running: "ff-status-running",
  canceled: "ff-status-canceled font-semibold",
  failed: LOUD_ERROR_CLASS,
  succeeded: "ff-status-succeeded",
  queued: "ff-status-queued",
  claimed: "ff-status-claimed",
  other: "ff-status-other",
};

export function ExecutionStatusBadge({ status }: ExecutionStatusBadgeProps) {
  const presentation = executionStatusPresentation(status);

  return (
    <p
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${TONE_CLASS[presentation.tone]}`}
    >
      <span aria-hidden="true">{presentation.icon}</span>
      <span>{presentation.label}</span>
      <span className="sr-only">{presentation.description}</span>
    </p>
  );
}
