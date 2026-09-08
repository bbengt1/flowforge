"use client";

import {
  catalogExcludesTriggerNodes,
  familyLabel,
  filterPaletteEntries,
  formatBounds,
  formatPolicy,
  formatPort,
  formatRedaction,
  type CoreNeutralPaletteEntry,
} from "@/lib/workflow-core-nodes";
import type { WorkflowCatalog } from "@/lib/workflow-types";

type CatalogPanelProps = {
  catalog: WorkflowCatalog | null;
  entries: CoreNeutralPaletteEntry[];
  query: string;
  pending: boolean;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onInsert: (entry: CoreNeutralPaletteEntry) => void;
};

export function CatalogPanel({
  catalog,
  entries,
  query,
  pending,
  onQuery,
  onRefresh,
  onInsert,
}: CatalogPanelProps) {
  const visible = filterPaletteEntries(entries, query);
  const groups = ["control", "data", "lifecycle"] as const;
  const triggersWorkflowLevel = catalogExcludesTriggerNodes(catalog);
  const fromCatalog = entries.some((entry) => entry.source === "catalog");

  return (
    <section
      aria-labelledby="catalog-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="catalog-heading" className="text-base font-semibold">
            Core nodes
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Placeable E3.3 palette from{" "}
            <code className="font-mono text-xs">GET /workflows/catalog</code>.
            Triggers stay on <code className="font-mono text-xs">spec.triggers</code>
            {triggersWorkflowLevel ? " (rules.triggersAreWorkflowLevel)." : "."}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Loading…" : catalog ? "Refresh catalog" : "Load catalog"}
        </button>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-zinc-600">Filter</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="type, allowedWith, port…"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        />
      </label>

      <p className="mt-2 text-xs text-zinc-500">
        {fromCatalog
          ? "allowedWith, policy, bounds, redaction, and port classification/maxBytes come from the catalog contract."
          : "Showing the published #32 contract fallback until GET /workflows/catalog is available locally."}
      </p>

      <div className="mt-4 space-y-4">
        {groups.map((family) => {
          const items = visible.filter((entry) => entry.family === family);
          if (items.length === 0) {
            return null;
          }
          return (
            <div key={family}>
              <h3 className="text-sm font-medium text-zinc-800">
                {familyLabel(family)}
              </h3>
              <ul className="mt-2 divide-y divide-zinc-100">
                {items.map((entry) => (
                  <li key={entry.type} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-zinc-900">
                          {entry.name}
                        </p>
                        <p className="font-mono text-xs text-zinc-600">{entry.type}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onInsert(entry)}
                        className="rounded-md border border-teal-800 bg-teal-800 px-2 py-1 text-xs font-medium text-white hover:bg-teal-900"
                      >
                        Insert
                      </button>
                    </div>
                    <p className="mt-1 font-mono text-xs text-zinc-500">
                      {[
                        ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
                        ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
                      ].join(" · ") || "no ports"}
                    </p>
                    {entry.allowedWith.length > 0 ? (
                      <p className="mt-0.5 text-xs text-zinc-500">
                        allowedWith:{" "}
                        {entry.allowedWith
                          .map((field) => (field.required ? `${field.name}*` : field.name))
                          .join(", ")}
                      </p>
                    ) : entry.requiredWith.length > 0 ? (
                      <p className="mt-0.5 text-xs text-zinc-500">
                        requiredWith: {entry.requiredWith.join(", ")}
                      </p>
                    ) : null}
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
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {visible.length === 0 ? (
          <p className="text-sm text-zinc-600">No core nodes match that filter.</p>
        ) : null}
      </div>
    </section>
  );
}
