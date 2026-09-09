"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PreRunPolicyReview } from "@/components/approvals/PreRunPolicyReview";
import { ProblemBanner } from "@/components/ProblemBanner";
import { evaluatePolicyForRun, listExecutionApprovals } from "@/lib/approval-client";
import { shouldBlockRun } from "@/lib/approval";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import type { DevIdentity } from "@/lib/identity-headers";
import { listWorkflowVersionPins } from "@/lib/ops-config-client";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { isIdempotencyConflict } from "@/lib/execution";
import {
  MANUAL_START_AUDIT_HELP,
  MANUAL_START_CONFIRM_HELP,
  MANUAL_START_CONFLICT_MESSAGE,
  MANUAL_START_CSRF_HELP,
  MANUAL_START_FORBIDDEN_MESSAGE,
  MANUAL_START_IDEMPOTENCY_HELP,
  MANUAL_START_INPUT_HELP,
  MANUAL_START_PUBLISHED_ONLY_HELP,
  buildManualStartRequest,
  canOfferManualStart,
  editorManualStartHref,
  extractManualStartSchema,
  generateManualStartIdempotencyKey,
  isManualStartAuthFailure,
  manualStartAuthFailureMessage,
  manualStartHelp,
  startOutcomeMessage,
} from "@/lib/manual-start-contract";
import { executionHistoryHref } from "@/lib/execution-contract";
import { publishedRunVersions } from "@/lib/execution-replay";
import { shortDigest } from "@/lib/workflow";
import {
  fetchWorkflowCatalog,
  getWorkflowVersion,
  listWorkflowVersions,
  startWorkflowExecution,
} from "@/lib/workflow-client";
import type {
  WorkflowCatalog,
  WorkflowExecution,
  WorkflowVersion,
} from "@/lib/workflow-types";
import { pushNotification } from "@/lib/workspace-notifications";
import { ManualStartFields } from "@/components/workflows/ManualStartFields";

type ManualStartPanelProps = {
  identity: DevIdentity;
  workflowId: string;
  workflowName?: string;
  permissions: string[] | null;
  onClose?: () => void;
  onStarted?: (execution: WorkflowExecution) => void;
};

export function ManualStartPanel({
  identity,
  workflowId,
  workflowName,
  permissions,
  onClose,
  onStarted,
}: ManualStartPanelProps) {
  const canExecute = canOfferManualStart(permissions);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<WorkflowVersion | null>(
    null,
  );
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [jsonText, setJsonText] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(
    generateManualStartIdempotencyKey,
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [evaluation, setEvaluation] = useState<PolicyEvaluation | null>(null);
  const [evaluationProblem, setEvaluationProblem] =
    useState<ProblemDetails | null>(null);
  const [evaluationPending, setEvaluationPending] = useState(false);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [lastStartStatus, setLastStartStatus] = useState<number | null>(null);

  const published = useMemo(() => publishedRunVersions(versions), [versions]);
  const schema = extractManualStartSchema(selectedVersion?.definitionYaml);
  const preview = buildManualStartRequest({
    versions,
    selectedVersionId,
    yaml: selectedVersion?.definitionYaml,
    fieldValues,
    jsonText,
    idempotencyKey,
    permissions,
    catalog,
  });

  const loadVersion = useCallback(
    async (versionId: string) => {
      if (!versionId) {
        setSelectedVersion(null);
        setPins([]);
        setEvaluation(null);
        setEvaluationProblem(null);
        return;
      }
      setEvaluationPending(true);
      const [version, pinList, policy] = await Promise.all([
        getWorkflowVersion(identity, workflowId, versionId),
        listWorkflowVersionPins(identity, workflowId, versionId),
        evaluatePolicyForRun(identity, {
          workflowId,
          workflowVersionId: versionId,
        }),
      ]);
      setEvaluationPending(false);
      if (version.ok) {
        setSelectedVersion(version.version);
      } else {
        setSelectedVersion(null);
        setProblem(version.problem);
      }
      setPins(pinList.ok ? pinList.items : []);
      if (!policy.ok) {
        setEvaluation(null);
        setEvaluationProblem(policy.problem);
        return;
      }
      setEvaluation(policy.evaluation);
      setEvaluationProblem(null);
    },
    [identity, workflowId],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listWorkflowVersions(identity, workflowId),
      fetchWorkflowCatalog(identity),
    ]).then(([result, catalogResult]) => {
      if (cancelled) {
        return;
      }
      setCatalog(catalogResult.ok ? catalogResult.catalog : null);
      if (!result.ok) {
        setProblem(result.problem);
        return;
      }
      const items = publishedRunVersions(result.items);
      setVersions(result.items);
      const initial = items[0]?.id ?? "";
      setSelectedVersionId(initial);
      if (initial) {
        void loadVersion(initial);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [identity, workflowId, loadVersion]);

  async function onStart() {
    if (!canExecute) {
      setProblem({
        type: "urn:flowforge:problem:forbidden",
        title: "Start forbidden",
        status: 403,
        detail: MANUAL_START_FORBIDDEN_MESSAGE,
        instance: `/workflows/${workflowId}/executions`,
        code: "forbidden",
        request_id: "local-manual-start-16",
      });
      return;
    }
    const prepared = buildManualStartRequest({
      versions,
      selectedVersionId,
      yaml: selectedVersion?.definitionYaml,
      fieldValues,
      jsonText,
      idempotencyKey,
      permissions,
      catalog,
    });
    if (!prepared.ok || !prepared.body) {
      setProblem({
        type: "urn:flowforge:problem:invalid-request",
        title: "Cannot start",
        status: 400,
        detail: prepared.reason,
        instance: `/workflows/${workflowId}/executions`,
        code: "invalid-request",
        request_id: "local-manual-start-16",
      });
      return;
    }
    if (
      shouldBlockRun({
        evaluation,
        evaluationProblem,
        staleLocalApproved: true,
      })
    ) {
      return;
    }
    setPending(true);
    setProblem(null);
    const result = await startWorkflowExecution(
      identity,
      workflowId,
      prepared.body.workflowVersionId,
      {
        idempotencyKey: prepared.body.idempotencyKey,
        input: prepared.body.input,
      },
    );
    setLastStartStatus(result.statusCode);
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setExecution(result.execution);
    setIdempotencyKey(prepared.idempotencyKey);
    const waiting = await listExecutionApprovals(
      identity,
      workflowId,
      result.execution.id,
    );
    setApprovals(waiting.ok ? waiting.items : []);
    pushNotification({
      kind: "execution",
      title: result.execution.replayed ? "Execution replayed" : "Execution started",
      detail: result.execution.status,
      href: `/executions/${result.execution.id}`,
    });
    onStarted?.(result.execution);
  }

  const authMessage = !canExecute
    ? MANUAL_START_FORBIDDEN_MESSAGE
    : manualStartAuthFailureMessage(problem);
  const keyConflict = isIdempotencyConflict(problem);
  const outcome = startOutcomeMessage(lastStartStatus);

  return (
    <section
      aria-labelledby="manual-start-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="manual-start-heading" className="text-base font-semibold">
            Authenticated manual start
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            {workflowName ? `${workflowName}. ` : null}
            {MANUAL_START_PUBLISHED_ONLY_HELP} {manualStartHelp(catalog)}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
          >
            Close
          </button>
        ) : null}
      </div>

      {problem && !isManualStartAuthFailure(problem) && !keyConflict ? (
        <div className="mt-4">
          <ProblemBanner problem={problem} />
        </div>
      ) : null}

      {!canExecute || authMessage ? (
        <p role="status" className="mt-4 text-sm font-medium text-rose-950">
          {authMessage || MANUAL_START_FORBIDDEN_MESSAGE}
        </p>
      ) : null}

      {published.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          Publish a version before running. There is no draft option here.{" "}
          <Link
            href={editorManualStartHref(workflowId)}
            className="text-teal-800 underline"
          >
            Open editor
          </Link>
        </p>
      ) : (
        <div className="mt-4 grid gap-3">
          <label className="block text-sm">
            <span className="text-zinc-600">Published version</span>
            <select
              value={selectedVersionId}
              onChange={(event) => {
                setSelectedVersionId(event.target.value);
                setFieldValues({});
                setJsonText("");
                void loadVersion(event.target.value);
              }}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">Select a published version</option>
              {published.map((item) => (
                <option key={item.id} value={item.id}>
                  v{item.versionNumber} · {shortDigest(item.digest)}
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
                onChange={(event) => setIdempotencyKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setIdempotencyKey(generateManualStartIdempotencyKey())}
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
            jsonText={jsonText}
            onFieldValues={setFieldValues}
            onJsonText={setJsonText}
          />
          <p className="text-xs text-zinc-500">{MANUAL_START_INPUT_HELP}</p>
          <p className="text-xs text-zinc-500">{MANUAL_START_CSRF_HELP}</p>
          {preview.confirmation ? (
            <section
              aria-labelledby="manual-start-confirm-heading"
              className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"
            >
              <h3 id="manual-start-confirm-heading" className="text-sm font-semibold">
                Audit confirmation
              </h3>
              <p className="mt-1 text-xs text-zinc-600">{MANUAL_START_CONFIRM_HELP}</p>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Version</dt>
                  <dd className="font-mono text-xs">
                    {preview.confirmation.versionLabel} ·{" "}
                    {shortDigest(preview.confirmation.digest)}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Idempotency key</dt>
                  <dd className="font-mono text-xs break-all">
                    {preview.confirmation.idempotencyKey}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-zinc-500">Redacted input</dt>
                  <dd>
                    <pre className="mt-1 overflow-auto rounded-lg bg-white p-2 font-mono text-xs text-zinc-700">
                      {preview.confirmation.inputText}
                    </pre>
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-zinc-500">{MANUAL_START_AUDIT_HELP}</p>
            </section>
          ) : preview.errors.length > 0 && selectedVersionId ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-rose-950">
              {preview.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <PreRunPolicyReview
            evaluation={evaluation}
            pending={evaluationPending}
            problem={evaluationProblem}
          />
          {pins.length > 0 ? (
            <p className="text-xs text-zinc-500">
              {pins.length} ops-config pin{pins.length === 1 ? "" : "s"} on this
              published version.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onStart()}
              disabled={!canExecute || pending || !selectedVersionId || !preview.ok}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending ? "Starting…" : "Start"}
            </button>
            <Link
              href={editorManualStartHref(workflowId)}
              className="text-sm text-teal-800 underline"
            >
              Open editor
            </Link>
          </div>
        </div>
      )}

      {keyConflict ? (
        <p role="status" className="mt-3 text-sm text-amber-950">
          {MANUAL_START_CONFLICT_MESSAGE}
        </p>
      ) : null}
      {outcome ? (
        <p role="status" className="mt-3 text-sm text-zinc-800">
          {outcome}
        </p>
      ) : null}
      {execution ? (
        <div className="mt-4 space-y-2 rounded-lg bg-zinc-50 px-3 py-3 text-sm">
          <p className="font-medium">
            {execution.status} · {execution.id}
          </p>
          <p className="font-mono text-xs break-all text-zinc-600">
            workflowVersionId {execution.workflowVersionId}
          </p>
          <Link
            href={executionHistoryHref(execution.id, execution.workflowId)}
            className="inline-block text-sm text-teal-800 underline"
          >
            Open execution
          </Link>
          {approvals.length > 0 ? (
            <p className="text-xs text-zinc-600">
              {approvals.length} approval requirement
              {approvals.length === 1 ? "" : "s"} recorded for this start.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
