"use client";

import { useEffect, useRef } from "react";
import { CredentialWizard } from "@/components/credentials/CredentialWizard";
import type { CredentialRecord, CredentialType } from "@/lib/credential-types";
import {
  captureSatelliteOverlayTrigger,
  restoreSatelliteOverlayFocus,
  satelliteOverlayAfterEscape,
  satelliteOverlayTriggerId,
} from "@/lib/rewrite-satellite-a11y";
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
  const overlayTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      overlayTrigger.current = null;
      return;
    }
    overlayTrigger.current =
      overlayTrigger.current ?? captureSatelliteOverlayTrigger();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      const next = satelliteOverlayAfterEscape();
      onClose();
      if (next.restoreFocus) {
        restoreSatelliteOverlayFocus(
          overlayTrigger.current ?? satelliteOverlayTriggerId("ndv-credential"),
        );
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
    </div>
  );
}
