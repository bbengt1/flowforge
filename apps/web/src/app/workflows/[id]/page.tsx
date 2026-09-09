import { WorkflowOperator } from "@/components/workflows/WorkflowOperator";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function WorkflowEditorPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E3.3 · YAML editor
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workflow editor
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Existing E3 draft / publish / compare operator for this workflow.
          This is not the E6 canvas. Cookie session + CSRF and
          tenant/workbench identity are unchanged.
        </p>
      </header>
      <WorkflowOperator workflowId={id} />
    </main>
  );
}
