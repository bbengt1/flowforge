import { ExecutionDetail } from "@/components/executions/ExecutionDetail";
import { EXECUTION_DETAIL_PAGE_HELP } from "@/lib/execution-contract";
import { FF_INBOX_HELP_CLASS } from "@/lib/vault-executions-visual";

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
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Execution
        </h1>
        <p className={FF_INBOX_HELP_CLASS}>{EXECUTION_DETAIL_PAGE_HELP}</p>
      </header>
      <ExecutionDetail executionId={id} workflowId={query.workflowId} />
    </main>
  );
}
