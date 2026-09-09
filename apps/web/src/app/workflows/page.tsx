import { Suspense } from "react";
import { WorkflowHome } from "@/components/home/WorkflowHome";

export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.1 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Workflows</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace home for drafts and published versions. List and card
          views show status, version, validation health, and required
          approvals without opening the editor. Create and import use{" "}
          <code className="font-mono text-sm">POST /workflows</code>. The
          YAML editor is at{" "}
          <code className="font-mono text-sm">/workflows/{"{id}"}</code>.
        </p>
      </header>
      <Suspense
        fallback={<p className="text-sm text-zinc-600">Loading workflow home…</p>}
      >
        <WorkflowHome />
      </Suspense>
    </main>
  );
}
