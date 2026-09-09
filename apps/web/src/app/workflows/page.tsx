import { WorkflowOperator } from "@/components/workflows/WorkflowOperator";

export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E3.3 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workflow drafts
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Place and configure core neutral nodes (
          <code className="font-mono text-sm">flow.condition</code>,{" "}
          <code className="font-mono text-sm">flow.delay</code>,{" "}
          <code className="font-mono text-sm">data.set</code>,{" "}
          <code className="font-mono text-sm">data.map</code>,{" "}
          <code className="font-mono text-sm">data.validate</code>,{" "}
          <code className="font-mono text-sm">flow.stop</code>,{" "}
          <code className="font-mono text-sm">flow.fail</code>) in the E3.1
          YAML editor. Triggers stay on{" "}
          <code className="font-mono text-sm">spec.triggers</code>. Draft /
          publish / compare from E3.2 stay on this page. This is not the E6
          canvas. Cookie session + CSRF and tenant/workbench identity are the
          same as E2.3 / E2.1. Authorized E4.2 config pins (display name +
          version only) are available below the editor.
        </p>
      </header>
      <WorkflowOperator />
    </main>
  );
}
