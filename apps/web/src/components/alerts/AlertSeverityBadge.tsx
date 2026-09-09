import { alertSeverityPresentation } from "@/lib/alert";
import type { AlertSeverity } from "@/lib/alert-types";

type AlertSeverityBadgeProps = {
  severity: AlertSeverity | undefined;
};

const TONE_CLASS: Record<
  ReturnType<typeof alertSeverityPresentation>["tone"],
  string
> = {
  critical: "border-rose-800 bg-rose-50 text-rose-950 font-semibold border-2",
  high: "border-orange-700 bg-orange-50 text-orange-950 font-semibold",
  medium: "border-amber-700 bg-amber-50 text-amber-950 font-semibold",
  low: "border-zinc-400 bg-zinc-50 text-zinc-800",
  info: "border-sky-600 bg-sky-50 text-sky-950",
  other: "border-zinc-300 bg-zinc-50 text-zinc-800",
};

export function AlertSeverityBadge({ severity }: AlertSeverityBadgeProps) {
  const presentation = alertSeverityPresentation(severity);

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
