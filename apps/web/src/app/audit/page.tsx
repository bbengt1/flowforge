import { AuditBrowser } from "@/components/audit/AuditBrowser";
import { AUDIT_PAGE_HELP } from "@/lib/alert-contract";

export const dynamic = "force-dynamic";

export default function AuditPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Workspace audit</h1>
        <p className="max-w-3xl text-base leading-7 text-fg">{AUDIT_PAGE_HELP}</p>
      </header>
      <AuditBrowser />
    </main>
  );
}
