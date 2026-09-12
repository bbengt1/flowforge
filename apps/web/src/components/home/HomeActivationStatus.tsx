import Link from "next/link";
import {
  HOME_ACTIVATION,
  homeActivationLooksLive,
  type HomeActivationColumn,
} from "@/lib/home-activation";

type HomeActivationStatusProps = {
  column: HomeActivationColumn;
};

export function HomeActivationStatus({ column }: HomeActivationStatusProps) {
  const live = homeActivationLooksLive(column);
  return (
    <div
      data-home-activation="status"
      data-home-activation-kind={column.kind}
      data-home-activation-live={live ? "true" : "false"}
      data-home-activation-draft-live={column.draftLooksLive ? "true" : "false"}
      data-home-activation-known={column.known ? "true" : "false"}
      data-r6-d2={HOME_ACTIVATION.d2ComposeEnablePlusVersionPin}
      data-r6-d3={HOME_ACTIVATION.d3TriggersStayWorkflowLevel}
      className="min-w-0"
    >
      <Link
        href={column.href}
        title={column.help}
        className={
          live
            ? "inline-flex max-w-full items-center rounded-full border border-teal-800 bg-teal-50 px-2.5 py-0.5 text-sm font-medium text-teal-900 hover:bg-teal-100"
            : "inline-flex max-w-full items-center rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
        }
      >
        <span className="truncate">{column.label}</span>
      </Link>
    </div>
  );
}
