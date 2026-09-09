"use client";

import Link from "next/link";
import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import { OPS_CONFIG_COLLECTIONS } from "@/lib/ops-config-contract";
import type { OpsConfigKind, OpsConfigVersion } from "@/lib/ops-config-types";

type ClientCompare = {
  equal: boolean;
  digestMatch: boolean;
  changes: Array<{ path: string; message?: string }>;
};

type ConfigVersionHistoryProps = {
  kind: OpsConfigKind;
  resourceId: string;
  versions: OpsConfigVersion[];
  pending: boolean;
  compareLeft: string;
  compareRight: string;
  compare: ClientCompare | null;
  onCompareLeft: (value: string) => void;
  onCompareRight: (value: string) => void;
  onCompare: () => void;
  onRestore: (version: OpsConfigVersion) => void;
};

export function ConfigVersionHistory({
  kind,
  resourceId,
  versions,
  pending,
  compareLeft,
  compareRight,
  compare,
  onCompareLeft,
  onCompareRight,
  onCompare,
  onRestore,
}: ConfigVersionHistoryProps) {
  return (
    <section
      aria-labelledby="config-versions-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="config-versions-heading" className="text-base font-semibold">
        Version history
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Publish creates an immutable revision. Published detail is read-only.
        Restore PUTs the snapshot spec into the current draft — there is no
        restore route. Compare is client-side spec JSON only.
      </p>

      {versions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          No published versions yet. Save the draft, then publish to pin the
          first immutable revision.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-zinc-100">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="space-y-1">
                <VersionPinBadge
                  name={`v${version.versionNumber}`}
                  versionNumber={version.versionNumber}
                  digest={version.digest}
                  readOnly
                />
                {version.publishNote ? (
                  <p className="text-sm text-zinc-600">{version.publishNote}</p>
                ) : null}
                <p className="text-xs text-zinc-500">{version.publishedAt}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/config/${OPS_CONFIG_COLLECTIONS[kind]}/${resourceId}/versions/${version.id}`}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                >
                  Open read-only
                </Link>
                <button
                  type="button"
                  onClick={() => onRestore(version)}
                  disabled={pending}
                  className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-60"
                >
                  Restore into draft
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {versions.length > 0 ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-sm">
            <span className="font-medium">Compare left</span>
            <select
              value={compareLeft}
              onChange={(event) => onCompareLeft(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              <option value="draft">Current draft</option>
              {versions.map((version) => (
                <option key={`left-${version.id}`} value={version.id}>
                  v{version.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium">Compare right</span>
            <select
              value={compareRight}
              onChange={(event) => onCompareRight(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              {versions.map((version) => (
                <option key={`right-${version.id}`} value={version.id}>
                  v{version.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={onCompare}
              disabled={pending || !compareRight}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-60"
            >
              Compare specs
            </button>
          </div>
        </div>
      ) : null}

      {compare ? (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
          <p>
            {compare.equal ? "Equal" : "Different"}
            {compare.digestMatch ? " · specs match" : " · specs differ"}
          </p>
          {compare.changes.length ? (
            <ul className="mt-2 list-disc pl-5 font-mono text-xs">
              {compare.changes.map((change) => (
                <li key={`${change.path}:${change.message ?? ""}`}>
                  {change.path}
                  {change.message ? ` — ${change.message}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
