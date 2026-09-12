import { ApiDocsLinks } from "@/components/ApiDocsLinks";
import { ApiHealthCard } from "@/components/ApiHealthCard";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { DeveloperSettings } from "@/components/settings/DeveloperSettings";
import { FoundationAdminLinks } from "@/components/settings/FoundationAdminLinks";
import {
  getPublicHealthUrl,
  getPublicOpenApiJsonUrl,
  getPublicOpenApiYamlUrl,
  getPublicReadinessUrl,
  getPublicSwaggerUrl,
} from "@/lib/config";
import { checkApiHealth, checkApiReadiness } from "@/lib/health";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [health, readiness] = await Promise.all([
    checkApiHealth(),
    checkApiReadiness(),
  ]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          E6.1 · Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          Session, workspace context, control-plane health, and OpenAPI.
          Cookie session + CSRF are unchanged. Members and isolation
          stay ADV-024 grant-gated — Settings may link carefully; they
          are not product destinations.
        </p>
      </header>
      <IsolationIdentityPanel />
      <div id="health">
        <ApiHealthCard
          initialHealth={health}
          initialReadiness={readiness}
          publicHealthUrl={getPublicHealthUrl()}
          publicReadinessUrl={getPublicReadinessUrl()}
        />
      </div>
      <div id="api-docs">
        <ApiDocsLinks
          swaggerUrl={getPublicSwaggerUrl()}
          openApiJsonUrl={getPublicOpenApiJsonUrl()}
          openApiYamlUrl={getPublicOpenApiYamlUrl()}
        />
      </div>
      <DeveloperSettings />
      <FoundationAdminLinks />
    </main>
  );
}
