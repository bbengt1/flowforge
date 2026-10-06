import { WorkspaceGroupDetail } from "@/components/groups/WorkspaceGroupDetail";

export const dynamic = "force-dynamic";

type WorkspaceGroupPageProps = {
  params: Promise<{ id: string }>;
};

export default async function WorkspaceGroupPage({ params }: WorkspaceGroupPageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <WorkspaceGroupDetail groupId={id} />
    </main>
  );
}
