import { ExecutionHistory } from "@/components/executions/ExecutionHistory";

export const dynamic = "force-dynamic";

export default function ExecutionsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E5.1 / E5.2 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Execution history
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace history via{" "}
          <code className="font-mono text-sm">GET /executions</code> and
          per-workflow{" "}
          <code className="font-mono text-sm">GET /workflows/{"{id}"}/executions</code>{" "}
          from #51. Filter by workflow, status, and limit. Secrets appear as{" "}
          <code className="font-mono text-sm">[redacted]</code>. Running,
          canceled, failed, and{" "}
          <code className="font-mono text-sm">indeterminate</code> use icon +
          text — color is never the only signal. Cancel and retry live on
          the detail page (#53). Relates to #47 / Part of #45.
        </p>
      </header>
      <ExecutionHistory />
    </main>
  );
}
