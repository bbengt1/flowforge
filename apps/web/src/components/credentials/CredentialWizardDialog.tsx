"use client";

import { CredentialWizard } from "@/components/credentials/CredentialWizard";
import { Dialog } from "@/components/a11y/Dialog";
import type { CredentialRecord, CredentialType } from "@/lib/credential-types";
import { satelliteOverlayTriggerId } from "@/lib/rewrite-satellite-a11y";
import {
  FF_VAULT_EYEBROW_CLASS,
  FF_VAULT_GHOST_CLASS,
  FF_VAULT_HELP_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_TITLE_CLASS,
} from "@/lib/vault-executions-visual";

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
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="inspector-credential-wizard-heading"
      returnFocusTo={satelliteOverlayTriggerId("ndv-credential")}
      className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-black/60 p-4"
    >
      <div className={`my-8 w-full max-w-3xl ${FF_VAULT_PANEL_CLASS}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className={FF_VAULT_EYEBROW_CLASS}>
              Add vault credential
            </p>
            <h2
              id="inspector-credential-wizard-heading"
              className={`mt-1 text-lg ${FF_VAULT_TITLE_CLASS}`}
            >
              Masked credential wizard
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={FF_VAULT_GHOST_CLASS}
          >
            Close
          </button>
        </div>
        <p className={`mt-2 text-sm ${FF_VAULT_HELP_CLASS}`}>
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
    </Dialog>
  );
}
