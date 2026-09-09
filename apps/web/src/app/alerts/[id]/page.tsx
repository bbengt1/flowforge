import { AlertDetail } from "@/components/alerts/AlertDetail";

export const dynamic = "force-dynamic";

type AlertPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AlertPage({ params }: AlertPageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E5.4 · Chloe UI
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Alert detail</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Identifiers only — no details payload. Secret fields are stripped.
          Acknowledge posts empty JSON with CSRF (
          <code className="font-mono text-xs">alert.ack</code>). A second ack
          is idempotent 200. Viewer ack is HTTP 403 fail-closed. There is no
          resolve route.
        </p>
      </header>
      <AlertDetail alertId={id} />
    </main>
  );
}
