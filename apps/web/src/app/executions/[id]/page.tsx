import { ExecutionDetail } from "@/components/executions/ExecutionDetail";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workflowId?: string }>;
};

export default async function ExecutionDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E5.1 / E5.2 · Execution detail
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Execution
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Header, steps, jobs, pins, and redacted audit events. Status
          polls{" "}
          <code className="font-mono text-sm">GET /executions/{"{id}"}</code>{" "}
          (#53) — never <code className="font-mono text-sm">/jobs/*</code>.
          Cancel is{" "}
          <code className="font-mono text-sm">POST /executions/{"{id}"}/cancel</code>{" "}
          with CSRF and <code className="font-mono text-sm">execution.cancel</code>.
          Retry is{" "}
          <code className="font-mono text-sm">POST …/retry</code> for failed
          or canceled core <code className="font-mono text-sm">data.*</code>{" "}
          / <code className="font-mono text-sm">flow.*</code> steps only —
          never <code className="font-mono text-sm">indeterminate</code>.
          HTTP 403 is fail-closed. Secrets appear as{" "}
          <code className="font-mono text-sm">[redacted]</code>.
        </p>
      </header>
      <ExecutionDetail executionId={id} workflowId={query.workflowId} />
    </main>
  );
}
