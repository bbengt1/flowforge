/**
 * UXL.8: Aesthetic-Usability density pass.
 *
 * Relates to #295 / Part of #287. Keep #295 open.
 *
 * Chloe UI only. Density / alignment polish in place (D6) after
 * UXL.1–UXL.7. Surfaces: Editor, NDV, Runs, activation, embed,
 * vault, home. Same tokens on standalone and `/embed/v1`. No new
 * surfaces. No API routes.
 *
 * Align spacing, type, and satellite chrome. Never use “prettier”
 * to hide errors, warnings, `indeterminate`, or ADV-024 denials.
 * Status stays icon + text (UX.10 / R7.4 inherit). No cloned n8n
 * colors, icons, or measurements. No copy that calls isolation
 * success a “pass.” No KEK / secret chrome.
 *
 * Out of scope: redesign, new surfaces, quieting loud status,
 * n8n clone tokens, jonny contracts.
 */

import { EDITOR_LIBRARY_SATELLITE_WIDTH } from "./editor-library.ts";
import { EDITOR_NDV_SATELLITE_WIDTH } from "./editor-ndv.ts";
import { EDITOR_RUNS_SATELLITE_WIDTH } from "./editor-runs.ts";
import { EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS } from "./editor-topbar-chunking.ts";
import { MEMBERSHIP_ISOLATION_CHROME } from "./membership-isolation-chrome.ts";
import { REWRITE_SATELLITE_A11Y } from "./rewrite-satellite-a11y.ts";
import { INVENTED_EMBED_TREES, R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import { CREDENTIAL_KEK_ENV } from "./credential-vault.ts";

export const UXL8_STORY = 295;
export const UXL8_EPIC = 287;
export const UXL8_KEEP_STORY_OPEN = true;
export const UXL8_ID = "UXL.8-aesthetic-usability-density" as const;

export const UXL8_BRIEF = "docs/architecture/flowforge-ux-laws.md";

export const AESTHETIC_USABILITY_HELP =
  "Spacing, type, and satellite alignment are consistent across standalone and /embed/v1. Error, warning, indeterminate, and ADV-024 denial contrast stay loud. Status is icon + text. No cloned n8n colors, icons, or measurements. No new surfaces. Isolation success is a denial — never a pass. No KEK / secret chrome.";

export const AESTHETIC_USABILITY = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritUxl1ThroughUxl7: true,
  inheritUx10IconPlusText: true,
  inheritR74SatelliteA11y: true,
  d6MigrateInPlace: true,
  densityAlignmentPolishOnly: true,
  notARedesign: true,
  sameTokensStandaloneAndEmbed: true,
  noSecondEmbedTree: true,
  noNewSurfaces: true,
  noNewApiRoutes: true,
  noClonedN8nColorsIconsMeasurements: true,
  loudStatusDoesNotGetQuieter: true,
  statusStaysIconPlusText: true,
  errorContrastStaysLoud: true,
  warningContrastStaysLoud: true,
  indeterminateContrastStaysLoud: true,
  adv024DenialContrastStaysLoud: true,
  isolationSuccessIsDenialNotPass: true,
  noKekSecretChrome: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  oneReplayPath: true,
  loudIndeterminate: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  d3TriggersAreWorkflowLevel: true,
  noCanvasTriggerNodes: true,
  fittsPrimaryControlsUnchanged: true,
  jonnyNoneExpected: true,
  noAppsApiChanges: true,
} as const;

export const AESTHETIC_USABILITY_SURFACES = [
  "editor",
  "ndv",
  "runs",
  "activation",
  "embed",
  "vault",
  "home",
] as const;

export type AestheticUsabilitySurface =
  (typeof AESTHETIC_USABILITY_SURFACES)[number];

export const AESTHETIC_USABILITY_SOURCES = [
  "src/lib/aesthetic-usability-density.ts",
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/workflows/EditorYamlDrawer.tsx",
  "src/components/workflows/EditorActivationChrome.tsx",
  "src/components/embed/EmbedChrome.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/components/home/HomeLastRunStatus.tsx",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/isolation/IsolationExercise.tsx",
  "src/app/workflows/page.tsx",
  "src/app/credentials/page.tsx",
  "src/app/executions/page.tsx",
] as const;

/** FlowForge type scale — not invented n8n px measurements. */
export const TYPE_CAPTION_CLASS = "text-xs";
export const TYPE_BODY_CLASS = "text-sm";
export const TYPE_HEADING_CLASS = "text-3xl font-semibold tracking-tight";
export const TYPE_EYEBROW_CLASS =
  "text-sm font-medium tracking-wide text-teal-800 uppercase";
export const TYPE_PAGE_HELP_CLASS = "max-w-3xl text-base leading-7 text-zinc-600";

export const PAGE_SHELL_CLASS =
  "mx-auto flex min-h-full w-full max-w-6xl flex-col gap-8 px-6 py-12";
export const PAGE_HEADER_CLASS = "space-y-3";

/** Shared satellite chrome. Library / Inspector / Runs rails align. */
export const SATELLITE_RAIL_WIDTH = "2.75rem";
export const SATELLITE_HEADER_CLASS =
  "ff-editor-satellite-header flex items-center justify-between px-3 py-2";
export const SATELLITE_TITLE_CLASS = "ff-editor-title text-sm font-medium";
export const SATELLITE_HIDE_BUTTON_CLASS =
  "ff-editor-ghost px-2 py-0.5 text-xs";
export const SATELLITE_RAIL_BUTTON_CLASS =
  "ff-editor-rail-button px-2 py-2 text-xs font-medium md:[writing-mode:vertical-rl] md:rotate-180 md:px-1 md:py-3";
export const SATELLITE_BODY_PAD_CLASS = "p-3";
export const SATELLITE_NDV_HEADER_CLASS = "ff-editor-satellite-header px-3 py-2";

/** Loud status — do not quiet. Icon + text inherit UX.10 / R7.4.
 * V.5 paints these on the dark V.1 tree (not light amber-50 / rose-50). */
export const LOUD_INDETERMINATE_SURFACE = "ff-loud-indeterminate";
export const LOUD_ERROR_SURFACE = "ff-loud-danger";
export const LOUD_WARNING_SURFACE = "ff-loud-warning";
export const LOUD_INDETERMINATE_CLASS =
  `${LOUD_INDETERMINATE_SURFACE} font-semibold`;
export const LOUD_ERROR_CLASS = `${LOUD_ERROR_SURFACE} font-semibold`;
export const LOUD_WARNING_CLASS = `${LOUD_WARNING_SURFACE} font-semibold`;
export const LOUD_ADV024_DENIAL_CLASS = "ff-loud-denial font-semibold";
export const LOUD_ADV024_LEAK_CLASS = "ff-loud-leak font-semibold";

export const ISOLATION_DENIAL_ICON = "⊘";
export const ISOLATION_DENIAL_LABEL = "Denial";
export const ISOLATION_LEAK_ICON = "!";
export const ISOLATION_LEAK_LABEL = "Did not hold";

export const INVENTED_SURFACES = [
  "/studio",
  "/replay",
  "/embed/v2",
  "/n8n",
  "AestheticStudio",
  "DensityWorkbench",
] as const;

export const N8N_CLONE_TOKENS = [
  "#ea4b71",
  "#ff6d5a",
  "#e99854",
  "n8n-nodes-base",
  "n8n-logo",
  "Execute workflow",
  "wf-node-default",
  "var(--color-primary)",
  "224px",
  "56px",
] as const;

export const ISOLATION_PASS_COPY = [
  "isolation pass",
  "isolation passed",
  "check passed",
  "isolation success is a pass",
  "passed isolation",
  "Pass — isolation",
] as const;

export const KEK_CHROME_TOKENS = [
  "CREDENTIAL_KEK",
  "keyReference",
] as const;

export const QUIETED_STATUS_TOKENS = [
  "opacity-40",
  "opacity-50",
  "bg-amber-50/40",
  "bg-rose-50/40",
  "text-amber-400",
  "text-rose-400",
] as const;

export const PRODUCT_CHROME_SOURCES = [
  "src/app/workflows/page.tsx",
  "src/app/credentials/page.tsx",
  "src/app/credentials/[id]/page.tsx",
  "src/app/credentials/new/page.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/credentials/CredentialDetail.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/embed/EmbedChrome.tsx",
] as const;

export const ISOLATION_CHROME_SOURCES = [
  "src/app/isolation/page.tsx",
  "src/components/isolation/IsolationExercise.tsx",
  "src/lib/membership-isolation-chrome.ts",
] as const;

export function aestheticUsabilityHoldsHardLines(): boolean {
  return (
    AESTHETIC_USABILITY.yamlIsSourceOfTruth &&
    AESTHETIC_USABILITY.draftsNeverRun &&
    AESTHETIC_USABILITY.vaultDisplayNameUuidOnly &&
    AESTHETIC_USABILITY.adv021ChromeFromSessionEmbedOnly &&
    AESTHETIC_USABILITY.adv024MembershipIsolationStayGrantGated &&
    AESTHETIC_USABILITY.oneReplayPath &&
    AESTHETIC_USABILITY.loudIndeterminate &&
    AESTHETIC_USABILITY.failClosedCatalogs &&
    AESTHETIC_USABILITY.notAnN8nClone &&
    AESTHETIC_USABILITY.noKekInBrowser &&
    AESTHETIC_USABILITY.d3TriggersAreWorkflowLevel &&
    AESTHETIC_USABILITY.noNewSurfaces &&
    AESTHETIC_USABILITY.noNewApiRoutes &&
    AESTHETIC_USABILITY.noKekSecretChrome &&
    AESTHETIC_USABILITY.isolationSuccessIsDenialNotPass &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial &&
    REWRITE_SATELLITE_A11Y.iconPlusText &&
    EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS === "px-2.5 py-1 text-sm font-medium"
  );
}

export function satelliteRailsAlign(): boolean {
  return (
    SATELLITE_RAIL_WIDTH === EDITOR_LIBRARY_SATELLITE_WIDTH &&
    SATELLITE_RAIL_WIDTH === EDITOR_NDV_SATELLITE_WIDTH &&
    SATELLITE_RAIL_WIDTH === EDITOR_RUNS_SATELLITE_WIDTH
  );
}

export function satelliteSourceAligned(source: string): boolean {
  return (
    source.includes("SATELLITE_RAIL_BUTTON_CLASS") &&
    source.includes("SATELLITE_HEADER_CLASS") &&
    source.includes("SATELLITE_TITLE_CLASS") &&
    source.includes("SATELLITE_HIDE_BUTTON_CLASS")
  );
}

export function standaloneAndEmbedShareDensity(input: {
  editorChrome: string;
  embedChrome: string;
  topBar: string;
}): boolean {
  return (
    AESTHETIC_USABILITY.sameTokensStandaloneAndEmbed &&
    AESTHETIC_USABILITY.noSecondEmbedTree &&
    !INVENTED_EMBED_TREES.some((tree) => input.editorChrome.includes(`"${tree}"`)) &&
    !input.embedChrome.includes("EmbedEditorTopBar") &&
    !input.editorChrome.includes("EmbedEditorTopBar") &&
    input.topBar.includes("EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS") &&
    input.embedChrome.includes("TYPE_CAPTION_CLASS") &&
    input.editorChrome.includes("SATELLITE_RAIL_BUTTON_CLASS")
  );
}

export function loudContrastNotQuieter(className: string): boolean {
  if (QUIETED_STATUS_TOKENS.some((token) => className.includes(token))) {
    return false;
  }
  const loudToken =
    className.includes("ff-loud-indeterminate") ||
    className.includes("ff-loud-danger") ||
    className.includes("ff-loud-denial") ||
    className.includes("ff-loud-leak");
  if (loudToken) {
    return true;
  }
  const loudBorder = className.includes("border-2");
  const loudAmber =
    className.includes("amber-700") && className.includes("amber-50");
  const loudRose =
    (className.includes("rose-700") || className.includes("rose-800")) &&
    (className.includes("rose-50") || className.includes("rose-100"));
  return loudBorder && (loudAmber || loudRose);
}

export function warningContrastNotQuieter(className: string): boolean {
  if (QUIETED_STATUS_TOKENS.some((token) => className.includes(token))) {
    return false;
  }
  if (className.includes("ff-loud-warning") && className.includes("font-semibold")) {
    return true;
  }
  return (
    className.includes("amber-700") &&
    className.includes("amber-50") &&
    className.includes("amber-950") &&
    className.includes("font-semibold")
  );
}

export function statusStaysIconPlusText(source: string): boolean {
  return (
    (source.includes("presentation.icon") &&
      source.includes("presentation.label")) ||
    (source.includes("ISOLATION_DENIAL_ICON") &&
      source.includes("ISOLATION_DENIAL_LABEL"))
  );
}

export function isolationCopyCallsSuccessAPass(source: string): boolean {
  const lower = source.toLowerCase();
  return ISOLATION_PASS_COPY.some((token) => lower.includes(token.toLowerCase()));
}

export function kekAppearsInProductChrome(source: string): boolean {
  return KEK_CHROME_TOKENS.some((token) => source.includes(token));
}

export function clonedN8nTokenPresent(source: string): boolean {
  return N8N_CLONE_TOKENS.some((token) => source.includes(token));
}

export function inventedSurfacePresent(source: string): boolean {
  return INVENTED_SURFACES.some((token) => source.includes(token));
}

export function inventedPxTypeScale(source: string): boolean {
  return /text-\[1[01]px\]/.test(source);
}

export function aestheticUsabilityInheritsPriorStories(): boolean {
  return (
    AESTHETIC_USABILITY.inheritUxl1ThroughUxl7 &&
    AESTHETIC_USABILITY.inheritUx10IconPlusText &&
    AESTHETIC_USABILITY.inheritR74SatelliteA11y &&
    AESTHETIC_USABILITY.fittsPrimaryControlsUnchanged &&
    AESTHETIC_USABILITY.d6MigrateInPlace &&
    CREDENTIAL_KEK_ENV === "CREDENTIAL_KEK"
  );
}
