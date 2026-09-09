import { ApprovalDetail } from "@/components/approvals/ApprovalDetail";

export const dynamic = "force-dynamic";

type ApprovalPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ApprovalPage({ params }: ApprovalPageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.3 · E10.3 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Approval request
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Binding snapshot is read-only. Decide is POST …/decide with CSRF.
          Self-approval is forbidden. Expired or invalidated bindings fail
          closed. Wait state is durable across worker or pod loss. The UI
          never stores an approval token in localStorage.
        </p>
      </header>
      <ApprovalDetail approvalId={id} />
    </main>
  );
}
