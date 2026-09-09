"use client";

import { deletionConfirmationState, formatRef } from "@/lib/credential";
import type { CredentialDeletionImpact } from "@/lib/credential-types";

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
      className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-900/40 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg">
        <h2 id="credential-delete-heading" className="text-lg font-semibold">
          Confirm deletion
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Load{" "}
          <code className="font-mono text-xs">GET .../deletion-impact</code>{" "}
          first. Delete sends{" "}
          <code className="font-mono text-xs">{`{confirm:true}`}</code>. Active
          executions block delete. Secret values are never shown.
        </p>

        {!impact ? (
          <button
            type="button"
            onClick={onLoadImpact}
            disabled={pending}
            className="mt-4 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
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
              <p role="status" className="text-amber-900">
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
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
              />
            </label>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || !confirmation.canProceed}
            className="rounded-lg border border-red-800 bg-red-800 px-3 py-2 text-sm font-medium text-white hover:bg-red-900 disabled:opacity-60"
          >
            {pending ? "Deleting…" : "Delete credential"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
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
        <p className="mt-1 text-zinc-600">{empty}</p>
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
