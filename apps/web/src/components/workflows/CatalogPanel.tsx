"use client";

import type { WorkflowCatalog } from "@/lib/workflow-types";

type CatalogPanelProps = {
  catalog: WorkflowCatalog | null;
  pending: boolean;
  onRefresh: () => void;
};

export function CatalogPanel({ catalog, pending, onRefresh }: CatalogPanelProps) {
  return (
    <section
      aria-labelledby="catalog-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="catalog-heading" className="text-base font-semibold">
            Core catalog
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Palette shows <code className="font-mono text-xs">phase: core</code>{" "}
            only. Next and provider types fail closed.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Load catalog"}
        </button>
      </div>

      {!catalog ? (
        <p className="mt-4 text-sm text-zinc-600">
          Load the catalog after session + workspace identity are set.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <CatalogGroup
            title="Triggers"
            items={catalog.triggers.map((item) => ({
              type: item.type,
              ports: (item.outputs ?? []).map((port) => port.name),
              required: [],
            }))}
          />
          <CatalogGroup
            title="Nodes"
            items={catalog.nodes.map((item) => ({
              type: item.type,
              ports: [
                ...(item.inputs ?? []).map((port) => `in:${port.name}`),
                ...(item.outputs ?? []).map((port) => `out:${port.name}`),
              ],
              required: item.requiredWith ?? [],
            }))}
          />
        </div>
      )}
    </section>
  );
}

function CatalogGroup({
  title,
  items,
}: {
  title: string;
  items: Array<{ type: string; ports: string[]; required: string[] }>;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-zinc-800">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600">None enabled.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100">
          {items.map((item) => (
            <li key={item.type} className="py-2">
              <p className="font-mono text-sm text-zinc-900">{item.type}</p>
              {item.required.length > 0 ? (
                <p className="mt-0.5 text-xs text-zinc-500">
                  requiredWith: {item.required.join(", ")}
                </p>
              ) : null}
              {item.ports.length > 0 ? (
                <p className="mt-0.5 font-mono text-xs text-zinc-500">
                  {item.ports.join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
