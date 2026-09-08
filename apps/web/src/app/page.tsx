import Link from "next/link";
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
          E1 foundation · E2 identity · E3 YAML
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">FlowForge</h1>
        <p className="max-w-xl text-base leading-7 text-zinc-600">
          Workflow control plane UI. This page is the deployable shell — no
          canvas or authoring yet. Product contracts live in{" "}
          <code className="font-mono text-sm">docs/</code>. Exercise workspace
          membership and roles from the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/membership"
          >
            membership operator
          </Link>
          , prove isolation fails closed on the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/isolation"
          >
            isolation exercise
          </Link>
          , or exercise YAML validate/normalize plus draft/publish/history on
          the{" "}
          <Link
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href="/workflows"
          >
            workflow operator
          </Link>
          .
        </p>
      </header>

      <ApiHealthCard
        initialHealth={health}
        initialReadiness={readiness}
        publicHealthUrl={getPublicHealthUrl()}
        publicReadinessUrl={getPublicReadinessUrl()}
      />

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Membership operator</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E2.1 / E2.3 UI for jonny&apos;s workspace identity
          contract: establish a cookie session, bootstrap a tenant/workspace,
          inspect roles and permissions, and manage members. CSRF-protected
          mutations and problem responses stay visible (title, detail, code,
          request_id).
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/membership"
          >
            Open membership and roles
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Isolation exercise</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E2.2 UI for jonny&apos;s isolation hooks: attempt
          cross-workspace credential, artifact, cache, realtime, and record
          access and show the problem+json failure. Workspace UUID is never
          the lookup key.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/isolation"
          >
            Open isolation exercise
          </Link>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Workflow operator</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Chloe&apos;s E3.1 / E3.2 UI for jonny&apos;s YAML and version
          contract. Validate and normalize stay on the editor. Drafts save
          with revision / If-Match, 409 offers reload, publish is immutable,
          and run accepts only a published version id.
        </p>
        <p className="mt-4">
          <Link
            className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            href="/workflows"
          >
            Open draft / publish operator
          </Link>
        </p>
      </section>

      <ApiDocsLinks
        swaggerUrl={getPublicSwaggerUrl()}
        openApiJsonUrl={getPublicOpenApiJsonUrl()}
        openApiYamlUrl={getPublicOpenApiYamlUrl()}
      />
    </main>
  );
}
