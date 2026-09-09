import { executionStatusPresentation } from "@/lib/execution";
import type { ExecutionStatus } from "@/lib/execution-types";

type ExecutionStatusBadgeProps = {
  status: ExecutionStatus | undefined;
};

const TONE_CLASS: Record<
  ReturnType<typeof executionStatusPresentation>["tone"],
  string
> = {
  indeterminate:
    "border-amber-700 bg-amber-50 text-amber-950 font-semibold border-2",
  running: "border-sky-700 bg-sky-50 text-sky-950 font-semibold",
  canceled: "border-zinc-700 bg-zinc-100 text-zinc-950 font-semibold",
  failed: "border-rose-700 bg-rose-50 text-rose-950 font-semibold",
  succeeded: "border-emerald-700 bg-emerald-50 text-emerald-950",
  queued: "border-zinc-400 bg-zinc-50 text-zinc-800",
  claimed: "border-indigo-700 bg-indigo-50 text-indigo-950 font-semibold",
  other: "border-zinc-300 bg-zinc-50 text-zinc-800",
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
