"use client";

import { useEffect } from "react";
import { CredentialWizard } from "@/components/credentials/CredentialWizard";
import type { CredentialRecord, CredentialType } from "@/lib/credential-types";

type CredentialWizardDialogProps = {
  open: boolean;
  allowedTypes?: readonly CredentialType[];
  onCreated: (credential: CredentialRecord) => void;
  onClose: () => void;
};

export function CredentialWizardDialog({
  open,
  allowedTypes,
  onCreated,
  onClose,
}: CredentialWizardDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="inspector-credential-wizard-heading"
      className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-zinc-900/40 p-4"
    >
      <div className="my-8 w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
              Add vault credential
            </p>
            <h2
              id="inspector-credential-wizard-heading"
              className="mt-1 text-lg font-semibold"
            >
              Masked credential wizard
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Close
          </button>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          Guided add on this graph — you return to the selected node.
          Secret fields stay in this wizard and clear after create. The
          inspector only receives the display name and workspace UUID —
          never plaintext, kubeconfig, or rotate UI.
        </p>
        <div className="mt-4">
          <CredentialWizard
            variant="modal"
            allowedTypes={allowedTypes}
            onCreated={onCreated}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}
