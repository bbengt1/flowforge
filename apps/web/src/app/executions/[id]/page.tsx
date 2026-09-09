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
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.4 · Graph replay
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Execution
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Graph replay overlays step status on the E6.2 canvas from the
          pinned published version YAML. Cancel stays idempotent. Emergency
          stop of a script is separately authorized (
          <code className="font-mono text-sm">script.emergencyStop</code>)
          and is not Cancel — queued stays canceled, running/uncertain stays
          loud{" "}
          <code className="font-mono text-sm">indeterminate</code> until
          verified, with no blind retry. Script and SSH retry appear only
          when{" "}
          <code className="font-mono text-sm">result.retry.allowed</code> is
          true. Durable approval wait is enabled; resume is decide (SoD
          fail-closed). Error links
          jump to the failed or indeterminate node. Secrets appear as{" "}
          <code className="font-mono text-sm">[redacted]</code>.
        </p>
      </header>
      <ExecutionDetail executionId={id} workflowId={query.workflowId} />
    </main>
  );
}
