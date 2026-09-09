import { alertSeverityPresentation } from "@/lib/alert";
import type { AlertKind, AlertSeverity } from "@/lib/alert-types";

type AlertSeverityBadgeProps = {
  severity: AlertSeverity | undefined;
  kind?: AlertKind;
};

const TONE_CLASS: Record<
  ReturnType<typeof alertSeverityPresentation>["tone"],
  string
> = {
  critical: "border-rose-800 bg-rose-50 text-rose-950 font-semibold border-2",
  warning: "border-amber-700 bg-amber-50 text-amber-950 font-semibold",
  other: "border-zinc-300 bg-zinc-50 text-zinc-800",
};

export function AlertSeverityBadge({
  severity,
  kind,
}: AlertSeverityBadgeProps) {
  const presentation = alertSeverityPresentation(severity, kind);

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
