import { StatusMark } from "@/components/chrome/StatusMark";
import { alertSeverityPresentation } from "@/lib/alert";
import type { AlertKind, AlertSeverity } from "@/lib/alert-types";
import {
  LOUD_ERROR_CLASS,
  LOUD_WARNING_CLASS,
} from "@/lib/aesthetic-usability-density";
import { FF_STATUS_OTHER_CLASS } from "@/lib/status-embed-visual";

type AlertSeverityBadgeProps = {
  severity: AlertSeverity | undefined;
  kind?: AlertKind;
};

const TONE_CLASS: Record<
  ReturnType<typeof alertSeverityPresentation>["tone"],
  string
> = {
  critical: LOUD_ERROR_CLASS,
  warning: LOUD_WARNING_CLASS,
  other: FF_STATUS_OTHER_CLASS,
};

export function AlertSeverityBadge({
  severity,
  kind,
}: AlertSeverityBadgeProps) {
  const presentation = alertSeverityPresentation(severity, kind);

  return (
    <StatusMark
      icon={presentation.icon}
      label={presentation.label}
      description={presentation.description}
      className={`rounded-full px-2.5 py-0.5 text-xs ${TONE_CLASS[presentation.tone]}`}
    />
  );
}
