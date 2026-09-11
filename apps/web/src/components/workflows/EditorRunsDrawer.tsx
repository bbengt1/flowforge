"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExecutionHistoryListbox } from "@/components/executions/ExecutionHistoryListbox";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import {
  EDITOR_RUNS_COLUMN_WIDTH,
  EDITOR_RUNS_LIST_LIMIT,
  EDITOR_RUNS_PANEL_ID,
  editorRunsCanList,
  editorRunsDisplay,
  editorRunsKeyboardHelp,
  editorRunsStatuses,
  editorRunsWorkspaceHref,
} from "@/lib/editor-runs";
import { EDITOR_RUN_OVERLAY_HELP } from "@/lib/editor-run-io";
import { listWorkflowExecutions } from "@/lib/execution-client";
import { isExecutionForbidden } from "@/lib/execution";
import type { ExecutionRecord } from "@/lib/execution-types";
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
  onClose: () => void;
  onStart: () => void;
  onSelectRun?: (executionId: string) => void;
};

export function EditorRunsDrawer({
  open,
  workflowId,
  workflowName,
  identity,
  permissions,
  canCall,
  selectedExecutionId,
  onClose,
  onStart,
  onSelectRun,
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

  if (!open) {
    return null;
  }

  return (
    <aside
      id={EDITOR_RUNS_PANEL_ID}
      aria-label="Workflow executions"
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-zinc-200 bg-white"
      style={{ width: EDITOR_RUNS_COLUMN_WIDTH }}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2">
        <p className="text-sm font-medium text-zinc-800">Runs</p>
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
        <p className="text-xs text-zinc-600">
          <code className="font-mono">GET /workflows/{"{id}"}/executions</code>
          {workflowName ? (
            <>
              {" "}
              for <span className="font-medium text-zinc-800">{workflowName}</span>
            </>
          ) : null}
          . {EDITOR_RUN_OVERLAY_HELP}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs">
            <span className="font-medium">Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              disabled={denied || !canCall || !scopedId}
              className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1 text-sm"
            >
              <option value="">Any</option>
              {editorRunsStatuses().map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending || !canCall || denied || !scopedId}
            className="rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending ? "Loading…" : "Refresh"}
          </button>
        </div>
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

        {forbidden || denied || !canCall || !scopedId ? null : visible.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-zinc-300 bg-white/60 p-4 text-center">
            <h3 className="text-sm font-semibold">No executions yet</h3>
            <p className="mt-2 text-xs text-zinc-600">
              Start a published version from the control next to this drawer.
              Drafts never run.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <ExecutionHistoryListbox
              rows={visible}
              compact
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
