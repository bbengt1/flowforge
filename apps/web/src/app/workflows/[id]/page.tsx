import { WorkflowOperator } from "@/components/workflows/WorkflowOperator";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function WorkflowEditorPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col">
      <WorkflowOperator workflowId={id} />
    </main>
  );
}
