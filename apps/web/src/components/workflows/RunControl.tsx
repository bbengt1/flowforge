"use client";

import Link from "next/link";
import { ExecutionApprovalState } from "@/components/approvals/ExecutionApprovalState";
import { PreRunPolicyReview } from "@/components/approvals/PreRunPolicyReview";
import { ConfigPinList } from "@/components/config/ConfigPinList";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import {
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_KEY_HELP,
  IDEMPOTENCY_REPLAY_MESSAGE,
  executionHistoryHref,
} from "@/lib/execution-contract";
import { isIdempotencyConflict } from "@/lib/execution";
import type { ProblemDetails } from "@/lib/problem";
import { shortDigest } from "@/lib/workflow";
import type { WorkflowExecution, WorkflowVersion } from "@/lib/workflow-types";

type RunControlProps = {
  versions: WorkflowVersion[];
  selectedVersionId: string;
  execution: WorkflowExecution | null;
  pending: boolean;
  dirty: boolean;
  runBlocked: boolean;
  evaluation: PolicyEvaluation | null;
  evaluationPending: boolean;
  evaluationProblem: ProblemDetails | null;
  executionApprovals: ApprovalRequest[];
  lastStartStatus: number | null;
  runProblem: ProblemDetails | null;
  idempotencyKey: string;
  onIdempotencyKey: (value: string) => void;
  onSelectVersion: (versionId: string) => void;
  onRun: () => void;
  onRefreshPin: () => void;
};

export function RunControl({
  versions,
  selectedVersionId,
  execution,
  pending,
  dirty,
  runBlocked,
  evaluation,
  evaluationPending,
  evaluationProblem,
  executionApprovals,
  lastStartStatus,
  runProblem,
  idempotencyKey,
  onIdempotencyKey,
  onSelectVersion,
  onRun,
  onRefreshPin,
}: RunControlProps) {
  const canRun = Boolean(selectedVersionId) && !pending && !runBlocked;
  const replayed =
    Boolean(execution?.replayed || execution?.reused) || lastStartStatus === 200;
  const created = lastStartStatus === 201 && !replayed;
  const keyConflict = isIdempotencyConflict(runProblem);

  return (
    <section
      aria-labelledby="run-control-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="run-control-heading" className="text-base font-semibold">
        Run published version
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Executions require a published{" "}
        <code className="font-mono text-xs">workflowVersionId</code>. Drafts
        cannot run. POST body is{" "}
        <code className="font-mono text-xs">
          {"{workflowVersionId, idempotencyKey?, input?}"}
        </code>
        . CSRF is required.{" "}
        <code className="font-mono text-xs">201</code> is a new run;{" "}
        <code className="font-mono text-xs">200</code> is a replay.
      </p>

      {versions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          Publish a version before running. There is no draft option here.
        </p>
      ) : (
        <div className="mt-4 grid gap-3">
          <label className="block text-sm">
            <span className="text-zinc-600">Published version</span>
            <select
              value={selectedVersionId}
              onChange={(event) => onSelectVersion(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">Select a published version</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.versionNumber} · {shortDigest(version.digest)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-600">Idempotency key (optional)</span>
            <input
              type="text"
              value={idempotencyKey}
              maxLength={128}
              onChange={(event) => onIdempotencyKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Same key + same input replays"
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
            />
            <span className="mt-1 block text-xs text-zinc-500">
              {IDEMPOTENCY_KEY_HELP}
            </span>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending ? "Starting…" : "Run"}
            </button>
          </div>
        </div>
      )}

      {dirty ? (
        <p className="mt-3 text-sm text-zinc-600">
          Unsaved editor changes are not executed. Run uses the selected
          published snapshot only.
        </p>
      ) : null}

      {selectedVersionId ? (
        <div className="mt-4">
          <PreRunPolicyReview
            evaluation={evaluation}
            pending={evaluationPending}
            problem={evaluationProblem}
          />
        </div>
      ) : null}

      {keyConflict ? (
        <p role="status" className="mt-3 text-sm text-amber-950">
          {IDEMPOTENCY_CONFLICT_MESSAGE}
        </p>
      ) : null}

      {created ? (
        <p role="status" className="mt-3 text-sm text-zinc-800">
          {IDEMPOTENCY_CREATED_MESSAGE}
        </p>
      ) : null}

      {execution ? (
        <div className="mt-4 space-y-2 rounded-lg bg-zinc-50 px-3 py-3 text-sm">
          <p className="font-medium">
            Pin {execution.status} · {execution.id}
          </p>
          <p className="font-mono text-xs break-all text-zinc-600">
            workflowVersionId {execution.workflowVersionId}
          </p>
          <p className="font-mono text-xs break-all text-zinc-600">
            workflowDigest {execution.workflowDigest}
          </p>
          <div className="pt-1">
            <p className="text-xs font-medium text-zinc-600">Config pins</p>
            <ConfigPinList
              pins={execution.pins}
              empty="No ops-config pins on this execution."
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onRefreshPin}
              disabled={pending}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
            >
              Re-read pin
            </button>
            <Link
              href={executionHistoryHref(execution.id, execution.workflowId)}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
            >
              Open execution history
            </Link>
          </div>
          {replayed ? (
            <p className="text-sm text-zinc-700">{IDEMPOTENCY_REPLAY_MESSAGE}</p>
          ) : created ? (
            <p className="text-sm text-zinc-700">{IDEMPOTENCY_CREATED_MESSAGE}</p>
          ) : null}
          <div className="pt-2">
            <ExecutionApprovalState
              executionStatus={execution.status}
              approvals={executionApprovals}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
