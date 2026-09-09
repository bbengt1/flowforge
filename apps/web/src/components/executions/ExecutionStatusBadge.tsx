import {
  executionStatusLabel,
  isIndeterminateStatus,
} from "@/lib/execution";
import type { ExecutionStatus } from "@/lib/execution-types";

type ExecutionStatusBadgeProps = {
  status: ExecutionStatus | undefined;
};

export function ExecutionStatusBadge({ status }: ExecutionStatusBadgeProps) {
  const label = executionStatusLabel(status);
  const indeterminate = isIndeterminateStatus(status);

  if (indeterminate) {
    return (
      <p
        role="status"
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-700 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-950"
      >
        <span aria-hidden="true">⚠</span>
        <span>Indeterminate</span>
        <span className="sr-only">
          Unverified remote side effects may have occurred. Do not assume the
          action did not run.
        </span>
      </p>
    );
  }

  return (
    <p className="inline-flex items-center rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-800">
      {label}
    </p>
  );
}
