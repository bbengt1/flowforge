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
          E5.1 · Execution detail
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Execution
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Header, steps/jobs summary, and redacted audit events. Unexpected
          secret fields are stripped. Duplicate idempotency keys reuse the
          existing run when the API returns that behavior.
        </p>
      </header>
      <ExecutionDetail executionId={id} workflowId={query.workflowId} />
    </main>
  );
}
