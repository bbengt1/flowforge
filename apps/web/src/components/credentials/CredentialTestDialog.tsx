"use client";

import type { CredentialTestResult } from "@/lib/credential-types";
import {
  FF_VAULT_GHOST_CLASS,
  FF_VAULT_HELP_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_PRIMARY_CLASS,
  FF_VAULT_TITLE_CLASS,
} from "@/lib/vault-executions-visual";

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
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
    >
      <div className={`w-full max-w-lg ${FF_VAULT_PANEL_CLASS}`}>
        <h2 id="credential-test-heading" className={`text-lg ${FF_VAULT_TITLE_CLASS}`}>
          Test connection
        </h2>
        <p className={`mt-1 text-sm ${FF_VAULT_HELP_CLASS}`}>
          <code className="font-mono text-xs">POST .../test</code> checks the
          stored encrypted payload. This page never sends or displays
          plaintext. The API returns{" "}
          <code className="font-mono text-xs">
            {"{result:{status,reason,checkedAt},credential}"}
          </code>
          .
        </p>
        {result ? (
          <dl className="mt-4 grid gap-1 text-sm">
            <div>
              <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>status </dt>
              <dd className="inline font-medium">{result.status}</dd>
            </div>
            {result.checkedAt ? (
              <div>
                <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>checkedAt </dt>
                <dd className="inline font-mono text-xs">{result.checkedAt}</dd>
              </div>
            ) : null}
            {result.reason ? (
              <div>
                <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>reason </dt>
                <dd className="inline">{result.reason}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onTest}
            disabled={pending}
            className={FF_VAULT_PRIMARY_CLASS}
          >
            {pending ? "Testing…" : "Run test"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={FF_VAULT_GHOST_CLASS}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
