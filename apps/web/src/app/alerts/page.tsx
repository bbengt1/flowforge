import { AlertList } from "@/components/alerts/AlertList";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E5.4 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Operational alerts
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Workspace signals for authorization, replay, policy, and redaction
          failures. Cards show kind, severity, timestamps, correlation id,
          resource ids, and a safe message — never secrets. Unexpected secret
          fields are stripped. Ack/resolve use CSRF when the API publishes
          those mutations; otherwise the list is read-only. Relates to #49 /
          Part of #45.
        </p>
      </header>
      <AlertList />
    </main>
  );
}
