"use client";

import Link from "next/link";
import { formatFieldLocation } from "@/lib/workflow";
import {
  NDV_APPROVAL_DECIDE_HELP,
  NDV_EVALUATE_WHEN_PUBLISHED_HELP,
  NDV_NO_DRAFT_EXECUTE_HELP,
  NDV_VALIDATION_JUMP_HELP,
  focusNdvRailField,
  ndvActionableJump,
  ndvCatalogPolicyBounds,
  ndvDecideHref,
  ndvEvaluateForNode,
  ndvEvaluatePayloadHasGap,
  ndvValidationView,
  type NdvValidationStatus,
} from "@/lib/editor-ndv-validation";
import { safeProblemDetail, type ProblemDetails } from "@/lib/problem";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import type { ActionLibraryEntry } from "@/lib/workflow-action-library";
import type { WorkflowFieldError } from "@/lib/workflow-types";

export type NdvValidationPanelProps = {
  nodeId: string;
  entry?: ActionLibraryEntry;
  status: NdvValidationStatus;
  errors: WorkflowFieldError[];
  warnings?: WorkflowFieldError[];
  nodes?: { id: string }[];
  edges?: { from: string; to: string }[];
  problem?: ProblemDetails | null;
  evaluation?: PolicyEvaluation | null;
  evaluationPending?: boolean;
  evaluationProblem?: ProblemDetails | null;
  publishedVersionId?: string | null;
  waitingApprovals?: readonly ApprovalRequest[];
  onJumpYaml?: (line: number, column?: number) => void;
};

export function NdvValidationPanel({
  nodeId,
  entry,
  status,
  errors,
  warnings = [],
  nodes = [],
  edges = [],
  problem,
  evaluation,
  evaluationPending = false,
  evaluationProblem,
  publishedVersionId,
  waitingApprovals = [],
  onJumpYaml,
}: NdvValidationPanelProps) {
  const view = ndvValidationView({
    nodeId,
    status,
    errors,
    warnings,
    nodes,
    edges,
  });
  const policy = ndvCatalogPolicyBounds(entry);
  const scoped = ndvEvaluateForNode({
    nodeId,
    evaluation,
    publishedVersionId,
  });
  const evaluateGap = ndvEvaluatePayloadHasGap(evaluation);
  const approvals = uniqueApprovals([
    ...scoped.approvals,
    ...waitingApprovals.filter((item) => item.binding.nodeId === nodeId),
  ]);

  function jump(error: WorkflowFieldError & { nodeId?: string }) {
    const target = ndvActionableJump(error);
    if (target.field) {
      focusNdvRailField(target.field);
    }
    if (target.line && onJumpYaml) {
      onJumpYaml(target.line, target.column);
    }
  }

  return (
    <section
      data-ndv-panel="validation"
      aria-labelledby="ndv-validation-heading"
      aria-live="polite"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="ndv-validation-heading" className="text-base font-semibold">
        Validation and policy
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        {NDV_VALIDATION_JUMP_HELP} {NDV_EVALUATE_WHEN_PUBLISHED_HELP}
      </p>

      <p className="mt-3 text-sm font-medium" data-ndv-validation-status={status}>
        {status === "idle"
          ? "Waiting for YAML"
          : status === "pending"
            ? "Validating…"
            : status === "valid" && view.node.length === 0 && view.edge.length === 0
              ? "This step is valid"
              : "This step has problems"}
      </p>

      {view.node.length + view.edge.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {[...view.node, ...view.edge].map((error, index) => (
            <ValidationJumpItem
              key={`${error.path}-${error.code}-${index}`}
              error={error}
              onJump={() => jump(error)}
            />
          ))}
        </ol>
      ) : null}

      {view.warnings.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {view.warnings.map((warning, index) => (
            <li
              key={`${warning.path}-${warning.code}-${index}`}
              className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
            >
              <p className="font-medium">{warning.path || "warning"}</p>
              <p className="mt-1 text-zinc-700">{warning.message}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {view.workflow.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-zinc-800">Workflow notes</h3>
          <ol className="mt-2 space-y-2">
            {view.workflow.map((error, index) => (
              <ValidationJumpItem
                key={`${error.path}-${error.code}-${index}`}
                error={error}
                onJump={() => jump(error)}
              />
            ))}
          </ol>
        </div>
      ) : null}

      {status === "invalid" &&
      errors.length === 0 &&
      problem &&
      !evaluationProblem ? (
        <p className="mt-3 text-sm text-amber-950">
          {safeProblemDetail(problem.detail)}
        </p>
      ) : null}

      <div className="mt-4 space-y-1 font-mono text-xs text-zinc-600">
        {policy.policyLabel ? <p>policy: {policy.policyLabel}</p> : null}
        {policy.boundsLabel ? <p>bounds: {policy.boundsLabel}</p> : null}
        {policy.redactionLabel ? <p>redaction: {policy.redactionLabel}</p> : null}
        {!policy.policyLabel && !policy.boundsLabel ? (
          <p>No catalog policy or bounds on this type.</p>
        ) : null}
      </div>

      <div className="mt-4 space-y-2 text-sm" data-ndv-evaluate>
        {evaluationPending ? (
          <p className="text-zinc-600">Evaluating published-version policy…</p>
        ) : null}
        {evaluationProblem ? (
          <p className="text-amber-950">
            {safeProblemDetail(evaluationProblem.detail)}
          </p>
        ) : null}
        {evaluateGap ? (
          <p role="status" className="text-amber-950">
            {evaluateGap}
          </p>
        ) : null}
        {scoped.publishedVersionInPlay && scoped.decisionLabel ? (
          <p>
            Evaluate: <span className="font-medium">{scoped.decisionLabel}</span>
            {scoped.dispatchAllowed === false ? " · dispatch blocked" : null}
            {scoped.dispatchAllowed === true ? " · dispatch allowed" : null}
          </p>
        ) : null}
        {!scoped.publishedVersionInPlay ? (
          <p className="text-zinc-600">{NDV_NO_DRAFT_EXECUTE_HELP}</p>
        ) : null}
        {scoped.denied.map((item, index) => (
          <p
            key={`${item.nodeId}-${item.operation}-${index}`}
            className="text-rose-900"
          >
            Denied {item.operation}
            {item.reason ? `: ${item.reason}` : ""}
          </p>
        ))}
        {scoped.requirements.map((item, index) => (
          <p key={`${item.nodeId}-${item.operation}-${index}`}>
            Requires approval for{" "}
            <code className="font-mono text-xs">{item.operation}</code>
            {item.approverRole ? ` · role ${item.approverRole}` : ""}
            {item.reason ? ` — ${item.reason}` : ""}
          </p>
        ))}
        {scoped.operations.map((item, index) =>
          item.retryMaxAttempts !== undefined || item.verificationDeclared ? (
            <p
              key={`${item.nodeId}-${item.operation}-retry-${index}`}
              className="font-mono text-xs text-zinc-600"
            >
              retryAllowed={String(item.retryAllowed ?? false)} retrySafe=
              {String(item.retrySafe ?? false)} maxAttempts=
              {item.retryMaxAttempts ?? 0}
              {item.verificationDeclared ? " verificationDeclared" : ""}
            </p>
          ) : null,
        )}
        {scoped.workflowNotes
          .filter((note) => note !== NDV_NO_DRAFT_EXECUTE_HELP)
          .map((note) => (
            <p key={note} className="text-xs text-zinc-600">
              {note}
            </p>
          ))}
        {approvals.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-zinc-600">{NDV_APPROVAL_DECIDE_HELP}</p>
            {approvals.map((item) => (
              <p key={item.id}>
                <Link
                  href={ndvDecideHref(item.id)}
                  className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                >
                  Decide approval {item.id}
                </Link>
                {item.status ? (
                  <span className="text-xs text-zinc-500"> · {item.status}</span>
                ) : null}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ValidationJumpItem({
  error,
  onJump,
}: {
  error: WorkflowFieldError;
  onJump: () => void;
}) {
  const location = formatFieldLocation(error);
  const jumpable = Boolean(error.line || error.path);
  return (
    <li className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      {jumpable ? (
        <button
          type="button"
          onClick={onJump}
          className="font-medium underline decoration-amber-300 underline-offset-2 hover:decoration-amber-700"
        >
          {error.path || "document"} {location}
        </button>
      ) : (
        <span className="font-medium">{error.path || "document"}</span>
      )}
      <p className="mt-1">{error.message}</p>
      <p className="mt-1 font-mono text-xs text-amber-900/80">{error.code}</p>
    </li>
  );
}

function uniqueApprovals(items: readonly ApprovalRequest[]): ApprovalRequest[] {
  const seen = new Set<string>();
  const out: ApprovalRequest[] = [];
  for (const item of items) {
    if (!item.id || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
