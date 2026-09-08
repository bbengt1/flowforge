"use client";

import type { CredentialTestResult } from "@/lib/credential-types";

type CredentialTestDialogProps = {
  open: boolean;
  pending: boolean;
  result: CredentialTestResult | null;
  onTest: () => void;
  onClose: () => void;
};

export function CredentialTestDialog({
  open,
  pending,
  result,
  onTest,
  onClose,
}: CredentialTestDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-test-heading"
      className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-900/40 p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg">
        <h2 id="credential-test-heading" className="text-lg font-semibold">
          Test connection
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          The control plane tests the stored encrypted payload. This page
          never sends or displays plaintext. Results are status and
          timestamp only.
        </p>
        {result ? (
          <dl className="mt-4 grid gap-1 text-sm">
            <div>
              <dt className="inline text-zinc-500">status </dt>
              <dd className="inline font-medium">{result.status}</dd>
            </div>
            {result.testedAt ? (
              <div>
                <dt className="inline text-zinc-500">tested_at </dt>
                <dd className="inline font-mono text-xs">{result.testedAt}</dd>
              </div>
            ) : null}
            {result.message ? (
              <div>
                <dt className="inline text-zinc-500">message </dt>
                <dd className="inline">{result.message}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onTest}
            disabled={pending}
            className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
          >
            {pending ? "Testing…" : "Run test"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
