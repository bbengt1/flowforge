import { Suspense } from "react";
import { ExecutionHistory } from "@/components/executions/ExecutionHistory";

export const dynamic = "force-dynamic";

export default function ExecutionsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          R4.1 · Workspace inbox
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Executions</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Operate workspace runs. Filter by status or workflow, then open a
          row into existing{" "}
          <code className="font-mono text-sm">/executions/{"{id}"}</code>{" "}
          detail — no hunting and no second graph on this inbox. Uses
          existing <code className="font-mono text-sm">GET /executions</code>{" "}
          <code className="font-mono text-sm">status</code>,{" "}
          <code className="font-mono text-sm">workflowId</code>, and{" "}
          <code className="font-mono text-sm">limit</code> only. Drafts never
          run (published <code className="font-mono text-sm">workflowVersionId</code>{" "}
          only). Secrets stay{" "}
          <code className="font-mono text-sm">[redacted]</code>.{" "}
          <code className="font-mono text-sm">indeterminate</code> stays loud
          (icon + text + explanation — never silent success). Cancel, retry,
          and emergency stop sit on the inbox row using the existing E5/E8/E9
          routes. Retry is shown only when{" "}
          <code className="font-mono text-sm">result.retry.allowed</code> is
          true. Artifacts stay on the detail page.
        </p>
      </header>
      <Suspense
        fallback={<p className="text-sm text-zinc-600">Loading executions inbox…</p>}
      >
        <ExecutionHistory />
      </Suspense>
    </main>
  );
}
