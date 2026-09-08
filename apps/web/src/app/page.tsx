import { ApiHealthCard } from "@/components/ApiHealthCard";
import {
  getPublicHealthUrl,
  getPublicReadinessUrl,
} from "@/lib/config";
import { checkApiHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function Home() {
  const health = await checkApiHealth();

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E1.1 skeleton
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">FlowForge</h1>
        <p className="max-w-xl text-base leading-7 text-zinc-600">
          Workflow control plane UI. This page is the deployable shell — no
          canvas or authoring yet. Product contracts live in{" "}
          <code className="font-mono text-sm">docs/</code>.
        </p>
      </header>

      <ApiHealthCard
        initial={health}
        publicHealthUrl={getPublicHealthUrl()}
        publicReadinessUrl={getPublicReadinessUrl()}
      />
    </main>
  );
}
