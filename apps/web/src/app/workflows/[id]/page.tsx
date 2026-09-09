import { WorkflowOperator } from "@/components/workflows/WorkflowOperator";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function WorkflowEditorPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-[96rem] flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.3 · E10.2 · Guided authoring
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workflow editor
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Add action is the guided wizard: type, authorized target and
          credential, configure, connect data, then policy and redacted YAML
          review. Insert writes a canonical canvas node. Invalid YAML never
          draws a guessed graph. Cookie session + CSRF and tenant/workbench
          identity are unchanged. Webhook triggers stay workflow-level:
          opaque id, rotate-only secret, signature-before-parse, and
          replay limits.
        </p>
      </header>
      <WorkflowOperator workflowId={id} />
    </main>
  );
}
