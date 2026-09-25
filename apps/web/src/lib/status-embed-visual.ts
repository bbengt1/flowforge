/**
 * V.7: Status + embed visual gate.
 *
 * Relates to #363 / Part of #353. Keep #363 open.
 *
 * Chloe UI only. Last visual slice in epic #353. This is a gate
 * pass across standalone and `/embed/v1` after V.1–V.6 — not a
 * second restyle and not a second embed tree. Shared status
 * chrome + V.1 tokens. Do not fork embed chrome.
 *
 * Acceptance: icon+text on every status; success ≠ indeterminate;
 * ADV-024 denial contrast holds; standalone and embed match
 * (spacing, type, cards, satellites); catalog 403 / missing
 * `session.embed` still fail closed. Loud indeterminate,
 * waiting→decide, and peak-end focused success stay as behavior.
 *
 * Hard lines: ADV-021/024 · embed parity · drafts never run ·
 * not an n8n clone · vault display-name+UUID · YAML SoT ·
 * isolation success is a Denial.
 */

import {
  AESTHETIC_USABILITY,
  ISOLATION_DENIAL_ICON,
  ISOLATION_DENIAL_LABEL,
  LOUD_ADV024_DENIAL_CLASS,
  LOUD_ADV024_LEAK_CLASS,
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
  LOUD_WARNING_CLASS,
  SATELLITE_RAIL_WIDTH,
  loudContrastNotQuieter,
  satelliteRailsAlign,
  statusStaysIconPlusText,
} from "./aesthetic-usability-density.ts";
import { EDITOR_ENGINE_CATALOG } from "./catalog-fail-closed.ts";
import { DOHERTY_PENDING_CHROME } from "./doherty-pending-chrome.ts";
import { EDITOR_LIBRARY, EDITOR_LIBRARY_SATELLITE_WIDTH } from "./editor-library.ts";
import { EDITOR_NDV_SATELLITE_WIDTH } from "./editor-ndv.ts";
import { EDITOR_RUNS_SATELLITE_WIDTH } from "./editor-runs.ts";
import { EDITOR_VISUAL } from "./editor-visual.ts";
import { executionStatusPresentation } from "./execution.ts";
import type { ExecutionStatusPresentation } from "./execution-types.ts";
import {
  isolationHeldIsSuccess,
  MEMBERSHIP_ISOLATION_CHROME,
} from "./membership-isolation-chrome.ts";
import { OVERVIEW_VISUAL } from "./overview-visual.ts";
import { PALETTE_CATEGORY_FIRST, PALETTE_CATALOG_UNAVAILABLE_HELP } from "./palette-category-first.ts";
import {
  PEAK_END_OPERATE,
  peakEndSuccessIsDistinctFromIndeterminate,
  peakEndSurfaceClassName,
} from "./peak-end-operate-endings.ts";
import {
  INVENTED_EMBED_TREES,
  R7_HARD_LINE,
} from "./rewrite-embed-mount.ts";
import { SETTINGS_WIZARD_VISUAL } from "./settings-wizard-visual.ts";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./session-embed-contract.ts";
import { SHELL_RESTYLE } from "./shell-restyle.ts";
import { VAULT_EXECUTIONS_VISUAL } from "./vault-executions-visual.ts";
import {
  FF_ACCENT,
  FF_CANVAS,
  FF_DANGER,
  FF_SURFACE,
  FORBIDDEN_THEME_TREES,
  N8N_ORANGE_TOKENS,
  VISUAL_TOKENS,
  contrastHolds,
  n8nOrangePresent,
  secondThemeTreePresent,
} from "./visual-tokens.ts";

export const V7_STORY = 363;
export const V7_EPIC = 353;
export const V7_KEEP_STORY_OPEN = true;
export const V7_ID = "V.7-status-embed-visual-gate" as const;
export const V7_BRIEF = "docs/architecture/flowforge-visual-ia-north-star.md";
export const V7_TOKEN_FILE = "src/app/tokens.css";

export const V7_HELP =
  "Icon+text on every status. Success ≠ indeterminate. ADV-024 denial contrast holds. Standalone and /embed/v1 match (spacing, type, cards, satellites). No second tree. Catalog 403 / missing session.embed still fail closed. Loud indeterminate, waiting→decide, and peak-end focused success stay as behavior.";

export const STATUS_EMBED_VISUAL = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  inheritV2Shell: true,
  inheritV3Overview: true,
  inheritV4Editor: true,
  inheritV5VaultInbox: true,
  inheritV6SettingsWizard: true,
  inheritUxl4PeakEnd: true,
  inheritUxl8LoudContrast: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  visualGateOnly: true,
  noSecondRestyle: true,
  sharedStatusComponents: true,
  noForkedEmbedChrome: true,
  iconPlusTextOnEveryStatus: true,
  successDistinctFromIndeterminate: true,
  loudIndeterminateStays: true,
  waitingDecideStays: true,
  peakEndFocusedSuccessStays: true,
  adv024DenialContrastHolds: true,
  isolationSuccessIsDenial: true,
  standaloneEmbedMatch: true,
  sameSpacingTypeCardsSatellites: true,
  noSecondEmbedTree: true,
  catalog403FailsClosed: true,
  missingSessionEmbedFailsClosed: true,
  draftsNeverRun: true,
  yamlIsSourceOfTruth: true,
  vaultDisplayNameUuidOnly: true,
  oneAccent: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  noSecondThemeTree: true,
  noGreenfieldApis: true,
  keep363Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_STATUS_ATTR = "data-ff-status";
export const FF_STATUS_VALUE = "v7";

export const FF_STATUS_CLASS = "ff-status";
export const FF_STATUS_RUNNING_CLASS = "ff-status-running";
export const FF_STATUS_SUCCEEDED_CLASS = "ff-status-succeeded";
export const FF_STATUS_CANCELED_CLASS = "ff-status-canceled";
export const FF_STATUS_QUEUED_CLASS = "ff-status-queued";
export const FF_STATUS_CLAIMED_CLASS = "ff-status-claimed";
export const FF_STATUS_OTHER_CLASS = "ff-status-other";
export const FF_STATUS_WAITING_CLASS = "ff-status-waiting";
export const FF_STATUS_BLOCKED_CLASS = "ff-status-blocked";
export const FF_STATUS_PENDING_CLASS = "ff-status-pending";
export const FF_STATUS_SKIPPED_CLASS = "ff-status-skipped";

export const STATUS_TONE_CLASSES = {
  indeterminate: LOUD_INDETERMINATE_CLASS,
  running: FF_STATUS_RUNNING_CLASS,
  canceled: `${FF_STATUS_CANCELED_CLASS} font-semibold`,
  failed: LOUD_ERROR_CLASS,
  succeeded: FF_STATUS_SUCCEEDED_CLASS,
  queued: FF_STATUS_QUEUED_CLASS,
  claimed: FF_STATUS_CLAIMED_CLASS,
  other: FF_STATUS_OTHER_CLASS,
  waiting: `${FF_STATUS_WAITING_CLASS} font-semibold`,
  blocked: FF_STATUS_BLOCKED_CLASS,
  pending: FF_STATUS_PENDING_CLASS,
  skipped: FF_STATUS_SKIPPED_CLASS,
  warning: LOUD_WARNING_CLASS,
  denial: LOUD_ADV024_DENIAL_CLASS,
  leak: LOUD_ADV024_LEAK_CLASS,
} as const;

export type VisualStatusTone = keyof typeof STATUS_TONE_CLASSES;

export const V7_SOURCES = [
  "src/lib/status-embed-visual.ts",
  "src/lib/aesthetic-usability-density.ts",
  "src/lib/peak-end-operate-endings.ts",
  "src/lib/catalog-fail-closed.ts",
  "src/lib/session-embed-contract.ts",
  "src/components/chrome/StatusMark.tsx",
  "src/components/executions/ExecutionStatusBadge.tsx",
  "src/components/alerts/AlertSeverityBadge.tsx",
  "src/components/home/HomeLastRunStatus.tsx",
  "src/components/home/HomeActivationStatus.tsx",
  "src/components/isolation/IsolationExercise.tsx",
  "src/components/embed/EmbedChrome.tsx",
  "src/components/workflows/EditorChrome.tsx",
  "src/app/globals.css",
] as const;

export const V7_STATUS_SOURCES = [
  "src/components/chrome/StatusMark.tsx",
  "src/components/executions/ExecutionStatusBadge.tsx",
  "src/components/alerts/AlertSeverityBadge.tsx",
  "src/components/home/HomeLastRunStatus.tsx",
  "src/components/home/HomeActivationStatus.tsx",
  "src/components/workflows/EditorActivationChrome.tsx",
  "src/components/isolation/IsolationExercise.tsx",
] as const;

export const V7_EMBED_SOURCES = [
  "src/components/embed/EmbedChrome.tsx",
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/app/globals.css",
] as const;

export const LIGHT_STATUS_TOKENS = [
  "bg-white",
  "bg-emerald-50",
  "bg-sky-50",
  "bg-indigo-50",
  "bg-zinc-50",
  "bg-amber-50",
  "bg-rose-50",
  "text-zinc-800",
  "text-zinc-900",
  "border-zinc-300",
] as const;

export const FORBIDDEN_STATUS_HEX = [
  "#38bdf8",
  "#34d399",
  "#818cf8",
  "#6366f1",
  "#c7d2fe",
  "#e0e7ff",
  "#d1fae5",
  "#e0f2fe",
] as const;

export const FORBIDDEN_EMBED_FORKS = [
  "EmbedEditorTopBar",
  "EmbedStatusBadge",
  "EmbedStatusMark",
  "embed-tokens.css",
  "tokens-embed.css",
  ...INVENTED_EMBED_TREES,
] as const;

export function statusToneClass(tone: VisualStatusTone): string {
  return STATUS_TONE_CLASSES[tone];
}

export function executionStatusToneClass(
  tone: ExecutionStatusPresentation["tone"] | "waiting",
): string {
  if (tone === "waiting") {
    return STATUS_TONE_CLASSES.waiting;
  }
  return STATUS_TONE_CLASSES[tone];
}

export function lastRunStatusClassName(kind: string): string {
  if (kind === "indeterminate") {
    return LOUD_INDETERMINATE_CLASS;
  }
  if (kind === "waiting") {
    return STATUS_TONE_CLASSES.waiting;
  }
  if (kind === "failed") {
    return LOUD_ERROR_CLASS;
  }
  if (kind === "success" || kind === "succeeded") {
    return FF_STATUS_SUCCEEDED_CLASS;
  }
  if (kind === "running") {
    return FF_STATUS_RUNNING_CLASS;
  }
  if (kind === "blocked") {
    return FF_STATUS_BLOCKED_CLASS;
  }
  if (kind === "pending") {
    return FF_STATUS_PENDING_CLASS;
  }
  if (kind === "skipped") {
    return FF_STATUS_SKIPPED_CLASS;
  }
  return STATUS_TONE_CLASSES.other;
}

export function successIsDistinctFromIndeterminate(): boolean {
  const success = executionStatusPresentation("succeeded");
  const uncertain = executionStatusPresentation("indeterminate");
  const successClass = statusToneClass("succeeded");
  const uncertainClass = statusToneClass("indeterminate");
  return (
    STATUS_EMBED_VISUAL.successDistinctFromIndeterminate &&
    peakEndSuccessIsDistinctFromIndeterminate() &&
    success.icon !== uncertain.icon &&
    success.label !== uncertain.label &&
    success.tone !== uncertain.tone &&
    successClass !== uncertainClass &&
    !successClass.includes("indeterminate") &&
    uncertainClass.includes("ff-loud-indeterminate") &&
    successClass.includes("ff-status-succeeded") &&
    peakEndSurfaceClassName("success") !== peakEndSurfaceClassName("indeterminate") &&
    !/indeterminate/i.test(success.label) &&
    /indeterminate/i.test(uncertain.label)
  );
}

export function statusPresentationIsIconPlusText(
  presentation: Pick<ExecutionStatusPresentation, "icon" | "label">,
): boolean {
  return Boolean(presentation.icon.trim()) && Boolean(presentation.label.trim());
}

export function everyExecutionStatusIsIconPlusText(): boolean {
  const statuses = [
    "running",
    "canceled",
    "failed",
    "indeterminate",
    "queued",
    "claimed",
    "succeeded",
    "waiting",
    "blocked",
    "pending",
    "skipped",
  ] as const;
  return statuses.every((status) =>
    statusPresentationIsIconPlusText(executionStatusPresentation(status)),
  );
}

export function isolationDenialIsIconPlusText(): boolean {
  return (
    ISOLATION_DENIAL_ICON.trim().length > 0 &&
    ISOLATION_DENIAL_LABEL === "Denial" &&
    MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial &&
    isolationHeldIsSuccess(true)
  );
}

export function adv024DenialContrastHolds(): boolean {
  return (
    STATUS_EMBED_VISUAL.adv024DenialContrastHolds &&
    LOUD_ADV024_DENIAL_CLASS.includes("ff-loud-denial") &&
    loudContrastNotQuieter(LOUD_ADV024_DENIAL_CLASS) &&
    loudContrastNotQuieter(LOUD_ADV024_LEAK_CLASS) &&
    contrastHolds(FF_DANGER, FF_CANVAS) &&
    contrastHolds(FF_DANGER, FF_SURFACE) &&
    isolationDenialIsIconPlusText()
  );
}

export function catalog403FailsClosed(): boolean {
  return (
    STATUS_EMBED_VISUAL.catalog403FailsClosed &&
    EDITOR_ENGINE_CATALOG.catalog403FailsClosed &&
    EDITOR_ENGINE_CATALOG.emptyFailsClosed &&
    EDITOR_LIBRARY.catalog403FailsClosed &&
    EDITOR_LIBRARY.emptyCatalogFailsClosed &&
    DOHERTY_PENDING_CHROME.catalog403FailsClosed &&
    DOHERTY_PENDING_CHROME.emptyCatalogFailsClosed &&
    PALETTE_CATEGORY_FIRST.missingCatalogFailsClosed &&
    /HTTP 403/.test(PALETTE_CATALOG_UNAVAILABLE_HELP)
  );
}

export function missingSessionEmbedFailsClosed(embedChrome: string): boolean {
  return (
    STATUS_EMBED_VISUAL.missingSessionEmbedFailsClosed &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    embedChrome.includes("EMBED_CHROME_MISSING_SESSION_MESSAGE") &&
    embedChrome.includes('role="alert"') &&
    embedChrome.includes("missingEmbed") &&
    EMBED_CHROME_MISSING_SESSION_MESSAGE.includes("session.embed")
  );
}

export function standaloneAndEmbedMatch(input: {
  embedChrome: string;
  editorChrome: string;
  topBar: string;
  home: string;
  globals: string;
}): boolean {
  return (
    STATUS_EMBED_VISUAL.standaloneEmbedMatch &&
    STATUS_EMBED_VISUAL.noSecondEmbedTree &&
    STATUS_EMBED_VISUAL.noForkedEmbedChrome &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    satelliteRailsAlign() &&
    SATELLITE_RAIL_WIDTH === EDITOR_LIBRARY_SATELLITE_WIDTH &&
    SATELLITE_RAIL_WIDTH === EDITOR_NDV_SATELLITE_WIDTH &&
    SATELLITE_RAIL_WIDTH === EDITOR_RUNS_SATELLITE_WIDTH &&
    !FORBIDDEN_EMBED_FORKS.some((token) => input.embedChrome.includes(token)) &&
    !FORBIDDEN_EMBED_FORKS.some((token) => input.editorChrome.includes(token)) &&
    !input.globals.includes("embed-tokens") &&
    !input.globals.includes("tokens-embed") &&
    input.embedChrome.includes("FF_SHELL_HEADER_CLASS") &&
    input.embedChrome.includes("SessionStatusChip") &&
    input.embedChrome.includes("TYPE_CAPTION_CLASS") &&
    input.editorChrome.includes("SATELLITE_RAIL_BUTTON_CLASS") &&
    input.topBar.includes("EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS") &&
    input.home.includes("WorkflowHome") &&
    OVERVIEW_VISUAL.sameWorkflowHomeOnEmbed &&
    SHELL_RESTYLE.embedSameShellAfterSessionEmbed
  );
}

export function statusUsesV1TokenClasses(globals: string): boolean {
  return (
    globals.includes(`.${FF_STATUS_SUCCEEDED_CLASS}`) &&
    globals.includes(`.${FF_STATUS_RUNNING_CLASS}`) &&
    globals.includes(`.${FF_STATUS_WAITING_CLASS}`) &&
    globals.includes(".ff-loud-indeterminate") &&
    globals.includes(".ff-loud-denial") &&
    globals.includes("background: var(--ff-surface)") &&
    globals.includes("var(--ff-accent)") &&
    globals.includes("var(--ff-danger)") &&
    !FORBIDDEN_STATUS_HEX.some((hex) => globals.includes(hex))
  );
}

export function statusChromeRejectsLightLook(source: string): boolean {
  return LIGHT_STATUS_TOKENS.every((token) => !source.includes(token));
}

export function statusVisualHoldsAcceptance(input: {
  mark: string;
  badge: string;
  lastRun: string;
  activation: string;
  isolation: string;
  alert: string;
}): boolean {
  return (
    input.mark.includes(FF_STATUS_ATTR) &&
    input.mark.includes("FF_STATUS_VALUE") &&
    input.mark.includes("icon") &&
    input.mark.includes("label") &&
    input.badge.includes("StatusMark") &&
    input.badge.includes("executionStatusToneClass") &&
    input.badge.includes("presentation.icon") &&
    input.badge.includes("presentation.label") &&
    statusStaysIconPlusText(input.badge) &&
    input.lastRun.includes("lastRunStatusClassName") &&
    input.lastRun.includes("presentation.icon") &&
    input.lastRun.includes("presentation.label") &&
    input.activation.includes("presentation.icon") &&
    input.activation.includes("presentation.label") &&
    input.isolation.includes("ISOLATION_DENIAL_ICON") &&
    input.isolation.includes("ISOLATION_DENIAL_LABEL") &&
    input.isolation.includes("LOUD_ADV024_DENIAL_CLASS") &&
    input.alert.includes("StatusMark") &&
    input.alert.includes("presentation.icon") &&
    input.alert.includes("presentation.label")
  );
}

export function statusEmbedVisualHoldsHardLines(): boolean {
  return (
    STATUS_EMBED_VISUAL.yamlIsSourceOfTruth &&
    STATUS_EMBED_VISUAL.draftsNeverRun &&
    STATUS_EMBED_VISUAL.vaultDisplayNameUuidOnly &&
    STATUS_EMBED_VISUAL.adv024DenialContrastHolds &&
    STATUS_EMBED_VISUAL.isolationSuccessIsDenial &&
    STATUS_EMBED_VISUAL.catalog403FailsClosed &&
    STATUS_EMBED_VISUAL.missingSessionEmbedFailsClosed &&
    STATUS_EMBED_VISUAL.noSecondEmbedTree &&
    STATUS_EMBED_VISUAL.noForkedEmbedChrome &&
    STATUS_EMBED_VISUAL.notAnN8nClone &&
    STATUS_EMBED_VISUAL.noN8nOrange &&
    STATUS_EMBED_VISUAL.noSecondThemeTree &&
    STATUS_EMBED_VISUAL.keep363Open &&
    STATUS_EMBED_VISUAL.inheritV1Tokens &&
    STATUS_EMBED_VISUAL.uiOnly &&
    STATUS_EMBED_VISUAL.noGreenfieldApis &&
    successIsDistinctFromIndeterminate() &&
    everyExecutionStatusIsIconPlusText() &&
    adv024DenialContrastHolds() &&
    catalog403FailsClosed() &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_CANVAS.toLowerCase() === "#0f1218" &&
    FF_SURFACE.toLowerCase() === "#171b22" &&
    FF_DANGER.toLowerCase() === "#fb7185" &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated &&
    MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial &&
    PEAK_END_OPERATE.loudIndeterminateOnOverlayAndInbox &&
    PEAK_END_OPERATE.waitingDecideOnOverlayAndInbox &&
    PEAK_END_OPERATE.successExplicitAndDistinctFromIndeterminate
  );
}

export function statusEmbedVisualInheritsPriorStories(): boolean {
  return (
    STATUS_EMBED_VISUAL.inheritV1Tokens &&
    STATUS_EMBED_VISUAL.inheritV2Shell &&
    STATUS_EMBED_VISUAL.inheritV3Overview &&
    STATUS_EMBED_VISUAL.inheritV4Editor &&
    STATUS_EMBED_VISUAL.inheritV5VaultInbox &&
    STATUS_EMBED_VISUAL.inheritV6SettingsWizard &&
    STATUS_EMBED_VISUAL.inheritUxl4PeakEnd &&
    STATUS_EMBED_VISUAL.inheritUxl8LoudContrast &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    SHELL_RESTYLE.embedSameShellAfterSessionEmbed &&
    OVERVIEW_VISUAL.sameWorkflowHomeOnEmbed &&
    EDITOR_VISUAL.inheritV1Tokens &&
    VAULT_EXECUTIONS_VISUAL.loudIndeterminate &&
    SETTINGS_WIZARD_VISUAL.wizardNeverOnEmbedV1 &&
    AESTHETIC_USABILITY.statusStaysIconPlusText &&
    AESTHETIC_USABILITY.adv024DenialContrastStaysLoud &&
    PEAK_END_OPERATE.successExplicitAndDistinctFromIndeterminate
  );
}

export function statusChromeRejectsForbiddenLook(source: string): boolean {
  return (
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source) &&
    statusChromeRejectsLightLook(source) &&
    !FORBIDDEN_THEME_TREES.some((tree) => source.includes(tree)) &&
    !N8N_ORANGE_TOKENS.some((token) =>
      source.toLowerCase().includes(token.toLowerCase()),
    ) &&
    !FORBIDDEN_STATUS_HEX.some((hex) => source.includes(hex))
  );
}
