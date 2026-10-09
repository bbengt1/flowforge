import { AlertDetail } from "@/components/alerts/AlertDetail";
import { ALERT_DETAIL_PAGE_HELP } from "@/lib/alert-contract";

export const dynamic = "force-dynamic";

type AlertPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AlertPage({ params }: AlertPageProps) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Alert detail</h1>
        <p className="max-w-3xl text-base leading-7 text-fg">{ALERT_DETAIL_PAGE_HELP}</p>
      </header>
      <AlertDetail alertId={id} />
    </main>
  );
}
