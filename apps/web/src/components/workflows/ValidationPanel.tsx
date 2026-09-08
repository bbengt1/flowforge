"use client";

import { formatFieldLocation } from "@/lib/workflow";
import type { WorkflowFieldError, WorkflowSummary } from "@/lib/workflow-types";
import { safeProblemDetail, type ProblemDetails } from "@/lib/problem";

type ValidationPanelProps = {
  status: "idle" | "pending" | "valid" | "invalid";
  errors: WorkflowFieldError[];
  warnings: WorkflowFieldError[];
  summary: WorkflowSummary | null;
  digest: string | null;
  problem: ProblemDetails | null;
  onJump: (line: number) => void;
  onSelectNode?: (id: string) => void;
};

export function ValidationPanel({
  status,
  errors,
  warnings,
  summary,
  digest,
  problem,
  onJump,
  onSelectNode,
}: ValidationPanelProps) {
  const showSummary = status === "valid" && summary && errors.length === 0;

  return (
    <section
      aria-labelledby="validation-heading"
      aria-live="polite"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="validation-heading" className="text-base font-semibold">
        Validation
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Debounced <code className="font-mono text-xs">POST /workflows/validate</code>.
        Invalid YAML shows <code className="font-mono text-xs">errors[]</code>{" "}
        only — no guessed graph.
      </p>

      <p className="mt-3 text-sm font-medium">
        {status === "idle"
          ? "Waiting for YAML"
          : status === "pending"
            ? "Validating…"
            : status === "valid"
              ? "Valid"
              : "Invalid"}
      </p>

      {status === "invalid" && errors.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {errors.map((error, index) => (
            <li
              key={`${error.path}-${error.code}-${index}`}
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
            >
              {error.line ? (
                <button
                  type="button"
                  onClick={() => onJump(error.line ?? 1)}
                  className="font-medium underline decoration-amber-300 underline-offset-2 hover:decoration-amber-700"
                >
                  {error.path || "document"} {formatFieldLocation(error)}
                </button>
              ) : (
                <span className="font-medium">{error.path || "document"}</span>
              )}
              <p className="mt-1">{error.message}</p>
              <p className="mt-1 font-mono text-xs text-amber-900/80">
                {error.code}
              </p>
            </li>
          ))}
        </ol>
      ) : null}

      {status === "invalid" && errors.length === 0 && problem ? (
        <p className="mt-3 text-sm text-amber-950">
          {safeProblemDetail(problem.detail)}
        </p>
      ) : null}

      {showSummary ? (
        <div className="mt-4 space-y-3 text-sm">
          {digest ? (
            <p>
              <span className="text-zinc-500">digest </span>
              <code className="break-all font-mono text-xs">{digest}</code>
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Count label="Triggers" value={summary.triggers.length} />
            <Count label="Nodes" value={summary.nodes.length} />
            <Count label="Edges" value={summary.edges.length} />
            <Count label="Outputs" value={summary.outputs.length} />
          </dl>
          <p className="text-zinc-700">
            <span className="font-medium">{summary.name}</span>
            {summary.description ? ` — ${summary.description}` : null}
          </p>
          <ul className="space-y-1 font-mono text-xs text-zinc-600">
            {summary.nodes.map((node) => (
              <li key={node.id}>
                {onSelectNode ? (
                  <button
                    type="button"
                    onClick={() => onSelectNode(node.id)}
                    className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                  >
                    {node.id} · {node.type}
                  </button>
                ) : (
                  <>
                    {node.id} · {node.type}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status === "valid" && warnings.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {warnings.map((warning, index) => (
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
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}
