import Link from "next/link";
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
import { workflowHomeLastRunHref } from "@/lib/product-home";
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
};

function lastRunClassName(kind: HomeLastRunKind): string {
  const chip = "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium";
  if (kind === "indeterminate") {
    return `${chip} ${LOUD_INDETERMINATE_CLASS}`;
  }
  if (kind === "waiting") {
    return `${chip} border-2 border-indigo-700 bg-indigo-50 text-indigo-950`;
  }
  if (kind === "failed") {
    return `${chip} ${LOUD_ERROR_CLASS}`;
  }
  return `${chip} border border-zinc-300 bg-zinc-50 text-zinc-700`;
}

export function HomeLastRunStatus({
  item,
  canSeeLastRun,
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
  const className = lastRunClassName(presentation.kind);
  const body = (
    <>
      <span aria-hidden="true">{presentation.icon}</span>
      <span className="truncate">{presentation.label}</span>
      <span className="sr-only">{presentation.help}</span>
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
        <Link href={href} title={presentation.help} className={`${className} hover:opacity-90`}>
          {body}
        </Link>
      ) : (
        <span title={presentation.help} className={className}>
          {body}
        </span>
      )}
      {presentation.kind === "indeterminate" ? (
        <p className="mt-1 text-xs text-amber-950">{INDETERMINATE_STATUS_HELP}</p>
      ) : null}
    </div>
  );
}
