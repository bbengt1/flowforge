"use client";

import Link from "next/link";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import {
  EDITOR_RUN_CLEAR_LABEL,
  EDITOR_RUN_IO_PENDING_HELP,
  EDITOR_RUN_NO_STEP_HELP,
} from "@/lib/editor-run-io";
import {
  NDV_RUN_IO_JUMP_HELP,
  NDV_RUN_IO_JUMP_LABEL,
  NDV_RUN_IO_OPERATE_HELP,
  NDV_RUN_IO_PAYLOAD_GAP_HELP,
  ndvRunIoJumpTarget,
  ndvRunIoView,
  type NdvRunIoContextSource,
} from "@/lib/editor-ndv-run-io";
import { INDETERMINATE_STATUS_HELP } from "@/lib/execution-contract";
import {
  isSshRunType,
  parseSshRetryResult,
  sshIndeterminateCopy,
} from "@/lib/ssh-retry-contract";
import {
  isScriptIoActionType,
  parseScriptIoRetryResult,
  scriptIndeterminateCopy,
} from "@/lib/script-io-contract";
import type { ExecutionDetail, ExecutionLogSlice } from "@/lib/execution-types";
import type { ProblemDetails } from "@/lib/problem";
import { ProblemBanner } from "@/components/ProblemBanner";

export type LastRunIoPanelProps = {
  detail: ExecutionDetail | null;
  nodeId?: string | null;
  source?: NdvRunIoContextSource | null;
  logs?: ExecutionLogSlice | null;
  waitingApprovalNodeIds?: readonly string[];
  pending?: boolean;
  problem?: ProblemDetails | null;
  strippedKeys?: readonly string[];
  onClear?: () => void;
  onJumpNode?: (nodeId: string) => void;
};

export function LastRunIoPanel({
  detail,
  nodeId,
  source = null,
  logs,
  waitingApprovalNodeIds = [],
  pending = false,
  problem = null,
  strippedKeys = [],
  onClear,
  onJumpNode,
}: LastRunIoPanelProps) {
  const embed = useEmbedMode();
  const scopedNode = nodeId?.trim() ?? "";
  const view = ndvRunIoView({
    detail,
    nodeId: scopedNode,
    source,
    logs,
    waitingApprovalNodeIds,
    embed,
  });
  const io = view.io;
  const indeterminateCopy = io?.step
    ? isSshRunType(io.step.nodeType)
      ? sshIndeterminateCopy({
          status: io.status,
          nodeType: io.step.nodeType,
          verificationOutcome: parseSshRetryResult(
            io.step.output,
            io.step.error,
            io.step.input,
          )?.verificationOutcome,
        })
      : isScriptIoActionType(io.step.nodeType)
        ? scriptIndeterminateCopy({
            status: io.status,
            nodeType: io.step.nodeType,
            errorCode: parseScriptIoRetryResult(
              io.step.output,
              io.step.error,
              io.step.input,
            )?.verificationOutcome,
          })
        : INDETERMINATE_STATUS_HELP
    : INDETERMINATE_STATUS_HELP;

  if (!detail && !pending && !problem && !scopedNode) {
    return null;
  }

  return (
    <section
      aria-labelledby="last-run-io-heading"
      data-ndv-run-io={view.source || "empty"}
      data-ndv-run-io-source={view.source || ""}
      className={
        io?.indeterminate
          ? "rounded-2xl border-2 border-amber-700 bg-amber-50 p-5"
          : "rounded-2xl border border-zinc-200 bg-white p-5"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="last-run-io-heading" className="text-base font-semibold">
            Last run
          </h3>
          <p className="mt-1 text-xs text-zinc-600">{NDV_RUN_IO_OPERATE_HELP}</p>
          <p className="mt-1 text-xs text-zinc-500">{view.help}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view.source ? (
            <span className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700">
              {view.sourceLabel}
            </span>
          ) : null}
          {detail || view.runStatus ? (
            <ExecutionStatusBadge status={view.runStatus || detail?.status} />
          ) : null}
          {onClear ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"
            >
              {EDITOR_RUN_CLEAR_LABEL}
            </button>
          ) : null}
        </div>
      </div>
      {detail ? (
        <>
          <p className="mt-2 font-mono text-xs break-all text-zinc-600">
            {detail.id}
            {view.workflowVersionLabel ? ` · ${view.workflowVersionLabel}` : ""}
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            {view.startedLabel} · {view.durationLabel}
          </p>
          {view.opsHref ? (
            <p className="mt-1">
              <Link
                href={view.opsHref}
                className="text-xs font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
              >
                Open execution
              </Link>
              <span className="text-xs text-zinc-500">
                {" "}
                — /executions/{"{id}"}
              </span>
            </p>
          ) : null}
        </>
      ) : null}

      {pending ? (
        <p role="status" className="mt-3 text-sm text-zinc-600">
          {EDITOR_RUN_IO_PENDING_HELP}
        </p>
      ) : null}
      {problem ? (
        <div className="mt-3">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}
      {strippedKeys.length ? (
        <p role="status" className="mt-3 text-sm text-amber-900">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      {view.jumpLinks.length ? (
        <nav aria-label="Failed and indeterminate steps" className="mt-3">
          <p className="text-xs font-medium text-zinc-600">{NDV_RUN_IO_JUMP_HELP}</p>
          <ul className="mt-1 space-y-1">
            {view.jumpLinks.map((link) => {
              const target = ndvRunIoJumpTarget(link);
              return (
                <li key={`${link.id}-${link.label}`}>
                  {target && onJumpNode ? (
                    <button
                      type="button"
                      data-ndv-run-io-jump={target}
                      onClick={() => onJumpNode(target)}
                      className="text-xs font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                    >
                      {link.label} — {NDV_RUN_IO_JUMP_LABEL}
                    </button>
                  ) : (
                    <span className="text-xs text-zinc-700">{link.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {!scopedNode ? (
        <p className="mt-3 text-sm text-zinc-600">
          Select a node to see redacted last-run outputs and logs.
        </p>
      ) : null}

      {view.empty && scopedNode && !pending && !problem ? (
        <p className="mt-3 text-sm text-zinc-600">{view.help}</p>
      ) : null}

      {io?.missingStep ? (
        <p className="mt-3 text-sm text-zinc-600">{EDITOR_RUN_NO_STEP_HELP}</p>
      ) : null}

      {view.payloadGap ? (
        <p role="status" className="mt-3 text-sm text-amber-950">
          {NDV_RUN_IO_PAYLOAD_GAP_HELP}
        </p>
      ) : null}

      {io && !io.missingStep ? (
        <div className="mt-3 space-y-3">
          {view.stepMeta ? (
            <p className="font-mono text-xs text-zinc-600">{view.stepMeta}</p>
          ) : null}
          {io.indeterminate ? (
            <p className="text-sm text-amber-950">{indeterminateCopy}</p>
          ) : null}
          {io.view?.waiting ? (
            <p role="status" className="text-sm text-zinc-800">
              Waiting on approval. Decide the bound approval — resume is decide,
              not a new route.
            </p>
          ) : null}
          <div>
            <p className="text-xs font-medium text-zinc-600">Redacted input</p>
            <pre className="mt-1 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
              {io.inputText}
            </pre>
          </div>
          <div>
            <p className="text-xs font-medium text-zinc-600">Redacted output</p>
            <pre className="mt-1 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
              {io.outputText}
            </pre>
          </div>
          {io.errorText && io.errorText !== "—" ? (
            <div>
              <p className="text-xs font-medium text-zinc-600">Redacted error</p>
              <pre className="mt-1 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
                {io.errorText}
              </pre>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-medium text-zinc-600">Redacted logs</p>
            <pre className="mt-1 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
              {io.logsText}
            </pre>
          </div>
          <p className="text-xs text-zinc-500">
            {io.redactedHelp} Secrets stay{" "}
            <code className="font-mono text-[11px]">[redacted]</code>.
          </p>
        </div>
      ) : null}
    </section>
  );
}
