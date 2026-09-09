"use client";

import Link from "next/link";
import { ExecutionApprovalState } from "@/components/approvals/ExecutionApprovalState";
import { PreRunPolicyReview } from "@/components/approvals/PreRunPolicyReview";
import { ConfigPinList } from "@/components/config/ConfigPinList";
import { ManualStartFields } from "@/components/workflows/ManualStartFields";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import {
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_REPLAY_MESSAGE,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  PRE_RUN_SIDE_EFFECT_HELP,
  executionHistoryHref,
} from "@/lib/execution-contract";
import { isIdempotencyConflict } from "@/lib/execution";
import { buildPreRunReview, publishedRunVersions } from "@/lib/execution-replay";
import {
  MANUAL_START_AUDIT_HELP,
  MANUAL_START_CONFIRM_HELP,
  MANUAL_START_CSRF_HELP,
  MANUAL_START_FORBIDDEN_MESSAGE,
  MANUAL_START_IDEMPOTENCY_HELP,
  buildManualStartRequest,
  canOfferManualStart,
  extractManualStartSchema,
  generateManualStartIdempotencyKey,
  manualStartAuthFailureMessage,
  manualStartHelp,
} from "@/lib/manual-start-contract";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { DevIdentity } from "@/lib/identity-headers";
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
  runBlockReason?: string;
  evaluation: PolicyEvaluation | null;
  evaluationPending: boolean;
  evaluationProblem: ProblemDetails | null;
  executionApprovals: ApprovalRequest[];
  lastStartStatus: number | null;
  runProblem: ProblemDetails | null;
  idempotencyKey: string;
  onIdempotencyKey: (value: string) => void;
  fieldValues?: Record<string, string>;
  onFieldValues?: (value: Record<string, string>) => void;
  permissions?: string[] | null;
  identity?: DevIdentity;
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
  runBlockReason,
  evaluation,
  evaluationPending,
  evaluationProblem,
  executionApprovals,
  lastStartStatus,
  runProblem,
  idempotencyKey,
  onIdempotencyKey,
  fieldValues = {},
  onFieldValues,
  permissions,
  identity,
  onSelectVersion,
  onRun,
  onRefreshPin,
}: RunControlProps) {
  const published = publishedRunVersions(versions);
  const schema = extractManualStartSchema(selectedVersion?.definitionYaml);
  const prepared = buildManualStartRequest({
    versions,
    selectedVersionId,
    yaml: selectedVersion?.definitionYaml,
    fieldValues,
    jsonText: triggerInput,
    idempotencyKey,
    permissions,
    catalog,
  });
  const review = buildPreRunReview({
    version: selectedVersion ?? published.find((item) => item.id === selectedVersionId),
    versions: published,
    selectedVersionId,
    pins: versionPins,
    triggerInput: triggerInput.trim() ? safeJson(triggerInput) : null,
    evaluation,
    catalog,
  });
  const canExecute =
    permissions === undefined ? true : canOfferManualStart(permissions);
  const canRun =
    Boolean(selectedVersionId) &&
    !pending &&
    !runBlocked &&
    review.published &&
    canExecute &&
    prepared.ok;
  const replayed =
    Boolean(execution?.replayed || execution?.reused) || lastStartStatus === 200;
  const created = lastStartStatus === 201 && !replayed;
  const keyConflict = isIdempotencyConflict(runProblem);
  const authMessage = !canExecute
    ? MANUAL_START_FORBIDDEN_MESSAGE
    : manualStartAuthFailureMessage(runProblem);

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
          {"{workflowVersionId, idempotencyKey, input}"}
        </code>
        {" "}plus <code className="font-mono text-xs">Idempotency-Key</code>.
        CSRF is required.{" "}
        <code className="font-mono text-xs">201</code> is a new run;{" "}
        <code className="font-mono text-xs">200</code> is a replay;{" "}
        <code className="font-mono text-xs">400</code> is draft or bad input;{" "}
        <code className="font-mono text-xs">403</code> is authz or policy deny;{" "}
        <code className="font-mono text-xs">409</code> is fingerprint mismatch
        or approval-required. {manualStartHelp(catalog)}
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
            <span className="text-zinc-600">Idempotency key</span>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                type="text"
                value={idempotencyKey}
                maxLength={128}
                onChange={(event) => onIdempotencyKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Generated if left blank"
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => onIdempotencyKey(generateManualStartIdempotencyKey())}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm hover:bg-zinc-100"
              >
                Generate
              </button>
            </div>
            <span className="mt-1 block text-xs text-zinc-500">
              {MANUAL_START_IDEMPOTENCY_HELP}
            </span>
          </label>
          <ManualStartFields
            schema={schema}
            fieldValues={fieldValues}
            jsonText={triggerInput}
            onFieldValues={(value) => onFieldValues?.(value)}
            onJsonText={onTriggerInput}
          />
          <p className="text-xs text-zinc-500">{MANUAL_START_CSRF_HELP}</p>
          <div className="flex items-end">
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending ? "Starting…" : "Start"}
            </button>
          </div>
          {authMessage ? (
            <p role="status" className="text-sm font-medium text-rose-950">
              {authMessage}
            </p>
          ) : null}
          {runBlocked && runBlockReason ? (
            <p role="status" className="text-sm font-medium text-rose-950">
              {runBlockReason}
            </p>
          ) : null}
          {prepared.confirmation ? (
            <section
              aria-labelledby="run-audit-confirm-heading"
              className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"
            >
              <h3 id="run-audit-confirm-heading" className="text-sm font-semibold">
                Audit confirmation
              </h3>
              <p className="mt-1 text-xs text-zinc-600">{MANUAL_START_CONFIRM_HELP}</p>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Version</dt>
                  <dd className="font-mono text-xs">
                    {prepared.confirmation.versionLabel} ·{" "}
                    {shortDigest(prepared.confirmation.digest)}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Idempotency key</dt>
                  <dd className="font-mono text-xs break-all">
                    {prepared.confirmation.idempotencyKey}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-zinc-500">Redacted input</dt>
                  <dd>
                    <pre className="mt-1 overflow-auto rounded-lg bg-white p-2 font-mono text-xs text-zinc-700">
                      {prepared.confirmation.inputText}
                    </pre>
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-zinc-500">{MANUAL_START_AUDIT_HELP}</p>
            </section>
          ) : prepared.errors.length > 0 && selectedVersionId ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-rose-950">
              {prepared.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
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
              identity={identity}
              permissions={permissions}
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
