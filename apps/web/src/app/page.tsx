import { ApiDocsLinks } from "@/components/ApiDocsLinks";
import { ApiHealthCard } from "@/components/ApiHealthCard";
import {
  getPublicHealthUrl,
  getPublicOpenApiJsonUrl,
  getPublicOpenApiYamlUrl,
  getPublicReadinessUrl,
  getPublicSwaggerUrl,
} from "@/lib/config";
import { checkApiHealth, checkApiReadiness } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [health, readiness] = await Promise.all([
    checkApiHealth(),
    checkApiReadiness(),
  ]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E1 foundation
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">FlowForge</h1>
        <p className="max-w-xl text-base leading-7 text-zinc-600">
          Workflow control plane UI. This page is the deployable shell — no
          canvas or authoring yet. Product contracts live in{" "}
          <code className="font-mono text-sm">docs/</code>.
        </p>
      </header>

      <ApiHealthCard
        initialHealth={health}
        initialReadiness={readiness}
        publicHealthUrl={getPublicHealthUrl()}
        publicReadinessUrl={getPublicReadinessUrl()}
      />

      <ApiDocsLinks
        swaggerUrl={getPublicSwaggerUrl()}
        openApiJsonUrl={getPublicOpenApiJsonUrl()}
        openApiYamlUrl={getPublicOpenApiYamlUrl()}
      />
    </main>
  );
}
