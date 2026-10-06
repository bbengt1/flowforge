import { WorkspaceGroupsList } from "@/components/groups/WorkspaceGroupsList";

export const dynamic = "force-dynamic";

export default function WorkspaceGroupsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <WorkspaceGroupsList />
    </main>
  );
}
