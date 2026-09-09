import Link from "next/link";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ApiDocsLinks } from "@/components/ApiDocsLinks";
import {
  getPublicOpenApiJsonUrl,
  getPublicOpenApiYamlUrl,
  getPublicSwaggerUrl,
} from "@/lib/config";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.1 · Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Session, workspace context, and foundation operator links. Cookie
          session + CSRF are unchanged. Membership and isolation remain the
          E2 surfaces.
        </p>
      </header>
      <IsolationIdentityPanel />
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Foundation operators</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <Link href="/membership" className="text-teal-800 underline">
              Membership and roles
            </Link>
          </li>
          <li>
            <Link href="/isolation" className="text-teal-800 underline">
              Isolation exercise
            </Link>
          </li>
          <li>
            <Link href="/audit" className="text-teal-800 underline">
              Workspace audit
            </Link>
          </li>
        </ul>
      </section>
      <ApiDocsLinks
        swaggerUrl={getPublicSwaggerUrl()}
        openApiJsonUrl={getPublicOpenApiJsonUrl()}
        openApiYamlUrl={getPublicOpenApiYamlUrl()}
      />
    </main>
  );
}
