import { leastPrivilegeNotes } from "@/lib/kubernetes";

export function KubernetesLeastPrivilegeNotes() {
  return (
    <aside
      aria-label="Kubernetes least-privilege notes"
      className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-sm text-teal-950"
    >
      <p className="font-medium">Least-privilege notes</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {leastPrivilegeNotes().map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </aside>
  );
}
