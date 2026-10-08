"use client";

import Link from "next/link";
import { TooltipText, useTooltip } from "@/components/a11y/Tooltip";
import {
  FF_STATUS_TIP_TRIGGER_CLASS,
  nestedTipActive,
} from "@/lib/a11y-tooltip";
import {
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
} from "@/lib/aesthetic-usability-density";
import { INDETERMINATE_STATUS_HELP } from "@/lib/execution-contract";
import {
  HOME_ROW_SCAN,
  homeLastRunPresentation,
  type HomeLastRunKind,
} from "@/lib/home-row-scan";
import { FF_OVERVIEW_CHIP_CLASS } from "@/lib/overview-visual";
import { workflowHomeLastRunHref } from "@/lib/product-home";
import { lastRunStatusClassName } from "@/lib/status-embed-visual";
import type { WorkflowHomeItem } from "@/lib/workflow-home";

type HomeLastRunStatusProps = {
  item: Pick<
    WorkflowHomeItem,
    | "id"
    | "lastRunId"
    | "lastRunStatus"
    | "lastRunKnown"
    | "lastRunWaiting"
    | "lastRunIndeterminate"
  >;
  canSeeLastRun: boolean;
  /**
   * The explorer row is keyboard-current. Without a link the chip has no
   * tab stop, so the row shows its help instead.
   */
  rowActive?: boolean;
};

function lastRunClassName(kind: HomeLastRunKind): string {
  const chip = "inline-flex max-w-full items-center gap-1.5";
  if (kind === "indeterminate") {
    return `${chip} ${LOUD_INDETERMINATE_CLASS}`;
  }
  if (kind === "failed") {
    return `${chip} ${LOUD_ERROR_CLASS}`;
  }
  if (kind === "unknown" || kind === "never") {
    return `${chip} ${FF_OVERVIEW_CHIP_CLASS}`;
  }
  return `${chip} ${lastRunStatusClassName(kind)}`;
}

export function HomeLastRunStatus({
  item,
  canSeeLastRun,
  rowActive = false,
}: HomeLastRunStatusProps) {
  const presentation = homeLastRunPresentation({
    status: item.lastRunStatus,
    known: item.lastRunKnown,
    waiting: item.lastRunWaiting,
    indeterminate: item.lastRunIndeterminate,
  });
  const href = canSeeLastRun
    ? workflowHomeLastRunHref({
        workflowId: item.id,
        lastRunId: item.lastRunId,
      })
    : null;
  const className = `${lastRunClassName(presentation.kind)} ${FF_STATUS_TIP_TRIGGER_CLASS}`;
  // The link is already a tab stop and its name already includes the
  // help, so keyboard focus shows that help visibly. Without a link the
  // chip adds no tab stop to the explorer row; the help stays in the
  // row text, shows on hover, and shows while the row is keyboard-current.
  const tip = useTooltip(presentation.help, {
    active: nestedTipActive({
      hasHelp: !href,
      keyboardCurrent: rowActive,
    }),
  });
  const body = (
    <>
      <span aria-hidden="true">{presentation.icon}</span>
      <span className="truncate">{presentation.label}</span>
      <TooltipText
        controls={tip}
        text={presentation.help}
        align="start"
        labelled={false}
      />
    </>
  );
  return (
    <div
      data-home-last-run="status"
      data-home-last-run-kind={presentation.kind}
      data-home-last-run-loud={presentation.loud ? "true" : "false"}
      data-home-row-scan="trail"
      data-r4-indeterminate={HOME_ROW_SCAN.loudIndeterminate}
      className="min-w-0"
    >
      {href ? (
        <Link
          href={href}
          {...tip.focusProps}
          {...tip.hoverProps}
          className={`${className} hover:opacity-90`}
        >
          {body}
        </Link>
      ) : (
        <span
          {...tip.hoverProps}
          data-home-last-run-tip="row"
          className={className}
        >
          {body}
        </span>
      )}
      {presentation.kind === "indeterminate" ? (
        <p className="mt-1 text-xs font-semibold text-fg">{INDETERMINATE_STATUS_HELP}</p>
      ) : null}
    </div>
  );
}
