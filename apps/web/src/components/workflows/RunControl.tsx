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
  PRE_RUN_PUBLISHED_ONLY_HELP,
  PRE_RUN_SIDE_EFFECT_HELP,
  executionHistoryHref,
} from "@/lib/execution-contract";
import { isIdempotencyConflict } from "@/lib/execution";
import { buildPreRunReview, publishedRunVersions } from "@/lib/execution-replay";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { shortDigest } from "@/lib/workflow";
import type {
  WorkflowCatalog,
  WorkflowExecution,
  WorkflowVersion,
} from "@/lib/workflow-types";

type RunControlProps = {
  versions: WorkflowVersion[];
  selectedVersionId: string;
  selectedVersion?: WorkflowVersion | null;
  catalog?: WorkflowCatalog | null;
  versionPins?: OpsConfigPin[];
  triggerInput: string;
  onTriggerInput: (value: string) => void;
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
  selectedVersion,
  catalog,
  versionPins,
  triggerInput,
  onTriggerInput,
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
  const published = publishedRunVersions(versions);
  const review = buildPreRunReview({
    version: selectedVersion ?? published.find((item) => item.id === selectedVersionId),
    versions: published,
    selectedVersionId,
    pins: versionPins,
    triggerInput: triggerInput.trim() ? safeJson(triggerInput) : null,
    evaluation,
    catalog,
  });
  const canRun =
    Boolean(selectedVersionId) && !pending && !runBlocked && review.published;
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
        {PRE_RUN_PUBLISHED_ONLY_HELP} POST body is{" "}
        <code className="font-mono text-xs">
          {"{workflowVersionId, idempotencyKey?, input?}"}
        </code>
        . CSRF is required.{" "}
        <code className="font-mono text-xs">201</code> is a new run;{" "}
        <code className="font-mono text-xs">200</code> is a replay.
      </p>

      {published.length === 0 ? (
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
              {published.map((version) => (
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
          <label className="block text-sm">
            <span className="text-zinc-600">Trigger input (optional JSON)</span>
            <textarea
              value={triggerInput}
              onChange={(event) => onTriggerInput(event.target.value)}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder='{"dryRun":true}'
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
            />
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
        <div className="mt-4 space-y-3">
          <section
            aria-labelledby="pre-run-review-heading"
            className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"
          >
            <h3 id="pre-run-review-heading" className="text-sm font-semibold">
              Pre-run review
            </h3>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Version digest</dt>
                <dd className="font-mono text-xs break-all">
                  {review.digest || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Triggers</dt>
                <dd className="font-mono text-xs">
                  {review.triggers.map((item) => item.type).join(", ") || "—"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Target / environment</dt>
                <dd>{review.environment}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Trigger input (redacted)</dt>
                <dd>
                  <pre className="mt-1 overflow-auto rounded-lg bg-white p-2 font-mono text-xs text-zinc-700">
                    {review.triggerInputText}
                  </pre>
                </dd>
              </div>
            </dl>
            {review.sideEffectWarnings.length > 0 ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-950">
                <li>{PRE_RUN_SIDE_EFFECT_HELP}</li>
                {review.sideEffectWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {!review.published ? (
              <p className="mt-3 text-sm text-amber-950">{review.blockReason}</p>
            ) : null}
          </section>
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { _invalidJson: true };
  }
}
