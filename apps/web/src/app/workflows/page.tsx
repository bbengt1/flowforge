import { WorkflowOperator } from "@/components/workflows/WorkflowOperator";

export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E3.1 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workflow YAML
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Minimal operator for jonny&apos;s canonical YAML validate/normalize
          API. Debounced validation shows{" "}
          <code className="font-mono text-sm">errors[]</code> on invalid
          documents and never guesses a graph. Normalize replaces the buffer
          with the API&apos;s <code className="font-mono text-sm">definitionYaml</code>{" "}
          and digest. This is not the E6 canvas, and it does not save drafts
          (E3.2). Cookie session + CSRF and tenant/workbench identity are the
          same as E2.3 / E2.1.
        </p>
      </header>
      <WorkflowOperator />
    </main>
  );
}
