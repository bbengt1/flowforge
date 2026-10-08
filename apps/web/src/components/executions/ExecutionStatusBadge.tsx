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
  /** Inside an interactive row: no tab stop of its own. See StatusMark. */
  nested?: boolean;
  /** Help that the row owns, shown instead of the status help. */
  help?: string;
  /** The row opens the tooltip. See StatusMark. */
  tipActive?: boolean;
};

export function ExecutionStatusBadge({
  status,
  runStatus,
  siblingJobStatuses,
  nested = false,
  help,
  tipActive = false,
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
      description={help ?? presentation.description}
      nested={nested}
      tipActive={tipActive}
      className={`rounded-full px-2.5 py-0.5 text-xs ${toneClass}`}
    />
  );
}
