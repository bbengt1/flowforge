"use client";

import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import {
  ARTIFACT_METADATA_HELP,
  DOWNLOAD_CSRF_HELP,
  DOWNLOAD_GRANT_HELP,
  LEGAL_HOLD_HELP,
  RETENTION_HELP,
} from "@/lib/execution-contract";
import {
  canDownloadArtifact,
  formatArtifactSize,
  retentionStatusMessage,
} from "@/lib/execution";
import type { ExecutionArtifact } from "@/lib/execution-types";

type ExecutionArtifactsProps = {
  artifacts: ExecutionArtifact[];
  retentionUntil?: string;
  legalHold?: boolean;
  pendingId?: string | null;
  message?: string | null;
  disabled?: boolean;
  onDownload: (artifact: ExecutionArtifact) => void;
};

export function ExecutionArtifacts({
  artifacts,
  retentionUntil,
  legalHold,
  pendingId,
  message,
  disabled,
  onDownload,
}: ExecutionArtifactsProps) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Artifacts</h2>
      <p className="mt-1 text-sm text-zinc-600">{ARTIFACT_METADATA_HELP}</p>
      <p className="mt-1 text-xs text-zinc-500">{DOWNLOAD_GRANT_HELP}</p>
      <p className="mt-1 text-xs text-zinc-500">{DOWNLOAD_CSRF_HELP}</p>
      <p className="mt-3 text-sm text-zinc-700">
        {retentionStatusMessage({
          retentionUntil,
          legalHold,
        })}
      </p>
      {legalHold ? (
        <p role="status" className="mt-2 text-sm font-medium text-amber-950">
          {LEGAL_HOLD_HELP}
        </p>
      ) : null}

      {artifacts.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-600">
          No artifact metadata returned. Encrypted object payloads are never
          listed as durable URLs.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {artifacts.map((artifact) => {
            const downloadable = canDownloadArtifact(artifact);
            return (
              <li
                key={artifact.id}
                className={
                  artifact.legalHold
                    ? "rounded-xl border-2 border-amber-700 bg-amber-50 p-4"
                    : artifact.deleted
                      ? "rounded-xl border border-zinc-300 bg-zinc-50 p-4"
                      : "rounded-xl border border-zinc-200 p-4"
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {artifact.name || artifact.digest || artifact.id}
                    </p>
                    <p className="font-mono text-xs break-all text-zinc-600">
                      {artifact.id}
                    </p>
                  </div>
                  {artifact.deleted && !artifact.legalHold ? (
                    <ExecutionStatusBadge status="canceled" />
                  ) : artifact.legalHold ? (
                    <p className="text-xs font-semibold text-amber-950">
                      Legal hold
                    </p>
                  ) : null}
                </div>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-zinc-500">Digest</dt>
                    <dd className="font-mono break-all">
                      {artifact.digest || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Size</dt>
                    <dd className="font-mono">
                      {formatArtifactSize(artifact.sizeBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Classification</dt>
                    <dd>{artifact.classification || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Retention</dt>
                    <dd className="font-mono">
                      {artifact.retentionUntil || retentionUntil || "—"}
                    </dd>
                  </div>
                  {artifact.kind ? (
                    <div>
                      <dt className="text-zinc-500">Kind</dt>
                      <dd className="font-mono">{artifact.kind}</dd>
                    </div>
                  ) : null}
                </dl>
                {artifact.deleted && !artifact.legalHold ? (
                  <p className="mt-3 text-sm text-zinc-600">{RETENTION_HELP}</p>
                ) : null}
                {downloadable ? (
                  <button
                    type="button"
                    onClick={() => onDownload(artifact)}
                    disabled={disabled || pendingId === artifact.id}
                    className="mt-3 rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
                  >
                    {pendingId === artifact.id
                      ? "Requesting grant…"
                      : "Download"}
                  </button>
                ) : (
                  <p className="mt-3 text-sm text-zinc-600">
                    Download is unavailable after retention deletion.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {message ? (
        <p role="status" className="mt-3 text-sm text-zinc-800">
          {message}
        </p>
      ) : null}
    </section>
  );
}
