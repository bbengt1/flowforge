import Link from "next/link";
import {
  HOME_ACTIVATION,
  homeActivationLooksLive,
  type HomeActivationColumn,
} from "@/lib/home-activation";
import {
  FF_OVERVIEW_CHIP_ACCENT_CLASS,
  FF_OVERVIEW_CHIP_CLASS,
} from "@/lib/overview-visual";
import { activationStatusPresentation } from "@/lib/rewrite-satellite-a11y";

type HomeActivationStatusProps = {
  column: HomeActivationColumn;
};

export function HomeActivationStatus({ column }: HomeActivationStatusProps) {
  const live = homeActivationLooksLive(column);
  const presentation = activationStatusPresentation({
    live,
    label: column.label,
  });
  return (
    <div
      data-home-activation="status"
      data-home-activation-kind={column.kind}
      data-home-activation-live={live ? "true" : "false"}
      data-home-activation-draft-live={column.draftLooksLive ? "true" : "false"}
      data-home-activation-known={column.known ? "true" : "false"}
      data-home-row-scan="lead"
      data-home-working-memory="published"
      data-r6-d2={HOME_ACTIVATION.d2ComposeEnablePlusVersionPin}
      data-r6-d3={HOME_ACTIVATION.d3TriggersStayWorkflowLevel}
      className="min-w-0"
    >
      <Link
        href={column.href}
        title={column.help}
        className={
          live
            ? `max-w-full gap-1.5 ${FF_OVERVIEW_CHIP_ACCENT_CLASS}`
            : `max-w-full gap-1.5 ${FF_OVERVIEW_CHIP_CLASS}`
        }
      >
        <span aria-hidden="true">{presentation.icon}</span>
        <span className="truncate">{presentation.label}</span>
        <span className="sr-only">{presentation.description}</span>
      </Link>
    </div>
  );
}
