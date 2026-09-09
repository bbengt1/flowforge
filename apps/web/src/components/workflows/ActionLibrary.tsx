"use client";

import {
  ACTION_FAMILY_ORDER,
  actionFamilyLabel,
  actionPortHints,
  filterActionLibrary,
  type ActionLibraryEntry,
} from "@/lib/workflow-action-library";
import {
  catalogExcludesTriggerNodes,
  formatBounds,
  formatPolicy,
  formatPort,
  formatRedaction,
} from "@/lib/workflow-core-nodes";
import type { WorkflowCatalog } from "@/lib/workflow-types";

export const ACTION_DRAG_MIME = "application/x-flowforge-action";

type ActionLibraryProps = {
  catalog: WorkflowCatalog | null;
  entries: ActionLibraryEntry[];
  query: string;
  pending: boolean;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onInsert?: (entry: ActionLibraryEntry) => void;
  onOpenWizard?: (entry?: ActionLibraryEntry) => void;
};

export function ActionLibrary({
  catalog,
  entries,
  query,
  pending,
  onQuery,
  onRefresh,
  onInsert,
  onOpenWizard,
}: ActionLibraryProps) {
  const visible = filterActionLibrary(entries, query);
  const triggersWorkflowLevel = catalogExcludesTriggerNodes(catalog);
  const fromCatalog = entries.some((entry) => entry.source === "catalog");

  return (
    <section
      aria-labelledby="action-library-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="action-library-heading" className="text-base font-semibold">
            Action library
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Enabled catalog implementations only (
            <code className="font-mono text-xs">phase: core</code>
            {", next/provider if enabled"}). Triggers stay on{" "}
            <code className="font-mono text-xs">spec.triggers</code>
            {triggersWorkflowLevel ? " (rules.triggersAreWorkflowLevel)." : "."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {onOpenWizard ? (
            <button
              type="button"
              onClick={() => onOpenWizard()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900"
            >
              Add action
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            disabled={pending}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending ? "Loading…" : catalog ? "Refresh catalog" : "Load catalog"}
          </button>
        </div>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-zinc-600">Search</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="type, ports, policy…"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        />
      </label>

      <p className="mt-2 text-xs text-zinc-500">
        {fromCatalog
          ? "Ports, policy, and bounds come from GET /workflows/catalog. Kubernetes read/apply prefer GET /kubernetes/catalog nodes[] / errors[] / apply (#78) when listed. ssh.run prefers GET /ssh/catalog nodes[] / retry.ui / retry.probe (#90). Scripts prefer GET /scripts/catalog io / retry.ui / retry.probe (#101). Retry defaults to zero; maxAttempts>0 needs retrySafe + idempotencyKey + verification. Retry is gated on result.retry.allowed; POST …/retry is 409 when closed."
          : "Showing the published core-neutral, Kubernetes read/apply, ssh.run, and script contract fallback until catalogs load. Script typed I/O uses the marked e93-#101 map (GET /scripts/catalog io / retry.ui / retry.probe)."}
      </p>

      <div className="mt-4 max-h-[36rem] space-y-4 overflow-auto pr-1">
        {ACTION_FAMILY_ORDER.map((family) => {
          const items = visible.filter((entry) => entry.family === family && entry.placeable);
          if (items.length === 0) {
            return null;
          }
          return (
            <div key={family}>
              <h3 className="text-sm font-medium text-zinc-800">
                {actionFamilyLabel(family)}
              </h3>
              <ul className="mt-2 divide-y divide-zinc-100">
                {items.map((entry) => (
                  <li key={entry.type} className="py-2">
                    <div className="rounded-lg border border-transparent px-1 hover:border-zinc-200">
                      <div className="flex items-start justify-between gap-2">
                        <div
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData(ACTION_DRAG_MIME, entry.type);
                            event.dataTransfer.effectAllowed = "copy";
                          }}
                          className="min-w-0 cursor-grab"
                        >
                          <p className="text-sm font-medium text-zinc-900">
                            {entry.name}
                            {entry.source === "contract-fallback" ? (
                              <span className="ml-2 font-sans text-xs font-normal text-zinc-500">
                                contract-fallback
                              </span>
                            ) : null}
                          </p>
                          <p className="font-mono text-xs text-zinc-600">{entry.type}</p>
                        </div>
                        {onOpenWizard || onInsert ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (onOpenWizard) {
                                onOpenWizard(entry);
                                return;
                              }
                              onInsert?.(entry);
                            }}
                            className="rounded-md border border-teal-800 bg-teal-800 px-2 py-1 text-xs font-medium text-white hover:bg-teal-900"
                          >
                            Add
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-1 font-mono text-xs text-zinc-500">
                        {[
                          ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
                          ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
                        ].join(" · ") || actionPortHints(entry)}
                      </p>
                      {formatPolicy(entry.policy) ? (
                        <p className="mt-1 text-xs text-zinc-600">
                          policy: {formatPolicy(entry.policy)}
                        </p>
                      ) : null}
                      {formatBounds(entry.bounds) ? (
                        <p className="mt-0.5 text-xs text-zinc-500">
                          bounds: {formatBounds(entry.bounds)}
                        </p>
                      ) : null}
                      {formatRedaction(entry.redaction) ? (
                        <p className="mt-0.5 text-xs text-zinc-500">
                          redaction: {formatRedaction(entry.redaction)}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {visible.filter((entry) => entry.placeable).length === 0 ? (
          <p className="text-sm text-zinc-600">No enabled actions match that search.</p>
        ) : null}
      </div>
    </section>
  );
}
