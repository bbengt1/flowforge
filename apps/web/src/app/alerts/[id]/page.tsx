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
          Correlation and resource ids only. Secret fields are stripped.
          Acknowledge and resolve post empty JSON with CSRF when the API
          provides those mutations. HTTP 403 is fail-closed.
        </p>
      </header>
      <AlertDetail alertId={id} />
    </main>
  );
}
