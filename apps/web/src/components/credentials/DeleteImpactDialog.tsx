"use client";

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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-delete-heading"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
    >
      <div className={`max-h-[90vh] w-full max-w-xl overflow-auto ${FF_VAULT_PANEL_CLASS}`}>
        <h2 id="credential-delete-heading" className={`text-lg ${FF_VAULT_TITLE_CLASS}`}>
          Confirm deletion
        </h2>
        <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>
          Deletion-impact is already on the detail page from{" "}
          <code className="font-mono text-xs">GET .../deletion-impact</code>.
          Delete sends{" "}
          <code className="font-mono text-xs">{`{confirm:true}`}</code>. Active
          executions block delete. Secret values are never shown.
        </p>

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
          <div className="mt-4 space-y-4 text-sm">
            <ImpactList
              title="Affected drafts"
              empty="No drafts reference this credential."
              items={impact.drafts.map(formatRef)}
            />
            <ImpactList
              title="Affected published versions"
              empty="No published versions reference this credential."
              items={impact.versions.map(formatRef)}
            />
            <ImpactList
              title="Active executions"
              empty="No active executions."
              items={impact.activeExecutions.map(formatRef)}
            />

            {confirmation.blockingReason ? (
              <p role="status" className={FF_VAULT_DANGER_CLASS}>
                {confirmation.blockingReason}
              </p>
            ) : null}

            <label className="block">
              <span className="font-medium">
                Type {impact.displayName} to confirm
              </span>
              <input
                value={typedName}
                onChange={(event) => onTypedName(event.target.value)}
                autoComplete="off"
                className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
              />
            </label>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || !confirmation.canProceed}
            className={`${FF_VAULT_DANGER_CLASS} rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-60`}
          >
            {pending ? "Deleting…" : "Delete credential"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={FF_VAULT_GHOST_CLASS}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ImpactList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: string[];
}) {
  return (
    <section>
      <h3 className="font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className={`mt-1 ${FF_VAULT_MUTED_CLASS}`}>{empty}</p>
      ) : (
        <ul className="mt-1 list-disc pl-5">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
