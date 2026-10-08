import { ApprovalDetail } from "@/components/approvals/ApprovalDetail";
import { APPROVAL_DETAIL_PAGE_HELP } from "@/lib/approval-contract";

export const dynamic = "force-dynamic";

type ApprovalPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ApprovalPage({ params }: ApprovalPageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Approval request
        </h1>
        <p className="max-w-3xl text-base leading-7 text-fg">
          {APPROVAL_DETAIL_PAGE_HELP}
        </p>
      </header>
      <ApprovalDetail approvalId={id} />
    </main>
  );
}
