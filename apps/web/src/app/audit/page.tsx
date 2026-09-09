import { AuditBrowser } from "@/components/audit/AuditBrowser";

export const dynamic = "force-dynamic";

export default function AuditPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E5.4 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Workspace audit
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Append-only browse of{" "}
          <code className="font-mono text-sm">GET /audit-events</code>. This is
          not the E2.2 isolation stub{" "}
          <code className="font-mono text-sm">GET /workspace/audit-events</code>
          . Normal roles are read-only — there is no edit or delete control.
          Mutation attempts fail closed at the API. Relates to #49 / Part of
          #45.
        </p>
      </header>
      <AuditBrowser />
    </main>
  );
}
