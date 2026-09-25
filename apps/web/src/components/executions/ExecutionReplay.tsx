"use client";

import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { WorkflowCanvas, type EditorSelection } from "@/components/workflows/WorkflowCanvas";
import type { ApprovalRequest } from "@/lib/approval-types";
import {
  GRAPH_REPLAY_HELP,
  INDETERMINATE_STATUS_HELP,
} from "@/lib/execution-contract";
import {
  isSshRunType,
  parseSshRetryResult,
  sshIndeterminateCopy,
  sshVerificationOutcomeCopy,
} from "@/lib/ssh-retry-contract";
import {
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  SCRIPT_IO_VALIDATION_HELP,
  isScriptIoActionType,
  parseScriptIoResult,
  parseScriptIoRetryResult,
  scriptIndeterminateCopy,
} from "@/lib/script-io-contract";
import {
  currentReplayNodeId,
  overlayExecutionOnGraph,
  projectPinnedVersionGraph,
  replayStepViews,
  waitingApprovalNodeIds,
} from "@/lib/execution-replay";
import { boundRedactedDisplay } from "@/lib/execution";
import type { ExecutionArtifact, ExecutionDetail } from "@/lib/execution-types";
import type { ActionLibraryEntry } from "@/lib/workflow-action-library";
import type { WorkflowCatalog, WorkflowVersion } from "@/lib/workflow-types";
import {
  FF_INBOX_DANGER_CLASS,
  FF_INBOX_EMPTY_CLASS,
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PANEL_CLASS,
  FF_INBOX_ROW_CLASS,
  FF_INBOX_ROW_CURRENT_CLASS,
  FF_INBOX_ROW_INDETERMINATE_CLASS,
  FF_INBOX_TITLE_CLASS,
  FF_LOUD_INDETERMINATE_CLASS,
} from "@/lib/vault-executions-visual";

type ExecutionReplayProps = {
  detail: ExecutionDetail;
  version: WorkflowVersion | null;
  catalog: WorkflowCatalog | null;
  entries: ActionLibraryEntry[];
  approvals: ApprovalRequest[];
  artifacts: ExecutionArtifact[];
  selection: EditorSelection;
  onSelect: (selection: EditorSelection) => void;
  logsText?: string;
};

export function ExecutionReplay({
  detail,
  version,
  catalog,
  entries,
  approvals,
  artifacts,
  selection,
  onSelect,
  logsText,
}: ExecutionReplayProps) {
  const waitingIds = waitingApprovalNodeIds(approvals, detail.status);
  const base = projectPinnedVersionGraph({
    yaml: version?.definitionYaml,
    summary: version?.summary,
    catalog,
  });
  const graph = base
    ? overlayExecutionOnGraph(base, detail.steps, {
        waitingApprovalNodeIds: waitingIds,
        runStatus: detail.status,
        jobs: detail.jobs,
      })
    : null;
  const currentNodeId = currentReplayNodeId(
    detail.steps,
    waitingIds,
    detail.status,
  );
  const views = replayStepViews(detail.steps, {
    waitingApprovalNodeIds: waitingIds,
    runStatus: detail.status,
    jobs: detail.jobs,
  });
  const selectedId =
    selection.kind === "node" ? selection.id : currentNodeId;
  const selected = views.find((item) => item.nodeId === selectedId) ?? views.find((item) => item.current);
  const selectedArtifacts = artifacts.filter(
    (item) => item.executionStepId && selected && item.executionStepId === selected.step.id,
  );

  return (
    <section
      aria-labelledby="graph-replay-heading"
      className="space-y-4"
    >
      <div>
        <h2 id="graph-replay-heading" className={`text-lg ${FF_INBOX_TITLE_CLASS}`}>
          Graph replay
        </h2>
        <p className={`mt-1 text-sm ${FF_INBOX_MUTED_CLASS}`}>{GRAPH_REPLAY_HELP}</p>
        <p className={`mt-1 font-mono text-xs break-all ${FF_INBOX_MUTED_CLASS}`}>
          correlation {detail.correlationId || "—"}
        </p>
      </div>

      {graph ? (
        <WorkflowCanvas
          graph={graph}
          invalid={false}
          pending={false}
          selection={selection}
          entries={entries}
          readOnly
          currentNodeId={currentNodeId ?? undefined}
          heading="Graph replay"
          onSelect={onSelect}
        />
      ) : (
        <p className={`text-sm ${FF_INBOX_EMPTY_CLASS}`}>
          Pinned version YAML is not available, so this page does not guess a
          graph. Step status, duration, and redacted output are listed below.
        </p>
      )}

      {selected ? (
        <div
          className={
            selected.presentation.indeterminate
              ? `rounded-2xl p-5 ${FF_LOUD_INDETERMINATE_CLASS}`
              : FF_INBOX_PANEL_CLASS
          }
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className={`text-base ${FF_INBOX_TITLE_CLASS}`}>
                {selected.current ? "Current node · " : ""}
                {selected.nodeId}
              </h3>
              <p className={`font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
                {selected.step.nodeType} · attempt {selected.attempts} · duration{" "}
                {selected.durationLabel}
              </p>
            </div>
            <ExecutionStatusBadge
              status={selected.status}
              runStatus={detail.status}
              siblingJobStatuses={detail.jobs
                .filter((job) => job.executionStepId === selected.step.id)
                .map((job) => job.status)}
            />
          </div>
          {selected.presentation.indeterminate ? (
            <p className="mt-3 text-sm font-medium">
              {isSshRunType(selected.step.nodeType)
                ? sshIndeterminateCopy({
                    status: selected.status,
                    nodeType: selected.step.nodeType,
                    verificationOutcome: parseSshRetryResult(
                      selected.step.output,
                      selected.step.error,
                      selected.step.input,
                    )?.verificationOutcome,
                  })
                : isScriptIoActionType(selected.step.nodeType)
                  ? scriptIndeterminateCopy({
                      status: selected.status,
                      nodeType: selected.step.nodeType,
                      errorCode: parseScriptIoRetryResult(
                        selected.step.output,
                        selected.step.error,
                        selected.step.input,
                      )?.verificationOutcome,
                    })
                  : INDETERMINATE_STATUS_HELP}
            </p>
          ) : null}
          {isSshRunType(selected.step.nodeType)
            ? (() => {
                const retry = parseSshRetryResult(
                  selected.step.output,
                  selected.step.error,
                  selected.step.input,
                );
                return retry?.verificationOutcome ? (
                  <p className="mt-2 text-sm">
                    {sshVerificationOutcomeCopy(retry.verificationOutcome)}
                  </p>
                ) : null;
              })()
            : null}
          {isScriptIoActionType(selected.step.nodeType)
            ? (() => {
                const parsed = parseScriptIoResult(
                  selected.step.output,
                  selected.step.error,
                  selected.step.input,
                );
                if (!parsed) {
                  return (
                    <p className={`mt-2 text-xs ${FF_INBOX_MUTED_CLASS}`}>
                      {SCRIPT_IO_NO_BLIND_RETRY_HELP}
                    </p>
                  );
                }
                return (
                  <div className="mt-2 space-y-2">
                    {parsed.validationErrors.length > 0 ? (
                      <ul className={`space-y-1 text-sm ${FF_INBOX_DANGER_CLASS}`}>
                        {parsed.validationErrors.map((error) => (
                          <li key={`${error.code}-${error.path}-${error.message}`}>
                            <span className="font-mono text-xs">{error.code}</span>
                            {error.path ? ` · ${error.path}` : ""} — {error.message}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={`text-xs ${FF_INBOX_MUTED_CLASS}`}>{SCRIPT_IO_VALIDATION_HELP}</p>
                    )}
                    <p className={`text-xs ${FF_INBOX_MUTED_CLASS}`}>
                      {parsed.retry?.allowed
                        ? `result.retry.allowed is true · maxAttempts=${parsed.retry.maxAttempts}`
                        : SCRIPT_IO_NO_BLIND_RETRY_HELP}
                    </p>
                  </div>
                );
              })()
            : null}
          {selected.waiting ? (
            <p role="status" className="mt-3 text-sm">
              Waiting on approval. Decide the bound approval — the wait state
              survives worker or pod loss. Resume is decide, not a new route.
            </p>
          ) : null}
          <div className="mt-3">
            <p className={`text-xs font-medium ${FF_INBOX_MUTED_CLASS}`}>Safe outputs</p>
            <pre className={`mt-1 overflow-auto rounded-lg p-3 font-mono text-xs ${FF_INBOX_PANEL_CLASS}`}>
              {selected.outputText}
            </pre>
          </div>
          {logsText ? (
            <div className="mt-3">
              <p className={`text-xs font-medium ${FF_INBOX_MUTED_CLASS}`}>Redacted logs</p>
              <pre className={`mt-1 overflow-auto rounded-lg p-3 font-mono text-xs ${FF_INBOX_PANEL_CLASS}`}>
                {logsText}
              </pre>
            </div>
          ) : null}
          {selectedArtifacts.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {selectedArtifacts.map((artifact) => (
                <li key={artifact.id} className={`font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
                  {artifact.name || artifact.kind} · {artifact.digest || "no digest"}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {views.length > 0 ? (
        <ol className="grid gap-2">
          {views.map((item) => (
            <li key={item.step.id}>
              <button
                type="button"
                id={graph ? undefined : `replay-node-${item.nodeId}`}
                onClick={() => onSelect({ kind: "node", id: item.nodeId })}
                className={`flex w-full items-start justify-between gap-3 rounded-xl px-4 py-3 text-left ${
                  item.presentation.indeterminate
                    ? FF_INBOX_ROW_INDETERMINATE_CLASS
                    : item.current
                      ? FF_INBOX_ROW_CURRENT_CLASS
                      : FF_INBOX_ROW_CLASS
                }`}
              >
                <span>
                  <span className="font-medium">{item.nodeId}</span>
                  <span className={`mt-1 block font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
                    attempt {item.attempts} · {item.durationLabel}
                    {item.current ? " · current" : ""}
                    {item.waiting ? " · waiting" : ""}
                  </span>
                </span>
                <ExecutionStatusBadge
                  status={item.status}
                  runStatus={detail.status}
                  siblingJobStatuses={detail.jobs
                    .filter((job) => job.executionStepId === item.step.id)
                    .map((job) => job.status)}
                />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className={`text-sm ${FF_INBOX_MUTED_CLASS}`}>
          No steps returned. Replay cannot overlay status yet.
        </p>
      )}

      {detail.input != null ? (
        <div>
          <p className={`text-xs font-medium ${FF_INBOX_MUTED_CLASS}`}>Redacted trigger input</p>
          <pre className={`mt-1 overflow-auto rounded-lg p-3 font-mono text-xs ${FF_INBOX_PANEL_CLASS}`}>
            {boundRedactedDisplay(detail.input).text}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
