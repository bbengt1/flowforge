"use client";

import { shortDigest } from "@/lib/workflow";
import type { WorkflowRecord } from "@/lib/workflow-types";

type WorkflowListProps = {
  items: WorkflowRecord[];
  selectedId: string | null;
  pending: boolean;
  slug: string;
  name: string;
  onSlug: (value: string) => void;
  onName: (value: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
  onSelect: (workflow: WorkflowRecord) => void;
};

export function WorkflowList({
  items,
  selectedId,
  pending,
  slug,
  name,
  onSlug,
  onName,
  onRefresh,
  onCreate,
  onSelect,
}: WorkflowListProps) {
  return (
    <section
      aria-labelledby="workflow-list-heading"
      className="rounded-2xl border border-border bg-bg p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workflow-list-heading" className="text-base font-semibold">
            Workflows
          </h2>
          <p className="mt-1 text-sm text-fg">
            Create or import from the editor YAML. Host-supplied{" "}
            <code className="font-mono text-xs">id</code> /{" "}
            <code className="font-mono text-xs">workspaceId</code> are never sent.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-60"
        >
          {pending ? "Loading…" : "Refresh list"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="block text-sm">
          <span className="text-fg">Slug (optional)</span>
          <input
            value={slug}
            onChange={(event) => onSlug(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 font-mono text-sm"
            autoComplete="off"
          />
        </label>
        <label className="block text-sm">
          <span className="text-fg">Name (optional)</span>
          <input
            value={name}
            onChange={(event) => onName(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm"
            autoComplete="off"
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={onCreate}
            disabled={pending}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create / import"}
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-fg">
          No workflows in this workspace yet. Create one from the editor YAML.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  disabled={pending}
                  className={
                    selected
                      ? "flex w-full flex-col gap-1 rounded-lg bg-teal-50 px-3 py-2 text-left disabled:opacity-60"
                      : "flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-fg/10 disabled:opacity-60"
                  }
                >
                  <span className={`font-medium ${selected ? "text-teal-950" : "text-fg"}`}>
                    {item.name}
                  </span>
                  <span className={`font-mono text-xs ${selected ? "text-teal-900" : "text-fg"}`}>
                    {item.slug} · {item.status} · rev {item.draftRevision}
                    {item.latestVersionNumber
                      ? ` · v${item.latestVersionNumber}`
                      : " · unpublished"}
                  </span>
                  {item.draftDigest ? (
                    <span className={`font-mono text-xs ${selected ? "text-teal-900" : "text-fg"}`}>
                      draft {shortDigest(item.draftDigest)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
