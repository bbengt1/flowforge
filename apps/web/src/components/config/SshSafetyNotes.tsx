import { isInventedCatalogSource } from "@/lib/catalog-fail-closed";
import { SSH_CONTRACT_FALLBACK_HELP } from "@/lib/ssh-contract";
import { sshSafetyNotes } from "@/lib/ssh";
import type { SshEngineCatalog } from "@/lib/ssh-types";

type SshSafetyNotesProps = {
  extraNotes?: readonly string[];
  catalog?: SshEngineCatalog | null;
};

export function SshSafetyNotes({ extraNotes, catalog }: SshSafetyNotesProps) {
  const notes = [
    ...sshSafetyNotes(),
    ...(extraNotes ?? []).filter((note) => note.trim()),
    ...(catalog?.notes ? [catalog.notes] : []),
  ];
  const fallback = !catalog || isInventedCatalogSource(catalog.source);
  return (
    <aside
      aria-label="SSH safety notes"
      className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-sm text-teal-950"
    >
      <p className="font-medium">SSH target and profile rules</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      {fallback ? (
        <p className="mt-3 text-xs text-teal-900/80">{SSH_CONTRACT_FALLBACK_HELP}</p>
      ) : null}
    </aside>
  );
}
