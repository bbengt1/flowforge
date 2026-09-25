import { StatusMark } from "@/components/chrome/StatusMark";
import {
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
} from "@/lib/aesthetic-usability-density";
import { executionStatusPresentationInRun } from "@/lib/execution";
import type { ExecutionStatus } from "@/lib/execution-types";
import { executionStatusToneClass } from "@/lib/status-embed-visual";

type ExecutionStatusBadgeProps = {
  status: ExecutionStatus | undefined;
  /** Parent run status. Presentation-only; does not change retry or cancel. */
  runStatus?: ExecutionStatus;
  /** Jobs for this step. A blocked job on a failed run displays as Not reached. */
  siblingJobStatuses?: readonly string[];
};

export function ExecutionStatusBadge({
  status,
  runStatus,
  siblingJobStatuses,
}: ExecutionStatusBadgeProps) {
  const presentation = executionStatusPresentationInRun(
    status,
    runStatus,
    siblingJobStatuses,
  );
  const toneClass =
    presentation.tone === "indeterminate"
      ? LOUD_INDETERMINATE_CLASS
      : presentation.tone === "failed"
        ? LOUD_ERROR_CLASS
        : executionStatusToneClass(presentation.tone);

  return (
    <StatusMark
      icon={presentation.icon}
      label={presentation.label}
      description={presentation.description}
      className={`rounded-full px-2.5 py-0.5 text-xs ${toneClass}`}
    />
  );
}
