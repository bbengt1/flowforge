import { WorkflowOperator } from "@/components/workflows/WorkflowOperator";

export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E3.2 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workflow drafts
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Operator for jonny&apos;s draft/publish/version APIs, keeping the
          E3.1 catalog / validate / normalize editor. Create or import a
          workflow, save with revision / If-Match, reload on 409, publish an
          immutable version, compare, restore-as-new-draft, and run only a
          published <code className="font-mono text-sm">workflowVersionId</code>.
          This is not the E6 canvas. Cookie session + CSRF and tenant/workbench
          identity are the same as E2.3 / E2.1.
        </p>
      </header>
      <WorkflowOperator />
    </main>
  );
}
