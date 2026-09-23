"use client";

import { ConfirmDestructive } from "@/components/a11y/ConfirmDestructive";
import { Field } from "@/components/a11y/Field";
import { credentialDeleteImpactItems } from "@/lib/confirm-destructive";
import { deletionConfirmationState, formatRef } from "@/lib/credential";
import type { CredentialDeletionImpact } from "@/lib/credential-types";
import {
  FF_VAULT_CONTROL_CLASS,
  FF_VAULT_DANGER_CLASS,
  FF_VAULT_GHOST_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_TITLE_CLASS,
} from "@/lib/vault-executions-visual";

type DeleteImpactDialogProps = {
  open: boolean;
  pending: boolean;
  impact: CredentialDeletionImpact | null;
  typedName: string;
  onTypedName: (value: string) => void;
  onLoadImpact: () => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function DeleteImpactDialog({
  open,
  pending,
  impact,
  typedName,
  onTypedName,
  onLoadImpact,
  onConfirm,
  onClose,
}: DeleteImpactDialogProps) {
  if (!open) {
    return null;
  }

  const confirmation = deletionConfirmationState(impact, typedName);

  return (
    <ConfirmDestructive
      open
      onClose={onClose}
      title="Confirm deletion"
      reversibility="irreversible"
      confirmLabel="Delete credential"
      pending={pending}
      pendingLabel="Deleting…"
      canConfirm={confirmation.canProceed}
      onConfirm={onConfirm}
      backdropClassName="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
      panelClassName={`max-h-[90vh] w-full max-w-xl overflow-auto ${FF_VAULT_PANEL_CLASS}`}
      titleClassName={FF_VAULT_TITLE_CLASS}
      mutedClassName={FF_VAULT_MUTED_CLASS}
      confirmClassName={`${FF_VAULT_DANGER_CLASS} rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-60`}
      cancelClassName={FF_VAULT_GHOST_CLASS}
      description={
        <>
          Deletion-impact is already on the detail page from{" "}
          <code className="font-mono text-xs">GET .../deletion-impact</code>.
          Delete sends{" "}
          <code className="font-mono text-xs">{`{confirm:true}`}</code>. Active
          executions block delete. Secret values are never shown.
        </>
      }
      impact={
        impact
          ? credentialDeleteImpactItems({
              credentialId: impact.credentialId,
              displayName: impact.displayName,
              canDelete: impact.canDelete,
              blockReason: impact.blockReason,
              drafts: impact.drafts.map(formatRef),
              versions: impact.versions.map(formatRef),
              activeExecutions: impact.activeExecutions.map(formatRef),
            })
          : [
              {
                id: "unloaded",
                label: "Deletion impact",
                detail: "Not loaded yet. Load it before deleting.",
              },
            ]
      }
    >
      {!impact ? (
        <button
          type="button"
          onClick={onLoadImpact}
          disabled={pending}
          className={`mt-4 ${FF_VAULT_GHOST_CLASS}`}
        >
          {pending ? "Loading impact…" : "Load deletion impact"}
        </button>
      ) : (
        <Field
          id="credential-delete-confirm"
          label={`Type ${impact.displayName} to confirm`}
          error={confirmation.blockingReason || undefined}
          errorClassName={FF_VAULT_DANGER_CLASS}
          className="mt-4 block"
        >
          <input
            value={typedName}
            onChange={(event) => onTypedName(event.target.value)}
            autoComplete="off"
            className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
          />
        </Field>
      )}
    </ConfirmDestructive>
  );
}
