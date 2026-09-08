"use client";

import { compareRefLabel, shortDigest } from "@/lib/workflow";
import type {
  CompareKind,
  CompareWorkflowResult,
  WorkflowVersion,
} from "@/lib/workflow-types";

type VersionHistoryProps = {
  versions: WorkflowVersion[];
  pending: string | null;
  dirty: boolean;
  compareLeft: CompareKind | string;
  compareRight: string;
  compare: CompareWorkflowResult | null;
  onCompareLeft: (value: string) => void;
  onCompareRight: (value: string) => void;
  onCompare: () => void;
  onExport: (version: WorkflowVersion) => void;
  onRestore: (version: WorkflowVersion) => void;
};

export function VersionHistory({
  versions,
  pending,
  dirty,
  compareLeft,
  compareRight,
  compare,
  onCompareLeft,
  onCompareRight,
  onCompare,
  onExport,
  onRestore,
}: VersionHistoryProps) {
  const busy = pending !== null;

  return (
    <section
      aria-labelledby="version-history-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="version-history-heading" className="text-base font-semibold">
        Versions
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Immutable published snapshots. Export, compare (draft vs version or
        version vs version), or restore-as-new-draft. Restore never mutates the
        version. Save the draft before restore — unsaved editor edits are not
        discarded.
      </p>

      {versions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          No published versions yet. Publish the saved draft to create the first
          immutable snapshot.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-zinc-100">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div>
                <p className="font-medium">
                  v{version.versionNumber}
                  {version.publishNote ? ` — ${version.publishNote}` : null}
                </p>
                <p className="font-mono text-xs break-all text-zinc-500">
                  {version.digest}
                </p>
                <p className="text-xs text-zinc-500">{version.publishedAt}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onExport(version)}
                  disabled={busy}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={() => onRestore(version)}
                  disabled={busy || dirty}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
                >
                  Restore as new draft
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="block text-sm">
          <span className="text-zinc-600">Compare left</span>
          <select
            value={compareLeft}
            onChange={(event) => onCompareLeft(event.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="draft">Current draft</option>
            {versions.map((version) => (
              <option key={`left-${version.id}`} value={version.id}>
                {compareRefLabel("version", version)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-zinc-600">Compare right</span>
          <select
            value={compareRight}
            onChange={(event) => onCompareRight(event.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Select a side</option>
            <option value="draft">Current draft</option>
            {versions.map((version) => (
              <option key={`right-${version.id}`} value={version.id}>
                {compareRefLabel("version", version)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={onCompare}
            disabled={busy || !compareRight}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending === "compare" ? "Comparing…" : "Compare"}
          </button>
        </div>
      </div>

      {compare ? (
        <div className="mt-4 space-y-2 text-sm">
          <p>
            {compare.equal ? "Equal" : "Different"}
            {compare.digestMatch ? " · digests match" : " · digests differ"}
          </p>
          <p className="font-mono text-xs break-all text-zinc-500">
            left {shortDigest(compare.leftDigest)} · right{" "}
            {shortDigest(compare.rightDigest)}
          </p>
          {compare.changes.length === 0 ? (
            <p className="text-zinc-600">No structured changes.</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-zinc-700">
              {compare.changes.map((change, index) => (
                <li key={`${change.path}-${change.op}-${index}`}>
                  {change.op} {change.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
