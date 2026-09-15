import { StatusMark } from "@/components/chrome/StatusMark";
import {
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
} from "@/lib/aesthetic-usability-density";
import { executionStatusPresentation } from "@/lib/execution";
import type { ExecutionStatus } from "@/lib/execution-types";
import { executionStatusToneClass } from "@/lib/status-embed-visual";

type ExecutionStatusBadgeProps = {
  status: ExecutionStatus | undefined;
};

export function ExecutionStatusBadge({ status }: ExecutionStatusBadgeProps) {
  const presentation = executionStatusPresentation(status);
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
