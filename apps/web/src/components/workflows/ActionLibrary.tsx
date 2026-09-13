"use client";

import { useState } from "react";
import {
  actionPortHints,
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
import {
  dohertyBegin,
  type DohertyChrome,
} from "@/lib/doherty-pending-chrome";
import { DohertyStatus } from "@/components/chrome/DohertyStatus";
import {
  PALETTE_CATEGORY_FIRST_HELP,
  PALETTE_CATEGORY_LABELS,
  PALETTE_CATALOG_UNAVAILABLE_HELP,
  paletteFirstPaint,
  type PaletteCategoryId,
} from "@/lib/palette-category-first";

export const ACTION_DRAG_MIME = "application/x-flowforge-action";

type ActionLibraryProps = {
  catalog: WorkflowCatalog | null;
  entries: ActionLibraryEntry[];
  query: string;
  pending: boolean;
  doherty?: DohertyChrome;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onInsert?: (entry: ActionLibraryEntry) => void;
  onOpenWizard?: (entry?: ActionLibraryEntry) => void;
  compact?: boolean;
};

export function ActionLibrary({
  catalog,
  entries,
  query,
  pending,
  doherty,
  onQuery,
  onRefresh,
  onInsert,
  onOpenWizard,
  compact = false,
}: ActionLibraryProps) {
  const [selectedCategory, setSelectedCategory] =
    useState<PaletteCategoryId | null>(null);
  const paint = paletteFirstPaint({
    entries,
    catalog,
    query,
    selectedCategory,
    pending,
  });
  const triggersWorkflowLevel = catalogExcludesTriggerNodes(catalog);
  const fromCatalog = entries.some((entry) => entry.source === "catalog");
  const catalogChrome: DohertyChrome | undefined = doherty?.gesture === "catalog"
    ? doherty
    : pending
      ? dohertyBegin("catalog")
      : undefined;

  return (
    <section
      aria-labelledby="action-library-heading"
      className={
        compact
          ? "bg-white p-3"
          : "rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="action-library-heading" className="text-base font-semibold">
            Action library
          </h2>
          {compact ? (
            <p className="mt-1 text-xs text-zinc-600">
              {PALETTE_CATEGORY_FIRST_HELP} Triggers stay workflow-level.
            </p>
          ) : (
            <p className="mt-1 text-sm text-zinc-600">
              Category-first first paint of the enabled catalog (
              <code className="font-mono text-xs">phase: core</code>
              {", next/provider if enabled"}). Search still reaches any enabled
              type. Triggers stay on{" "}
              <code className="font-mono text-xs">spec.triggers</code>
              {triggersWorkflowLevel ? " (rules.triggersAreWorkflowLevel)." : "."}
            </p>
          )}
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
            aria-busy={pending}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending ? "Loading…" : catalog ? "Refresh catalog" : "Load catalog"}
          </button>
        </div>
      </div>
      {catalogChrome ? (
        <div className="mt-2" data-doherty-chrome="catalog">
          <DohertyStatus chrome={catalogChrome} />
        </div>
      ) : null}

      <label className="mt-4 block text-sm">
        <span className="text-zinc-600">Search</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="type, ports, policy…"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        />
      </label>

      {compact ? null : (
        <p className="mt-2 text-xs text-zinc-500">
          {fromCatalog
            ? "Ports, policy, and bounds come from GET /workflows/catalog. Kubernetes read/apply prefer GET /kubernetes/catalog nodes[] / errors[] / apply (#78) when listed. ssh.run prefers GET /ssh/catalog nodes[] / retry.ui / retry.probe (#90). Scripts prefer GET /scripts/catalog io / retry.ui / retry.probe (#101) plus revocation / emergencyStop (#103). HTTP/notification prefer GET /http/catalog + httpNotificationEngine (#118) and hide when the integration gate is off. Retry defaults to zero; maxAttempts>0 needs retrySafe + idempotencyKey + verification. Retry is gated on result.retry.allowed; POST …/retry is 409 when closed. Revoked artifacts cannot start; emergency stop is distinct from cancel."
            : "Palette first paint waits for GET /workflows/catalog, then shows enabled categories only. Empty or unauthorized catalogs fail closed — no invented types. Script typed I/O uses the marked e93-#101 map. Revoke/stop uses the marked e94-#103 map (GET /scripts/catalog revocation / emergencyStop). HTTP/notification uses the marked e104-#118 map."}
        </p>
      )}

      <div
        data-uxl7="palette"
        data-uxl7-paint={paint.kind}
        className={compact ? "mt-3 space-y-3 pr-1" : "mt-4 max-h-[36rem] space-y-4 overflow-auto pr-1"}
      >
        {paint.kind === "categories" ? (
          <div data-uxl7="categories">
            <h3 className="text-sm font-medium text-zinc-800">Categories</h3>
            <ul className="mt-2 space-y-2">
              {paint.categories.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    data-uxl7-category={group.id}
                    onClick={() => setSelectedCategory(group.id)}
                    className="flex w-full items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:border-zinc-400"
                  >
                    <span className="font-medium text-zinc-900">
                      {PALETTE_CATEGORY_LABELS[group.id]}
                    </span>
                    <span className="text-xs text-zinc-600">
                      {group.items.length} enabled
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {paint.kind === "category" ? (
          <div>
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              className="text-xs font-medium text-teal-800 underline"
            >
              All categories
            </button>
            <h3 className="mt-2 text-sm font-medium text-zinc-800">
              {paint.selectedCategory
                ? PALETTE_CATEGORY_LABELS[paint.selectedCategory]
                : "Category"}
            </h3>
          </div>
        ) : null}
        {paint.kind === "search" ? (
          <h3 className="text-sm font-medium text-zinc-800">Search results</h3>
        ) : null}
        {paint.kind === "unavailable" ? (
          <p className="text-sm text-zinc-600" role="status">
            {paint.unavailableReason ?? PALETTE_CATALOG_UNAVAILABLE_HELP}
          </p>
        ) : null}
        {paint.kind === "category" || paint.kind === "search" ? (
          <ul className="divide-y divide-zinc-100">
            {paint.items.map((entry) => (
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
        ) : null}
        {paint.kind === "search" && paint.items.length === 0 ? (
          <p className="text-sm text-zinc-600">No enabled actions match that search.</p>
        ) : null}
      </div>
    </section>
  );
}
