import { cookies } from "next/headers";
import { ApiDocsLinks } from "@/components/ApiDocsLinks";
import { ApiHealthCard } from "@/components/ApiHealthCard";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { MfaAccountPanel } from "@/components/session/MfaAccountPanel";
import { BootstrapSettings } from "@/components/settings/BootstrapSettings";
import { DeveloperSettings } from "@/components/settings/DeveloperSettings";
import { FoundationAdminLinks } from "@/components/settings/FoundationAdminLinks";
import { ThemePreferenceControl } from "@/components/theme/ThemePreference";
import {
  getPublicHealthUrl,
  getPublicOpenApiJsonUrl,
  getPublicOpenApiYamlUrl,
  getPublicReadinessUrl,
  getPublicSwaggerUrl,
} from "@/lib/config";
import { checkApiHealth, checkApiReadiness } from "@/lib/health";
import { THEME_COOKIE, colorTheme } from "@/lib/theme-preference";
import {
  FF_SETTINGS_EYEBROW_CLASS,
  FF_SETTINGS_HELP_CLASS,
  FF_SETTINGS_ROOT_CLASS,
  FF_SETTINGS_TITLE_CLASS,
  FF_SETTINGS_VALUE,
} from "@/lib/settings-wizard-visual";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const [health, readiness] = await Promise.all([
    checkApiHealth(),
    checkApiReadiness(),
  ]);

  return (
    <main
      data-ff-settings={FF_SETTINGS_VALUE}
      className={`${FF_SETTINGS_ROOT_CLASS} mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12`}
    >
      <header className="space-y-3">
        <p className={FF_SETTINGS_EYEBROW_CLASS}>E6.1 · Settings</p>
        <h1 className={`text-3xl tracking-tight ${FF_SETTINGS_TITLE_CLASS}`}>
          Settings
        </h1>
        <p className={FF_SETTINGS_HELP_CLASS}>
          Session, workspace context, instance setup (URL / TLS / users /
          persistence), control-plane health, and OpenAPI. Cookie
          session + CSRF are unchanged. Members and isolation stay
          ADV-024 grant-gated — Settings may link carefully; they are
          not product destinations. The first-run wizard does not remount
          here.
        </p>
      </header>
      <ThemePreferenceControl
        variant="settings"
        theme={colorTheme(cookieStore.get(THEME_COOKIE)?.value)}
      />
      <BootstrapSettings />
      <MfaAccountPanel />
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
