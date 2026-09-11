"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExecutionHistoryListbox } from "@/components/executions/ExecutionHistoryListbox";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { EDITOR_RUN_CLEAR_LABEL } from "@/lib/editor-run-io";
import {
  EDITOR_RUNS_COLUMN_WIDTH,
  EDITOR_RUNS_LIST_LIMIT,
  EDITOR_RUNS_OPERATE_HELP,
  EDITOR_RUNS_PANEL_ID,
  EDITOR_RUNS_SATELLITE_ID,
  EDITOR_RUNS_SATELLITE_LABEL,
  EDITOR_RUNS_SATELLITE_WIDTH,
  EDITOR_RUNS_SKIP_FAILED_LABEL,
  EDITOR_RUNS_SKIP_INDETERMINATE_LABEL,
  editorRunOpenHref,
  editorRunsCanList,
  editorRunsDisplay,
  editorRunsHighlightSummary,
  editorRunsKeyboardHelp,
  editorRunsSkipTarget,
  editorRunsStatuses,
  editorRunsWorkspaceHref,
  runsChromeMode,
  type EditorRunsSkipStatus,
} from "@/lib/editor-runs";
import { listWorkflowExecutions } from "@/lib/execution-client";
import { isExecutionForbidden } from "@/lib/execution";
import type { ExecutionRecord, ExecutionStep } from "@/lib/execution-types";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";

type EditorRunsDrawerProps = {
  open: boolean;
  workflowId?: string;
  workflowName?: string;
  identity: DevIdentity;
  permissions: readonly string[] | null | undefined;
  canCall: boolean;
  selectedExecutionId?: string;
  selectedSteps?: readonly ExecutionStep[];
  waitingApprovalNodeIds?: readonly string[];
  overlayHighlightCount?: number;
  onClose: () => void;
  onOpen: () => void;
  onStart: () => void;
  onSelectRun?: (executionId: string) => void;
  onClearRun?: () => void;
  onHighlightNode?: (nodeId: string) => void;
};

export function EditorRunsDrawer({
  open,
  workflowId,
  workflowName,
  identity,
  permissions,
  canCall,
  selectedExecutionId,
  selectedSteps,
  waitingApprovalNodeIds = [],
  overlayHighlightCount = 0,
  onClose,
  onOpen,
  onStart,
  onSelectRun,
  onClearRun,
  onHighlightNode,
}: EditorRunsDrawerProps) {
  const embed = useEmbedMode();
  const [items, setItems] = useState<ExecutionRecord[]>([]);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const denied = permissions != null && !editorRunsCanList(permissions);
  const forbidden = isExecutionForbidden(problem);
  const visible = useMemo(
    () => (forbidden || denied ? [] : editorRunsDisplay(items, embed)),
    [items, forbidden, denied, embed],
  );
  const workspaceHref = editorRunsWorkspaceHref(embed);
  const scopedId = workflowId?.trim() ?? "";
  const selectedRow = visible.find((row) => row.id === selectedExecutionId);
  const chrome = runsChromeMode(open);

  async function refresh() {
    if (!scopedId) {
      return;
    }
    setPending(true);
    setProblem(null);
    const list = await listWorkflowExecutions(identity, scopedId, {
      status,
      limit: EDITOR_RUNS_LIST_LIMIT,
    });
    setPending(false);
    if (!list.ok) {
      setProblem(list.problem);
      if (list.forbidden) {
        setItems([]);
      }
      return;
    }
    setItems(list.items);
    setStrippedKeys(list.strippedKeys);
  }

  useEffect(() => {
    if (!open || !scopedId || !canCall || denied) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [open, scopedId, canCall, denied, identity, status]);

  function skipTo(skipStatus: EditorRunsSkipStatus) {
    const target = editorRunsSkipTarget({
      status: skipStatus,
      selectedSteps,
      waitingApprovalNodeIds,
      rows: visible,
      selectedExecutionId,
    });
    if (!target) {
      if (status !== skipStatus) {
        setStatus(skipStatus);
      }
      return;
    }
    if (target.kind === "node") {
      onHighlightNode?.(target.nodeId);
      return;
    }
    onSelectRun?.(target.executionId);
  }

  if (chrome === "satellite") {
    return (
      <aside
        aria-label="Workflow executions"
        data-editor-runs="satellite"
        className="flex w-full shrink-0 items-center justify-center border-zinc-200 bg-white max-md:!w-full max-md:border-b md:flex-col md:border-l"
        style={{ width: EDITOR_RUNS_SATELLITE_WIDTH }}
      >
        <button
          type="button"
          id={EDITOR_RUNS_SATELLITE_ID}
          onClick={onOpen}
          aria-expanded={false}
          aria-controls={EDITOR_RUNS_PANEL_ID}
          className="rounded-md px-2 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50 md:[writing-mode:vertical-rl] md:rotate-180 md:px-1 md:py-3"
        >
          {EDITOR_RUNS_SATELLITE_LABEL}
        </button>
      </aside>
    );
  }

  return (
    <aside
      id={EDITOR_RUNS_PANEL_ID}
      aria-label="Workflow executions"
      data-editor-runs="drawer"
      className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-zinc-200 bg-white max-md:!w-full max-md:border-b md:border-l"
      style={{ width: EDITOR_RUNS_COLUMN_WIDTH }}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2">
        <p className="text-sm font-medium text-zinc-800">
          {EDITOR_RUNS_SATELLITE_LABEL}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={!scopedId}
            className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 disabled:opacity-60"
          >
            Start published
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-expanded
            aria-controls={EDITOR_RUNS_PANEL_ID}
            className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"
          >
            Hide
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="text-xs text-zinc-600">{EDITOR_RUNS_OPERATE_HELP}</p>
        {workflowName ? (
          <p className="mt-1 text-xs text-zinc-500">
            <code className="font-mono">GET /workflows/{"{id}"}/executions</code>
            {" "}
            for <span className="font-medium text-zinc-800">{workflowName}</span>
            .
          </p>
        ) : null}

        <div className="mt-3">
          <p className="text-xs font-medium text-zinc-800">Status</p>
          <div
            role="group"
            aria-label="Status"
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            <StatusChip
              label="Any"
              active={!status}
              disabled={denied || !canCall || !scopedId}
              onClick={() => setStatus("")}
            />
            {editorRunsStatuses().map((value) => (
              <StatusChip
                key={value}
                label={value}
                active={status === value}
                disabled={denied || !canCall || !scopedId}
                onClick={() => setStatus(value)}
              />
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => skipTo("failed")}
            disabled={denied || !canCall || !scopedId}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
          >
            {EDITOR_RUNS_SKIP_FAILED_LABEL}
          </button>
          <button
            type="button"
            onClick={() => skipTo("indeterminate")}
            disabled={denied || !canCall || !scopedId}
            className="rounded-md border border-amber-700 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-950 hover:bg-amber-100 disabled:opacity-60"
          >
            {EDITOR_RUNS_SKIP_INDETERMINATE_LABEL}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending || !canCall || denied || !scopedId}
            className="rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending ? "Loading…" : "Refresh"}
          </button>
        </div>

        <p className="mt-2 text-xs" aria-live="polite">
          {pending
            ? "Loading runs…"
            : `${visible.length} run${visible.length === 1 ? "" : "s"}`}
          {status ? ` · ${status}` : ""}
        </p>

        <p className="mt-2 text-xs">
          <Link
            href={workspaceHref}
            className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
          >
            Workspace executions
          </Link>
          <span className="text-zinc-500"> — cross-workflow ops view</span>
        </p>

        {!canCall ? (
          <div className="mt-4">
            <SessionSetupHint purpose="before listing executions." />
          </div>
        ) : null}

        {!scopedId ? (
          <p className="mt-4 text-sm text-zinc-600">
            Open a workflow to list its runs.
          </p>
        ) : null}

        {denied ? (
          <p className="mt-4 text-sm text-zinc-600">
            This role cannot view executions (
            <code className="font-mono text-xs">execution.view</code> missing).
          </p>
        ) : null}

        {problem ? (
          <div className="mt-4">
            <ProblemBanner problem={problem} />
          </div>
        ) : null}
        {strippedKeys.length ? (
          <p role="status" className="mt-3 text-sm text-amber-900">
            Unexpected secret fields were stripped from the API response:{" "}
            {strippedKeys.join(", ")}. Treat this as a backend contract bug.
          </p>
        ) : null}

        {selectedRow ? (
          <section
            aria-label="Selected run"
            className={
              selectedRow.indeterminate
                ? "mt-4 rounded-xl border-2 border-amber-700 bg-amber-50 p-3"
                : "mt-4 rounded-xl border border-teal-800 bg-teal-50 p-3"
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-zinc-800">On this canvas</p>
                <p className="mt-1 font-mono text-[11px] break-all text-zinc-600">
                  {selectedRow.versionPin}
                </p>
              </div>
              <ExecutionStatusBadge status={selectedRow.status} />
            </div>
            <p className="mt-2 text-xs text-zinc-700">
              {editorRunsHighlightSummary(overlayHighlightCount)}
            </p>
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <Link
                href={editorRunOpenHref(selectedRow.id, scopedId || undefined, embed)}
                className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
              >
                Open execution
              </Link>
              {onClearRun ? (
                <button
                  type="button"
                  onClick={onClearRun}
                  className="font-medium text-zinc-700 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                >
                  {EDITOR_RUN_CLEAR_LABEL}
                </button>
              ) : null}
            </p>
          </section>
        ) : null}

        {forbidden || denied || !canCall || !scopedId ? null : visible.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-zinc-300 bg-white/60 p-4 text-center">
            <h3 className="text-sm font-semibold">
              {status ? "No runs match this filter" : "No executions yet"}
            </h3>
            <p className="mt-2 text-xs text-zinc-600">
              Start a published version from the control next to this overlay.
              Drafts never run.
            </p>
            {status ? (
              <button
                type="button"
                onClick={() => setStatus("")}
                className="mt-3 text-xs font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
              >
                Clear status filter
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mt-4">
            <ExecutionHistoryListbox
              rows={visible}
              compact
              layout="overlay"
              selectedId={selectedExecutionId}
              keyboardHelp={editorRunsKeyboardHelp()}
              onActivate={
                onSelectRun
                  ? (row) => onSelectRun(row.id)
                  : undefined
              }
            />
          </div>
        )}
      </div>
    </aside>
  );
}

function StatusChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={
        active
          ? "rounded-full border border-teal-800 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-950 disabled:opacity-60"
          : "rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      }
    >
      {label}
    </button>
  );
}
