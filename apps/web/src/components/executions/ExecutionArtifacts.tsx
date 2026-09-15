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
import {
  FF_INBOX_EMPTY_CLASS,
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PANEL_CLASS,
  FF_INBOX_PRIMARY_CLASS,
  FF_INBOX_TITLE_CLASS,
  FF_LOUD_WARNING_CLASS,
} from "@/lib/vault-executions-visual";

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
    <section className={FF_INBOX_PANEL_CLASS}>
      <h2 className={`text-lg ${FF_INBOX_TITLE_CLASS}`}>Artifacts</h2>
      <p className={`mt-1 text-sm ${FF_INBOX_MUTED_CLASS}`}>{ARTIFACT_METADATA_HELP}</p>
      <p className={`mt-1 text-xs ${FF_INBOX_MUTED_CLASS}`}>{DOWNLOAD_GRANT_HELP}</p>
      <p className={`mt-1 text-xs ${FF_INBOX_MUTED_CLASS}`}>{DOWNLOAD_CSRF_HELP}</p>
      <p className="mt-3 text-sm">
        {retentionStatusMessage({
          retentionUntil,
          legalHold,
        })}
      </p>
      {legalHold ? (
        <p role="status" className={`mt-2 text-sm ${FF_LOUD_WARNING_CLASS}`}>
          {LEGAL_HOLD_HELP}
        </p>
      ) : null}

      {artifacts.length === 0 ? (
        <p className={`mt-3 text-sm ${FF_INBOX_MUTED_CLASS}`}>
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
                    ? `rounded-xl p-4 ${FF_LOUD_WARNING_CLASS}`
                    : artifact.deleted
                      ? FF_INBOX_EMPTY_CLASS
                      : FF_INBOX_PANEL_CLASS
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {artifact.name || artifact.digest || artifact.id}
                    </p>
                    <p className={`font-mono text-xs break-all ${FF_INBOX_MUTED_CLASS}`}>
                      {artifact.id}
                    </p>
                  </div>
                  {artifact.deleted && !artifact.legalHold ? (
                    <ExecutionStatusBadge status="canceled" />
                  ) : artifact.legalHold ? (
                    <p className={`text-xs font-semibold ${FF_LOUD_WARNING_CLASS}`}>
                      Legal hold
                    </p>
                  ) : null}
                </div>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Digest</dt>
                    <dd className="font-mono break-all">
                      {artifact.digest || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Size</dt>
                    <dd className="font-mono">
                      {formatArtifactSize(artifact.sizeBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Classification</dt>
                    <dd>{artifact.classification || "—"}</dd>
                  </div>
                  <div>
                    <dt className={FF_INBOX_MUTED_CLASS}>Retention</dt>
                    <dd className="font-mono">
                      {artifact.retentionUntil || retentionUntil || "—"}
                    </dd>
                  </div>
                  {artifact.kind ? (
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Kind</dt>
                      <dd className="font-mono">{artifact.kind}</dd>
                    </div>
                  ) : null}
                </dl>
                {artifact.deleted && !artifact.legalHold ? (
                  <p className={`mt-3 text-sm ${FF_INBOX_MUTED_CLASS}`}>{RETENTION_HELP}</p>
                ) : null}
                {downloadable ? (
                  <button
                    type="button"
                    onClick={() => onDownload(artifact)}
                    disabled={disabled || pendingId === artifact.id}
                    className={`mt-3 ${FF_INBOX_PRIMARY_CLASS}`}
                  >
                    {pendingId === artifact.id
                      ? "Downloading…"
                      : "Download"}
                  </button>
                ) : (
                  <p className={`mt-3 text-sm ${FF_INBOX_MUTED_CLASS}`}>
                    Download is unavailable after retention deletion.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {message ? (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
