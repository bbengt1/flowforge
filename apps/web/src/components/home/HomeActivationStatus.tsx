"use client";

import Link from "next/link";
import { TooltipText, useTooltip } from "@/components/a11y/Tooltip";
import { FF_STATUS_TIP_TRIGGER_CLASS } from "@/lib/a11y-tooltip";
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
  // The link is already a tab stop. Its activation help shows as the
  // shared tooltip on keyboard focus and hover, and is the link's
  // description, instead of a native title. The bubble sits beside the
  // link, not inside it, so the help stays out of the link's name.
  const tip = useTooltip(column.help);
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
      {...tip.hoverProps}
      className={`min-w-0 ${FF_STATUS_TIP_TRIGGER_CLASS}`}
    >
      <Link
        href={column.href}
        {...tip.describedBy}
        {...tip.focusProps}
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
      <TooltipText controls={tip} text={column.help} align="start" />
    </div>
  );
}
