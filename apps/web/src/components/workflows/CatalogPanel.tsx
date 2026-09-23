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
      className="rounded-2xl border border-border bg-bg p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="catalog-heading" className="text-base font-semibold">
            Core nodes
          </h2>
          <p className="mt-1 text-sm text-fg">
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
          className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-60"
        >
          {pending ? "Loading…" : catalog ? "Refresh catalog" : "Load catalog"}
        </button>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-fg">Filter</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="type, allowedWith, port…"
          className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
        />
      </label>

      <p className="mt-2 text-xs text-fg">
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
              <h3 className="text-sm font-medium text-fg">
                {familyLabel(family)}
              </h3>
              <ul className="mt-2 divide-y divide-border">
                {items.map((entry) => (
                  <li key={entry.type} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-fg">
                          {entry.name}
                        </p>
                        <p className="font-mono text-xs text-fg">{entry.type}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onInsert(entry)}
                        className="rounded-md border border-teal-800 bg-teal-800 px-2 py-1 text-xs font-medium text-white hover:bg-teal-900"
                      >
                        Insert
                      </button>
                    </div>
                    <p className="mt-1 font-mono text-xs text-fg">
                      {[
                        ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
                        ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
                      ].join(" · ") || "no ports"}
                    </p>
                    {entry.allowedWith.length > 0 ? (
                      <p className="mt-0.5 text-xs text-fg">
                        allowedWith:{" "}
                        {entry.allowedWith
                          .map((field) => (field.required ? `${field.name}*` : field.name))
                          .join(", ")}
                      </p>
                    ) : entry.requiredWith.length > 0 ? (
                      <p className="mt-0.5 text-xs text-fg">
                        requiredWith: {entry.requiredWith.join(", ")}
                      </p>
                    ) : null}
                    {formatPolicy(entry.policy) ? (
                      <p className="mt-1 text-xs text-fg">
                        policy: {formatPolicy(entry.policy)}
                      </p>
                    ) : null}
                    {formatBounds(entry.bounds) ? (
                      <p className="mt-0.5 text-xs text-fg">
                        bounds: {formatBounds(entry.bounds)}
                      </p>
                    ) : null}
                    {formatRedaction(entry.redaction) ? (
                      <p className="mt-0.5 text-xs text-fg">
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
          <p className="text-sm text-fg">No core nodes match that filter.</p>
        ) : null}
      </div>
    </section>
  );
}
