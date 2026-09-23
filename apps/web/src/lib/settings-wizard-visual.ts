/**
 * V.6: Settings + first-run wizard.
 *
 * Relates to #362 / Part of #353. Keep #362 open.
 *
 * Chloe UI only. Visual restyle of Settings and the standalone
 * first-run wizard onto the V.1 token tree and V.2 shell
 * (docs/internal/flowforge-visual-ia-north-star.md § settings /
 * wizard / V.6). B.6 / B.7 chrome already exists — this slice does
 * not change B.2–B.5 order, Skip semantics, or gate rules.
 *
 * Surfaces: `/settings` (`#bootstrap` / `#tls` / handoff) and the
 * standalone wizard. Wizard never on `/embed/v1`. After complete,
 * Settings only — no remount. Skip stays loud HTTP-until-Settings.
 * No PEM / KEK / password in chrome or localStorage.
 *
 * Hard lines: Wizard never on embed · no secrets in chrome ·
 * B.* order held · ADV-021/024 · drafts never run · not an n8n clone.
 */

import {
  B6_KEEP_STORY_OPEN,
  B7_KEEP_STORY_OPEN,
  BOOTSTRAP_STEPS,
  BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER,
  BOOTSTRAP_TLS_SKIP_LABEL,
  BOOTSTRAP_TLS_SKIP_SETTINGS_COPY,
  BOOTSTRAP_TLS_SKIP_WARNING,
  DEFAULT_BOOTSTRAP_TLS_ACTION,
  FIRST_RUN_BOOTSTRAP,
  SETTINGS_BOOTSTRAP_HREF,
  SETTINGS_TLS_HREF,
  SETTINGS_USERS_HANDOFF_HREF,
  bootstrapTlsSkipBody,
  firstRunBootstrapHoldsHardLines,
  settingsHandoffAfterComplete,
  settingsSourceRemountsWizard,
  shouldFetchBootstrapGate,
  shouldRemountWizard,
  tlsSkipBodyIsActionOnly,
  tlsStepIsSkipped,
  wizardSourceHasPasswordField,
  wizardSourceRetainsSecrets,
  type BootstrapStatus,
} from "./first-run-bootstrap.ts";
import type { DohertyPhase } from "./doherty-pending-chrome.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  FF_ACCENT,
  FF_CANVAS,
  FF_DANGER,
  FF_SURFACE,
  FORBIDDEN_THEME_TREES,
  N8N_ORANGE_TOKENS,
  VISUAL_TOKENS,
  n8nOrangePresent,
  secondThemeTreePresent,
} from "./visual-tokens.ts";

export const V6_STORY = 362;
export const V6_EPIC = 353;
export const V6_KEEP_STORY_OPEN = true;
export const V6_ID = "V.6-settings-first-run-wizard" as const;
export const V6_BRIEF = "docs/internal/flowforge-visual-ia-north-star.md";
export const V6_TOKEN_FILE = "src/app/tokens.css";

export const V6_HELP =
  "Same tokens as the product (dark charcoal + one teal accent). Wizard never on /embed/v1. B.2–B.5 order unchanged. Skip stays loud HTTP-until-Settings. No remount after complete. No PEM / KEK / password in chrome or localStorage. Settings #bootstrap / #tls / handoff match shell tokens; skipped mode still clear.";

export const SETTINGS_WIZARD_VISUAL = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  inheritV2Shell: true,
  inheritB6WizardChrome: true,
  inheritB7SkipChrome: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  sameTokensAsProduct: true,
  darkCharcoalPlusOneTealAccent: true,
  wizardNeverOnEmbedV1: true,
  b2ToB5OrderUnchanged: true,
  failClosedStepOrder: true,
  skipStaysLoudHttpUntilSettings: true,
  skipNotSilentDefault: true,
  noRemountAfterComplete: true,
  settingsHandoffAfterComplete: true,
  settingsBootstrapTlsHandoffMatchShellTokens: true,
  skippedModeStillClear: true,
  noPemKekPasswordInChrome: true,
  noLocalStorageForSecrets: true,
  noPasswordFieldOnWizard: true,
  draftsNeverRun: true,
  yamlIsSourceOfTruth: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  oneAccent: true,
  accentIsTealFamily: true,
  noSecondThemeTree: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  noGreenfieldApis: true,
  keep362Open: true,
  keep339Open: true,
  keep347Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_SETTINGS_ATTR = "data-ff-settings";
export const FF_SETTINGS_VALUE = "v6";
export const FF_WIZARD_ATTR = "data-ff-wizard";
export const FF_WIZARD_VALUE = "v6";

export const FF_SETTINGS_ROOT_CLASS = "ff-settings";
export const FF_SETTINGS_PANEL_CLASS = "ff-settings-panel";
export const FF_SETTINGS_HEADER_CLASS = "ff-settings-header";
export const FF_SETTINGS_PRIMARY_CLASS = "ff-settings-primary";
export const FF_SETTINGS_GHOST_CLASS = "ff-settings-ghost";
export const FF_SETTINGS_CONTROL_CLASS = "ff-settings-control";
export const FF_SETTINGS_MUTED_CLASS = "ff-settings-muted";
export const FF_SETTINGS_TITLE_CLASS = "ff-settings-title";
export const FF_SETTINGS_LINK_CLASS = "ff-settings-link";
export const FF_SETTINGS_EYEBROW_CLASS = "ff-settings-eyebrow";
export const FF_SETTINGS_HELP_CLASS = "ff-settings-help";
export const FF_SETTINGS_DANGER_CLASS = "ff-settings-danger";
export const FF_SETTINGS_NESTED_CLASS = "ff-settings-nested";
export const FF_SETTINGS_SKIP_CLASS = "ff-settings-skip";

export const FF_WIZARD_ROOT_CLASS = "ff-wizard";
export const FF_WIZARD_PANEL_CLASS = "ff-wizard-panel";
export const FF_WIZARD_HEADER_CLASS = "ff-wizard-header";
export const FF_WIZARD_PRIMARY_CLASS = "ff-wizard-primary";
export const FF_WIZARD_GHOST_CLASS = "ff-wizard-ghost";
export const FF_WIZARD_CONTROL_CLASS = "ff-wizard-control";
export const FF_WIZARD_MUTED_CLASS = "ff-wizard-muted";
export const FF_WIZARD_TITLE_CLASS = "ff-wizard-title";
export const FF_WIZARD_LINK_CLASS = "ff-wizard-link";
export const FF_WIZARD_EYEBROW_CLASS = "ff-wizard-eyebrow";
export const FF_WIZARD_HELP_CLASS = "ff-wizard-help";
export const FF_WIZARD_DANGER_CLASS = "ff-wizard-danger";
export const FF_WIZARD_PROGRESS_CLASS = "ff-wizard-progress";
export const FF_WIZARD_PROGRESS_ITEM_CLASS = "ff-wizard-progress-item";
export const FF_WIZARD_SKIP_CLASS = "ff-wizard-skip";

export const V6_SOURCES = [
  "src/lib/settings-wizard-visual.ts",
  "src/lib/first-run-bootstrap.ts",
  "src/lib/first-run-bootstrap-client.ts",
  "src/components/bootstrap/BootstrapGate.tsx",
  "src/components/bootstrap/FirstRunWizard.tsx",
  "src/components/settings/BootstrapSettings.tsx",
  "src/app/settings/page.tsx",
  "src/app/globals.css",
] as const;

export const V6_CHROME_SOURCES = [
  "src/components/bootstrap/BootstrapGate.tsx",
  "src/components/bootstrap/FirstRunWizard.tsx",
  "src/components/settings/BootstrapSettings.tsx",
  "src/components/settings/DeveloperSettings.tsx",
  "src/components/settings/FoundationAdminLinks.tsx",
  "src/app/settings/page.tsx",
  "src/components/ApiHealthCard.tsx",
  "src/components/ApiDocsLinks.tsx",
  "src/components/session/SessionPanel.tsx",
  "src/components/session/SessionExpiryBanner.tsx",
  "src/components/membership/IdentityBootstrap.tsx",
  "src/components/ProblemBanner.tsx",
  "src/app/globals.css",
] as const;

export const V6_WIZARD_SOURCES = [
  "src/components/bootstrap/BootstrapGate.tsx",
  "src/components/bootstrap/FirstRunWizard.tsx",
] as const;

export const V6_SETTINGS_SOURCES = [
  "src/app/settings/page.tsx",
  "src/components/settings/BootstrapSettings.tsx",
  "src/components/settings/DeveloperSettings.tsx",
  "src/components/settings/FoundationAdminLinks.tsx",
] as const;

export const LIGHT_SETTINGS_WIZARD_TOKENS = [
  "bg-white",
  "bg-white/80",
  "bg-white/95",
  "bg-white/60",
  "border-zinc-200",
  "border-zinc-300",
  "border-zinc-100",
  "bg-zinc-50",
  "bg-zinc-100",
  "bg-teal-50",
  "text-zinc-900",
  "text-teal-950",
  "bg-amber-50",
  "#f6f5f1",
] as const;

export const SECRET_RETENTION_TOKENS = [
  "localStorage.setItem",
  "sessionStorage.setItem",
] as const;

export function settingsWizardUsesV1TokenClasses(globals: string): boolean {
  return (
    globals.includes(`.${FF_SETTINGS_PANEL_CLASS}`) &&
    globals.includes(`.${FF_WIZARD_PANEL_CLASS}`) &&
    globals.includes(`.${FF_WIZARD_PROGRESS_ITEM_CLASS}`) &&
    globals.includes(`.${FF_SETTINGS_SKIP_CLASS}`) &&
    globals.includes(`.${FF_WIZARD_SKIP_CLASS}`) &&
    globals.includes(`.${FF_SETTINGS_PRIMARY_CLASS}`) &&
    globals.includes(`.${FF_WIZARD_PRIMARY_CLASS}`) &&
    globals.includes("background: var(--ff-surface)") &&
    globals.includes("background: var(--ff-accent)") &&
    globals.includes("color: var(--ff-accent-foreground)") &&
    globals.includes("var(--ff-text)") &&
    globals.includes("var(--ff-muted)") &&
    globals.includes("var(--ff-border)") &&
    globals.includes("var(--ff-canvas)")
  );
}

export function settingsWizardChromeRejectsLightLook(source: string): boolean {
  return LIGHT_SETTINGS_WIZARD_TOKENS.every((token) => !source.includes(token));
}

export function wizardChromeNeverOnEmbed(input: {
  gate: string;
  wizard: string;
  embed: string;
  shell: string;
}): boolean {
  const embedBranchStart = input.shell.indexOf("const shell = embed ? (");
  const embedBranchEnd = input.shell.indexOf(") : (", embedBranchStart);
  const embedBranch =
    embedBranchStart >= 0 && embedBranchEnd > embedBranchStart
      ? input.shell.slice(embedBranchStart, embedBranchEnd)
      : input.shell;
  return (
    shouldFetchBootstrapGate(true) === false &&
    shouldFetchBootstrapGate(false) === true &&
    input.gate.includes("if (embed)") &&
    input.gate.includes("return children") &&
    !input.embed.includes("FirstRunWizard") &&
    !input.embed.includes("loadBootstrapGate") &&
    !embedBranch.includes("BootstrapGate") &&
    !embedBranch.includes("FirstRunWizard") &&
    FIRST_RUN_BOOTSTRAP.neverOnEmbedV1
  );
}

export function wizardSkipIsLoud(input: {
  wizard: string;
  settings: string;
}): boolean {
  return (
    input.wizard.includes("BOOTSTRAP_TLS_SKIP_WARNING") &&
    input.wizard.includes("data-bootstrap-tls-skip-warning") &&
    input.wizard.includes("FF_WIZARD_SKIP_CLASS") &&
    input.wizard.includes("BOOTSTRAP_TLS_SKIP_LABEL") &&
    input.wizard.includes('data-bootstrap-tls-action="skip"') &&
    DEFAULT_BOOTSTRAP_TLS_ACTION === "create-self-signed" &&
    input.settings.includes("BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER") &&
    input.settings.includes("FF_SETTINGS_SKIP_CLASS") &&
    input.settings.includes("data-bootstrap-tls-skipped") &&
    BOOTSTRAP_TLS_SKIP_WARNING.includes("HTTP until") &&
    BOOTSTRAP_TLS_SKIP_SETTINGS_COPY.includes("HTTP until") &&
    BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER.includes("HTTP until")
  );
}

export function wizardDoesNotRemountAfterComplete(input: {
  settingsPage: string;
  settings: string;
}): boolean {
  return (
    !input.settingsPage.includes("FirstRunWizard") &&
    !settingsSourceRemountsWizard(input.settings) &&
    input.settings.includes("settingsHandoffAfterComplete") &&
    shouldRemountWizard({
      embed: false,
      complete: true,
      settingsSurface: true,
    }) === false &&
    FIRST_RUN_BOOTSTRAP.wizardNeverReappearsAfterComplete
  );
}

export function wizardOmitsSecretRetention(input: {
  wizard: string;
  client: string;
  settings: string;
}): boolean {
  return (
    !wizardSourceRetainsSecrets(input.wizard) &&
    !wizardSourceHasPasswordField(input.wizard) &&
    !input.wizard.includes("localStorage") &&
    !input.wizard.includes("sessionStorage") &&
    !input.client.includes("localStorage") &&
    !input.settings.includes("localStorage.setItem") &&
    !SECRET_RETENTION_TOKENS.some((token) => input.wizard.includes(token)) &&
    FIRST_RUN_BOOTSTRAP.noBrowserHeldSecrets &&
    FIRST_RUN_BOOTSTRAP.noLocalStorageForPasswordsPemsKek
  );
}

export function settingsHandoffMatchesShellTokens(input: {
  page: string;
  settings: string;
}): boolean {
  return (
    input.page.includes("data-ff-settings") &&
    input.page.includes("FF_SETTINGS_VALUE") &&
    input.page.includes("FF_SETTINGS_ROOT_CLASS") &&
    input.page.includes("FF_SETTINGS_EYEBROW_CLASS") &&
    input.settings.includes("id=\"bootstrap\"") &&
    input.settings.includes("id=\"tls\"") &&
    input.settings.includes("FF_SETTINGS_PANEL_CLASS") &&
    input.settings.includes("FF_SETTINGS_SKIP_CLASS") &&
    input.settings.includes("SETTINGS_TLS_HREF") &&
    input.settings.includes("SETTINGS_USERS_HANDOFF_HREF") &&
    SETTINGS_BOOTSTRAP_HREF === "/settings#bootstrap" &&
    SETTINGS_TLS_HREF === "/settings#tls" &&
    SETTINGS_USERS_HANDOFF_HREF === "/membership"
  );
}

export function settingsWizardVisualHoldsAcceptance(input: {
  page: string;
  settings: string;
  wizard: string;
  gate: string;
}): boolean {
  return (
    input.page.includes("FF_SETTINGS_ROOT_CLASS") &&
    input.settings.includes("FF_SETTINGS_PANEL_CLASS") &&
    input.wizard.includes("data-ff-wizard") &&
    input.wizard.includes("FF_WIZARD_VALUE") &&
    input.wizard.includes("FF_WIZARD_ROOT_CLASS") &&
    input.wizard.includes("FF_WIZARD_PANEL_CLASS") &&
    input.wizard.includes("FF_WIZARD_PROGRESS_ITEM_CLASS") &&
    input.wizard.includes("FF_WIZARD_PRIMARY_CLASS") &&
    input.gate.includes("FF_WIZARD_ROOT_CLASS") &&
    settingsHandoffMatchesShellTokens({
      page: input.page,
      settings: input.settings,
    })
  );
}

export function bStepOrderHeld(): boolean {
  return (
    BOOTSTRAP_STEPS[0] === "persistence" &&
    BOOTSTRAP_STEPS[1] === "firstAdmin" &&
    BOOTSTRAP_STEPS[2] === "publicUrl" &&
    BOOTSTRAP_STEPS[3] === "tls" &&
    BOOTSTRAP_STEPS.length === 4 &&
    FIRST_RUN_BOOTSTRAP.failClosedStepOrder &&
    FIRST_RUN_BOOTSTRAP.doNotSkipAhead &&
    DEFAULT_BOOTSTRAP_TLS_ACTION === "create-self-signed" &&
    tlsSkipBodyIsActionOnly(bootstrapTlsSkipBody())
  );
}

export function skippedTlsStatusIsClear(status: BootstrapStatus): boolean {
  return (
    settingsHandoffAfterComplete(status) &&
    tlsStepIsSkipped(status.steps.tls) &&
    status.steps.tls.mode === "skipped"
  );
}

export function wizardStatusClassName(phase: DohertyPhase): string {
  switch (phase) {
    case "error":
      return `${FF_WIZARD_DANGER_CLASS} text-xs`;
    case "indeterminate":
      return `${FF_WIZARD_SKIP_CLASS} text-xs font-medium`;
    case "pending":
      return `${FF_WIZARD_MUTED_CLASS} text-xs`;
    case "success":
      return `${FF_WIZARD_TITLE_CLASS} text-xs`;
    default:
      return `${FF_WIZARD_MUTED_CLASS} text-xs`;
  }
}

export function settingsWizardVisualHoldsHardLines(): boolean {
  return (
    SETTINGS_WIZARD_VISUAL.yamlIsSourceOfTruth &&
    SETTINGS_WIZARD_VISUAL.draftsNeverRun &&
    SETTINGS_WIZARD_VISUAL.wizardNeverOnEmbedV1 &&
    SETTINGS_WIZARD_VISUAL.b2ToB5OrderUnchanged &&
    SETTINGS_WIZARD_VISUAL.skipStaysLoudHttpUntilSettings &&
    SETTINGS_WIZARD_VISUAL.noRemountAfterComplete &&
    SETTINGS_WIZARD_VISUAL.noPemKekPasswordInChrome &&
    SETTINGS_WIZARD_VISUAL.noLocalStorageForSecrets &&
    SETTINGS_WIZARD_VISUAL.adv021ChromeFromSessionEmbedOnly &&
    SETTINGS_WIZARD_VISUAL.adv024MembershipIsolationStayGrantGated &&
    SETTINGS_WIZARD_VISUAL.isolationSuccessIsDenial &&
    SETTINGS_WIZARD_VISUAL.notAnN8nClone &&
    SETTINGS_WIZARD_VISUAL.noN8nOrange &&
    SETTINGS_WIZARD_VISUAL.noSecondThemeTree &&
    SETTINGS_WIZARD_VISUAL.keep362Open &&
    SETTINGS_WIZARD_VISUAL.inheritV1Tokens &&
    SETTINGS_WIZARD_VISUAL.uiOnly &&
    SETTINGS_WIZARD_VISUAL.noGreenfieldApis &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_CANVAS.toLowerCase() === "#0f1218" &&
    FF_SURFACE.toLowerCase() === "#171b22" &&
    FF_DANGER.toLowerCase() === "#fb7185" &&
    firstRunBootstrapHoldsHardLines() &&
    bStepOrderHeld() &&
    B6_KEEP_STORY_OPEN &&
    B7_KEEP_STORY_OPEN &&
    BOOTSTRAP_TLS_SKIP_LABEL === "Skip for now" &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated
  );
}

export function settingsWizardVisualInheritsPriorStories(): boolean {
  return (
    SETTINGS_WIZARD_VISUAL.inheritV1Tokens &&
    SETTINGS_WIZARD_VISUAL.inheritV2Shell &&
    SETTINGS_WIZARD_VISUAL.inheritB6WizardChrome &&
    SETTINGS_WIZARD_VISUAL.inheritB7SkipChrome &&
    FIRST_RUN_BOOTSTRAP.neverOnEmbedV1 &&
    FIRST_RUN_BOOTSTRAP.skipTlsIsFirstClassExit &&
    FIRST_RUN_BOOTSTRAP.httpUntilTlsInSettings &&
    FIRST_RUN_BOOTSTRAP.settingsSurfacesSkippedTls &&
    FIRST_RUN_BOOTSTRAP.wizardNeverReappearsAfterComplete &&
    FIRST_RUN_BOOTSTRAP.failClosedStepOrder
  );
}

export function settingsWizardChromeRejectsForbiddenLook(source: string): boolean {
  return (
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source) &&
    settingsWizardChromeRejectsLightLook(source) &&
    !FORBIDDEN_THEME_TREES.some((tree) => source.includes(tree)) &&
    !N8N_ORANGE_TOKENS.some((token) =>
      source.toLowerCase().includes(token.toLowerCase()),
    )
  );
}
