import {
  ENGINE_CATALOG_UNAVAILABLE_HELP,
  isInventedCatalogSource,
} from "@/lib/catalog-fail-closed";
import {
  runtimeProfileIsolationNotes,
  type ScriptRuntimeProfileMap,
} from "@/lib/script-runtime-contract";

type ScriptIsolationNotesProps = {
  extraNotes?: readonly string[];
  map?: ScriptRuntimeProfileMap | null;
};

export function ScriptIsolationNotes({
  extraNotes,
  map,
}: ScriptIsolationNotesProps) {
  const notes = [
    ...runtimeProfileIsolationNotes(map),
    ...(extraNotes ?? []).filter((note) => note.trim()),
  ];
  const fallback = !map || isInventedCatalogSource(map.source);
  return (
    <aside
      aria-label="Script runtime isolation notes"
      className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-sm text-teal-950"
    >
      <p className="font-medium">Isolated script runner rules</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      {fallback ? (
        <p className="mt-3 text-xs text-teal-900/80">
          {ENGINE_CATALOG_UNAVAILABLE_HELP}
        </p>
      ) : null}
    </aside>
  );
}
