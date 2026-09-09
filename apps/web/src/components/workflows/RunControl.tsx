"use client";

import Link from "next/link";
import { ExecutionApprovalState } from "@/components/approvals/ExecutionApprovalState";
import { PreRunPolicyReview } from "@/components/approvals/PreRunPolicyReview";
import { ConfigPinList } from "@/components/config/ConfigPinList";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import { executionHistoryHref, IDEMPOTENCY_REPLAY_MESSAGE } from "@/lib/execution-contract";
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
  onSelectVersion,
  onRun,
  onRefreshPin,
}: RunControlProps) {
  const canRun = Boolean(selectedVersionId) && !pending && !runBlocked;

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
        cannot run. The pin stays on that version/digest after later draft
        edits.
      </p>

      {versions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          Publish a version before running. There is no draft option here.
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
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
          {execution.reused ? (
            <p className="text-sm text-zinc-700">{IDEMPOTENCY_REPLAY_MESSAGE}</p>
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
