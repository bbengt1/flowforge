"use client";

import {
  typecheckSummary,
  type TypecheckError,
  type TypecheckView,
} from "@/lib/editor-typecheck";

/** Summary next to Publish. Never a pass while unavailable or stale. */
export function DraftTypecheckSummary({
  view,
  byNode,
  workflowErrors,
  onSelectNode,
}: {
  view: TypecheckView;
  byNode: Map<string, TypecheckError[]>;
  workflowErrors: TypecheckError[];
  onSelectNode: (nodeId: string) => void;
}) {
  if (view.state === "idle") {
    return null;
  }
  const tone =
    view.state === "failed"
      ? "text-danger"
      : view.state === "passed"
        ? "text-fg"
        : "text-fg-muted";
  return (
    <div
      role="status"
      data-typecheck-state={view.state}
      className={`text-xs ${tone}`}
    >
      <p>{typecheckSummary(view)}</p>
      {view.state === "failed" ? (
        <ul className="mt-1 space-y-0.5">
          {[...byNode.entries()].map(([nodeId, errors]) => (
            <li key={nodeId}>
              <button
                type="button"
                className="underline"
                onClick={() => onSelectNode(nodeId)}
              >
                {nodeId}
              </button>
              : {errors.length} {errors.length === 1 ? "problem" : "problems"}
            </li>
          ))}
          {workflowErrors.map((error, i) => (
            <li key={`wf-${i}`}>
              <code className="font-mono">{error.code}</code> {error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Errors for one node, shown in the node's panel. Codes and fixed messages only. */
export function NodeTypecheckErrors({
  nodeId,
  errors,
}: {
  nodeId: string;
  errors: readonly TypecheckError[] | undefined;
}) {
  if (!errors || errors.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={`Expression problems for ${nodeId}`}
      data-typecheck-node={nodeId}
      className="rounded border border-danger p-2 text-xs text-danger"
    >
      <p className="font-medium">Expression check</p>
      <ul className="mt-1 space-y-1">
        {errors.map((error, i) => (
          <li key={`${error.path}-${i}`}>
            <code className="font-mono">{error.code}</code> {error.message}
            {error.path ? (
              <span className="block font-mono text-[11px]">{error.path}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
