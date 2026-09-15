"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExecutionDecideActions } from "@/components/executions/ExecutionDecideActions";
import { ExecutionHistoryListbox } from "@/components/executions/ExecutionHistoryListbox";
import { ExecutionOperateActions } from "@/components/executions/ExecutionOperateActions";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { PeakEndEnding } from "@/components/chrome/PeakEndEnding";
import { EDITOR_RUN_CLEAR_LABEL } from "@/lib/editor-run-io";
import {
  peakEndHeadline,
  peakEndKind,
  peakEndSurfaceClassName,
} from "@/lib/peak-end-operate-endings";
import {
  SATELLITE_BODY_PAD_CLASS,
  SATELLITE_HEADER_CLASS,
  SATELLITE_HIDE_BUTTON_CLASS,
  SATELLITE_RAIL_BUTTON_CLASS,
  SATELLITE_TITLE_CLASS,
  TYPE_CAPTION_CLASS,
} from "@/lib/aesthetic-usability-density";
import {
  FF_EDITOR_CHIP_ACCENT_CLASS,
  FF_EDITOR_CHIP_CLASS,
  FF_EDITOR_GHOST_CLASS,
  FF_EDITOR_LINK_CLASS,
  FF_EDITOR_MUTED_CLASS,
  FF_EDITOR_PANEL_CLASS,
  FF_EDITOR_SATELLITE_CLASS,
  FF_EDITOR_TITLE_CLASS,
} from "@/lib/editor-visual";
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
import { isExecutionAwaitingApproval } from "@/lib/approval";
import { listExecutionApprovals } from "@/lib/approval-client";
import type { ApprovalRequest } from "@/lib/approval-types";
import { listWorkflowExecutions, loadExecutionHistory } from "@/lib/execution-client";
import { isExecutionForbidden } from "@/lib/execution";
import { executionDecideShouldLoadApprovals } from "@/lib/execution-decide";
import { executionOperateShouldLoadDetail } from "@/lib/execution-operate";
import type {
  ExecutionDetail,
  ExecutionRecord,
  ExecutionStep,
} from "@/lib/execution-types";
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
  selectedExecution?: ExecutionDetail | null;
  selectedSteps?: readonly ExecutionStep[];
  waitingApprovalNodeIds?: readonly string[];
  overlayHighlightCount?: number;
  onClose: () => void;
  onOpen: () => void;
  onStart: () => void;
  onSelectRun?: (executionId: string) => void;
  onClearRun?: () => void;
  onHighlightNode?: (nodeId: string) => void;
  onOperated?: (executionId: string) => void;
};

export function EditorRunsDrawer({
  open,
  workflowId,
  workflowName,
  identity,
  permissions,
  canCall,
  selectedExecutionId,
  selectedExecution,
  selectedSteps,
  waitingApprovalNodeIds = [],
  overlayHighlightCount = 0,
  onClose,
  onOpen,
  onStart,
  onSelectRun,
  onClearRun,
  onHighlightNode,
  onOperated,
}: EditorRunsDrawerProps) {
  const embed = useEmbedMode();
  const { current } = useWorkspace();
  const actorUserId = current?.principal.id ?? "";
  const [items, setItems] = useState<ExecutionRecord[]>([]);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [operateDetails, setOperateDetails] = useState<
    Record<string, ExecutionDetail>
  >({});
  const [decideApprovals, setDecideApprovals] = useState<
    Record<string, ApprovalRequest[]>
  >({});
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
  const selectedPeakEnd = peakEndKind(
    selectedExecution?.status ?? selectedRow?.status,
    isExecutionAwaitingApproval(
      selectedExecution?.status ?? selectedRow?.status,
    ),
  );

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
    void loadOperateDetails(list.items);
    void loadDecideApprovals(list.items);
  }

  async function loadOperateDetails(rows: readonly ExecutionRecord[]) {
    const needed = rows.filter(executionOperateShouldLoadDetail);
    if (needed.length === 0) {
      return;
    }
    const results = await Promise.all(
      needed.map((row) => loadExecutionHistory(identity, row.id, scopedId)),
    );
    setOperateDetails((currentDetails) => {
      const next = { ...currentDetails };
      for (const result of results) {
        if (result.ok) {
          next[result.execution.id] = result.execution;
        }
      }
      return next;
    });
  }

  async function loadDecideApprovals(rows: readonly ExecutionRecord[]) {
    const needed = rows.filter(executionDecideShouldLoadApprovals);
    if (needed.length === 0) {
      return;
    }
    const results = await Promise.all(
      needed.map(async (row) => ({
        id: row.id,
        result: await listExecutionApprovals(identity, scopedId, row.id),
      })),
    );
    setDecideApprovals((currentApprovals) => {
      const next = { ...currentApprovals };
      for (const { id, result } of results) {
        if (result.ok) {
          next[id] = result.items;
        }
      }
      return next;
    });
  }

  function operateDetailFor(executionId: string): ExecutionDetail | undefined {
    if (selectedExecution?.id === executionId) {
      return selectedExecution;
    }
    return operateDetails[executionId];
  }

  function handleOperated(executionId: string) {
    void refresh();
    onOperated?.(executionId);
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
        data-uxl8="runs"
        className={`flex w-full shrink-0 items-center justify-center border max-md:!w-full max-md:border-b md:flex-col md:border-l ${FF_EDITOR_SATELLITE_CLASS}`}
        style={{ width: EDITOR_RUNS_SATELLITE_WIDTH }}
      >
        <button
          type="button"
          id={EDITOR_RUNS_SATELLITE_ID}
          onClick={onOpen}
          aria-expanded={false}
          aria-controls={EDITOR_RUNS_PANEL_ID}
          className={SATELLITE_RAIL_BUTTON_CLASS}
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
      data-uxl8="runs"
      className={`flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border max-md:!w-full max-md:border-b md:border-l ${FF_EDITOR_SATELLITE_CLASS}`}
      style={{ width: EDITOR_RUNS_COLUMN_WIDTH }}
    >
      <div className={`${SATELLITE_HEADER_CLASS} shrink-0 flex-wrap gap-2`}>
        <p className={SATELLITE_TITLE_CLASS}>
          {EDITOR_RUNS_SATELLITE_LABEL}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={!scopedId}
            className={`${SATELLITE_HIDE_BUTTON_CLASS} disabled:opacity-60`}
          >
            Start published
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-expanded
            aria-controls={EDITOR_RUNS_PANEL_ID}
            className={SATELLITE_HIDE_BUTTON_CLASS}
          >
            Hide
          </button>
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${SATELLITE_BODY_PAD_CLASS}`}>
        <p className={`text-xs ${FF_EDITOR_MUTED_CLASS}`}>{EDITOR_RUNS_OPERATE_HELP}</p>
        {workflowName ? (
          <p className={`mt-1 text-xs ${FF_EDITOR_MUTED_CLASS}`}>
            <code className="font-mono">GET /workflows/{"{id}"}/executions</code>
            {" "}
            for <span className={`font-medium ${FF_EDITOR_TITLE_CLASS}`}>{workflowName}</span>
            .
          </p>
        ) : null}

        <div className="mt-3">
          <p className={`text-xs font-medium ${FF_EDITOR_TITLE_CLASS}`}>Status</p>
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
            className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs font-medium disabled:opacity-60`}
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
            className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs font-medium disabled:opacity-60`}
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
            className={FF_EDITOR_LINK_CLASS}
          >
            Workspace executions
          </Link>
          <span className={FF_EDITOR_MUTED_CLASS}> — cross-workflow ops view</span>
        </p>

        {!canCall ? (
          <div className="mt-4">
            <SessionSetupHint purpose="before listing executions." />
          </div>
        ) : null}

        {!scopedId ? (
          <p className={`mt-4 text-sm ${FF_EDITOR_MUTED_CLASS}`}>
            Open a workflow to list its runs.
          </p>
        ) : null}

        {denied ? (
          <p className={`mt-4 text-sm ${FF_EDITOR_MUTED_CLASS}`}>
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
            data-peak-end-surface="overlay"
            className={`mt-4 rounded-xl p-3 ${peakEndSurfaceClassName(selectedPeakEnd)}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold">
                  {peakEndHeadline(selectedPeakEnd)}
                </p>
                <p className={`mt-1 font-mono ${TYPE_CAPTION_CLASS} break-all ${FF_EDITOR_MUTED_CLASS}`}>
                  {selectedRow.versionPin}
                </p>
              </div>
              <ExecutionStatusBadge
                status={selectedExecution?.status ?? selectedRow.status}
              />
            </div>
            <PeakEndEnding kind={selectedPeakEnd} className="mt-2" />
            <p className={`mt-2 text-xs ${FF_EDITOR_MUTED_CLASS}`}>
              {editorRunsHighlightSummary(overlayHighlightCount)}
            </p>
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <Link
                href={editorRunOpenHref(selectedRow.id, scopedId || undefined, embed)}
                className={FF_EDITOR_LINK_CLASS}
              >
                Open execution
              </Link>
              {onClearRun ? (
                <button
                  type="button"
                  onClick={onClearRun}
                  className={`font-medium underline ${FF_EDITOR_MUTED_CLASS}`}
                >
                  {EDITOR_RUN_CLEAR_LABEL}
                </button>
              ) : null}
            </p>
            <div className="mt-3 space-y-2">
              <ExecutionDecideActions
                identity={identity}
                executionId={selectedRow.id}
                status={selectedRow.status}
                approvals={decideApprovals[selectedRow.id]}
                actorUserId={actorUserId}
                permissions={permissions}
                surface="overlay"
                compact
                onDecided={() => handleOperated(selectedRow.id)}
              />
              <ExecutionOperateActions
                identity={identity}
                executionId={selectedRow.id}
                workflowId={scopedId || undefined}
                status={selectedRow.status}
                permissions={permissions}
                detail={operateDetailFor(selectedRow.id)}
                surface="overlay"
                compact
                onOperated={() => handleOperated(selectedRow.id)}
              />
            </div>
          </section>
        ) : null}

        {forbidden || denied || !canCall || !scopedId ? null : visible.length === 0 ? (
          <div className={`mt-4 rounded-xl border border-dashed p-4 text-center ${FF_EDITOR_PANEL_CLASS}`}>
            <h3 className={`text-sm font-semibold ${FF_EDITOR_TITLE_CLASS}`}>
              {status ? "No runs match this filter" : "No executions yet"}
            </h3>
            <p className={`mt-2 text-xs ${FF_EDITOR_MUTED_CLASS}`}>
              Start a published version from the control next to this overlay.
              Drafts never run.
            </p>
            {status ? (
              <button
                type="button"
                onClick={() => setStatus("")}
                className={`mt-3 text-xs font-medium ${FF_EDITOR_LINK_CLASS}`}
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
              operateActions={(row) => (
                <>
                  <ExecutionDecideActions
                    identity={identity}
                    executionId={row.id}
                    status={row.status}
                    approvals={decideApprovals[row.id]}
                    actorUserId={actorUserId}
                    permissions={permissions}
                    surface="overlay"
                    compact
                    onDecided={() => handleOperated(row.id)}
                  />
                  <ExecutionOperateActions
                    identity={identity}
                    executionId={row.id}
                    workflowId={scopedId || undefined}
                    status={row.status}
                    permissions={permissions}
                    detail={operateDetailFor(row.id)}
                    surface="overlay"
                    compact
                    onOperated={() => handleOperated(row.id)}
                  />
                </>
              )}
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
          ? `${FF_EDITOR_CHIP_ACCENT_CLASS} ${TYPE_CAPTION_CLASS} disabled:opacity-60`
          : `${FF_EDITOR_CHIP_CLASS} ${TYPE_CAPTION_CLASS} disabled:opacity-60`
      }
    >
      {label}
    </button>
  );
}
