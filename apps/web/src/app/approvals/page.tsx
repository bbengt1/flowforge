import { ApprovalList } from "@/components/approvals/ApprovalList";

export const dynamic = "force-dynamic";

export default function ApprovalsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E4.3 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Approvals</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace approvals bound to workflow version, target, policy
          revision, operation, and expiry. List is RBAC-aware (
          <code className="font-mono text-xs">approval.view</code>). Decide is
          <code className="font-mono text-xs">POST …/decide</code> with CSRF;
          the requester cannot approve their own request. A later target or
          policy publish invalidates a prior approval; the server recheck is
          authoritative.
        </p>
      </header>
      <ApprovalList />
    </main>
  );
}
