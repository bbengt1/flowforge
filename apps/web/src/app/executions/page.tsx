import { ExecutionHistory } from "@/components/executions/ExecutionHistory";

export const dynamic = "force-dynamic";

export default function ExecutionsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E5.1 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Execution history
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace-scoped list against jonny&apos;s persistence query APIs
          (routes still in flight). Filter by workflow, status, and time.
          Cards show safe metadata only.{" "}
          <code className="font-mono text-sm">indeterminate</code> is called
          out distinctly. Graph replay, artifacts, and cancel/retry are later
          slices. Relates to #46 / Part of #45.
        </p>
      </header>
      <ExecutionHistory />
    </main>
  );
}
