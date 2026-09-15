/**
 * V.3: Overview home visual rebuild.
 *
 * Relates to #359 / Part of #353. Keep #359 open.
 *
 * Chloe UI only. Dark Overview cards on the V.1 token tree
 * (docs/architecture/flowforge-visual-ia-north-star.md § home / V.3).
 * Standalone and `/embed/v1` share the same `WorkflowHome`. No
 * second theme. No n8n orange or n8n Overview tabs.
 *
 * Surfaces: `/workflows`, `/embed/v1/workflows`. Inherits F.1–F.7
 * + O.1–O.4 IA. Visual rebuild only — not a folder/API rewrite.
 * Compact Finder rail stays filter-only / non-recursive. Unfiled
 * has no path pills. Empty states stay UXL.6 / O.3. Move still
 * `PATCH folderId` only. Scan ends stay activation + last run
 * (UXL.5). No stats / Personal / link-count / Miller columns.
 *
 * Hard lines: YAML SoT · drafts never run · folders not in YAML ·
 * vault display-name+UUID · ADV-021/024 · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no greenfield APIs.
 */

import { OVERVIEW_EMPTY, overviewEmptyUsesCardChrome } from "./overview-empty-states.ts";
import {
  OVERVIEW_EMBED,
  embedOverviewUsesSharedWorkflowHome,
} from "./overview-embed.ts";
import {
  OVERVIEW_CARD_SURFACE_CLASS,
  OVERVIEW_HOME,
  overviewCardListIsPrimary,
  overviewHasSearchSortFilterRow,
  overviewSkipsDeferredChrome,
} from "./overview-home.ts";
import {
  OVERVIEW_PATH_PILLS,
  overviewCardsShowPathPills,
  overviewFinderRailIsCompactFilterOnly,
  overviewUnfiledHasNoFakeFolder,
} from "./overview-path-pills.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  FF_ACCENT,
  FF_CANVAS,
  FF_SURFACE,
  FORBIDDEN_THEME_TREES,
  N8N_ORANGE_TOKENS,
  VISUAL_TOKENS,
  n8nOrangePresent,
  secondThemeTreePresent,
} from "./visual-tokens.ts";
import {
  F4_HOME_FOLDER,
  F7_HOME_FOLDER,
  embedFolderUsesSharedWorkflowHome,
} from "./workflow-folder.ts";

export const V3_STORY = 359;
export const V3_EPIC = 353;
export const V3_KEEP_STORY_OPEN = true;
export const V3_ID = "V.3-overview-home-visual-rebuild" as const;
export const V3_BRIEF = "docs/architecture/flowforge-visual-ia-north-star.md";
export const V3_TOKEN_FILE = "src/app/tokens.css";

export const V3_HELP =
  "Dark card rows using V.1 tokens. Header + Create; search/sort/filter; path pills; published/activation/last-run at the scan ends; kebab. Compact Finder rail stays filter-only / non-recursive. Unfiled has no pills. No stats, Personal, link-count, Miller columns, or n8n Overview tabs. Empty states stay UXL.6 / O.3. Move still PATCH folderId only. Same WorkflowHome on embed (O.4). Not an n8n clone.";

export const OVERVIEW_VISUAL = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  inheritV2Shell: true,
  inheritF1ThroughF7: true,
  inheritO1ThroughO4: true,
  inheritUxl5ScanEnds: true,
  inheritUxl6EmptyVerbs: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  darkCardRows: true,
  headerHasCreateCta: true,
  searchSortFilterRow: true,
  pathPillsStay: true,
  unfiledHasNoPills: true,
  publishedActivationLastRunAtScanEnds: true,
  kebabStays: true,
  compactFinderRailFilterOnly: true,
  nonRecursiveFolderIdStays: true,
  noStats: true,
  noPersonal: true,
  noLinkCount: true,
  noMillerColumns: true,
  noN8nOverviewTabs: true,
  emptyStatesStayUxl6O3: true,
  moveStillPatchFolderIdOnly: true,
  sameWorkflowHomeOnEmbed: true,
  oneAccent: true,
  accentIsTealFamily: true,
  noSecondThemeTree: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  foldersNotInYaml: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  noGreenfieldApis: true,
  keep359Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_OVERVIEW_ATTR = "data-ff-overview";
export const FF_OVERVIEW_VALUE = "v3";

export const FF_OVERVIEW_ROOT_CLASS = "ff-overview";
export const FF_OVERVIEW_CARD_CLASS = "ff-overview-card";
export const FF_OVERVIEW_CARD_ROW_CLASS = "ff-overview-card-row";
export const FF_OVERVIEW_HEADER_CLASS = "ff-overview-header";
export const FF_OVERVIEW_RAIL_CLASS = "ff-overview-rail";
export const FF_OVERVIEW_CREATE_CLASS = "ff-overview-create";
export const FF_OVERVIEW_CONTROL_CLASS = "ff-overview-control";
export const FF_OVERVIEW_GHOST_CLASS = "ff-overview-ghost";
export const FF_OVERVIEW_PILL_CLASS = "ff-overview-pill";
export const FF_OVERVIEW_CHIP_CLASS = "ff-overview-chip";
export const FF_OVERVIEW_CHIP_ACCENT_CLASS = "ff-overview-chip-accent";
export const FF_OVERVIEW_MUTED_CLASS = "ff-overview-muted";
export const FF_OVERVIEW_TITLE_CLASS = "ff-overview-title";
export const FF_OVERVIEW_LINK_CLASS = "ff-overview-link";
export const FF_OVERVIEW_KEBAB_CLASS = "ff-overview-kebab";
export const FF_OVERVIEW_MENU_CLASS = "ff-overview-menu";
export const FF_OVERVIEW_DIALOG_CLASS = "ff-overview-dialog";
export const FF_OVERVIEW_RAIL_ITEM_CLASS = "ff-overview-rail-item";
export const FF_OVERVIEW_RAIL_ACTIVE_CLASS = "ff-overview-rail-active";
export const FF_OVERVIEW_DANGER_CLASS = "ff-overview-danger";
export const FF_OVERVIEW_SCAN_LEAD_CLASS = "ff-overview-scan-lead";
export const FF_OVERVIEW_SCAN_TRAIL_CLASS = "ff-overview-scan-trail";

export const V3_SOURCES = [
  "src/lib/overview-visual.ts",
  "src/lib/overview-home.ts",
  "src/lib/overview-path-pills.ts",
  "src/lib/overview-empty-states.ts",
  "src/lib/overview-embed.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/components/home/HomeActivationStatus.tsx",
  "src/components/home/HomeLastRunStatus.tsx",
  "src/app/workflows/page.tsx",
  "src/app/globals.css",
] as const;

export const V3_CHROME_SOURCES = [
  "src/components/home/WorkflowHome.tsx",
  "src/components/home/HomeActivationStatus.tsx",
  "src/app/globals.css",
] as const;

export const LIGHT_OVERVIEW_TOKENS = [
  "bg-white",
  "bg-white/80",
  "bg-white/95",
  "border-zinc-200",
  "border-zinc-300",
  "bg-zinc-50",
  "bg-teal-50",
  "text-zinc-900",
  "text-teal-950",
  "#f6f5f1",
] as const;

export const N8N_OVERVIEW_TAB_TOKENS = [
  'data-o1="n8n-tabs"',
  "n8n Overview",
  "Credentials / Executions / Variables",
  "Data tables",
  "Workflows / Credentials / Executions",
] as const;

export const OVERVIEW_DEFERRED_IA_TOKENS = [
  'data-o1="stats"',
  'data-o1="personal"',
  'data-o1="link-count"',
  "Prod. executions",
  "Time saved",
  "Personal badge",
  "data-miller",
  "Miller columns",
] as const;

export function overviewUsesV1TokenClasses(globals: string): boolean {
  return (
    globals.includes(`.${FF_OVERVIEW_CARD_CLASS}`) &&
    globals.includes(`.${FF_OVERVIEW_HEADER_CLASS}`) &&
    globals.includes(`.${FF_OVERVIEW_RAIL_CLASS}`) &&
    globals.includes(`.${FF_OVERVIEW_CREATE_CLASS}`) &&
    globals.includes("background: var(--ff-surface)") &&
    globals.includes("background: var(--ff-accent)") &&
    globals.includes("color: var(--ff-accent-foreground)") &&
    globals.includes("var(--ff-text)") &&
    globals.includes("var(--ff-muted)") &&
    globals.includes("var(--ff-border)") &&
    globals.includes("var(--ff-radius)")
  );
}

export function overviewCardClassIsDarkTokenRow(): boolean {
  return (
    OVERVIEW_CARD_SURFACE_CLASS === FF_OVERVIEW_CARD_CLASS &&
    !OVERVIEW_CARD_SURFACE_CLASS.includes("bg-white") &&
    !OVERVIEW_CARD_SURFACE_CLASS.includes("border-zinc-200") &&
    !OVERVIEW_CARD_SURFACE_CLASS.includes("border-dashed")
  );
}

export function overviewChromeRejectsLightLook(source: string): boolean {
  return LIGHT_OVERVIEW_TOKENS.every((token) => !source.includes(token));
}

export function overviewRejectsN8nTabs(source: string): boolean {
  return N8N_OVERVIEW_TAB_TOKENS.every((token) => !source.includes(token));
}

export function overviewRejectsDeferredIa(source: string): boolean {
  return OVERVIEW_DEFERRED_IA_TOKENS.every((token) => !source.includes(token));
}

export function overviewScanEndsAreVisible(source: string): boolean {
  return (
    source.includes("HomeActivationStatus") &&
    source.includes("HomeLastRunStatus") &&
    source.includes("FF_OVERVIEW_SCAN_LEAD_CLASS") &&
    source.includes("FF_OVERVIEW_SCAN_TRAIL_CLASS") &&
    source.includes('data-home-row-scan-cell="activation"') &&
    source.includes('data-home-row-scan-cell="lastRun"') &&
    source.includes('data-o1="published"') &&
    source.includes('data-o1="kebab"')
  );
}

export function overviewMoveIsPatchFolderIdOnly(source: string): boolean {
  return (
    source.includes("moveWorkflowToFolder") &&
    source.includes("folderIdForMove") &&
    F4_HOME_FOLDER.dragAndMenuCallSamePatch &&
    F4_HOME_FOLDER.moveDoesNotChangeYaml
  );
}

export function overviewEmbedSharesWorkflowHome(homeSource: string): boolean {
  return (
    embedOverviewUsesSharedWorkflowHome(homeSource) &&
    embedFolderUsesSharedWorkflowHome(homeSource) &&
    OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree &&
    F7_HOME_FOLDER.sameWorkflowHomeNoSecondTree
  );
}

export function overviewVisualHoldsAcceptance(homeSource: string): boolean {
  return (
    overviewCardListIsPrimary(homeSource) &&
    overviewHasSearchSortFilterRow(homeSource) &&
    overviewCardsShowPathPills(homeSource) &&
    overviewFinderRailIsCompactFilterOnly(homeSource) &&
    overviewUnfiledHasNoFakeFolder(homeSource) &&
    overviewEmptyUsesCardChrome(homeSource) &&
    overviewSkipsDeferredChrome(homeSource) &&
    overviewScanEndsAreVisible(homeSource) &&
    overviewMoveIsPatchFolderIdOnly(homeSource) &&
    overviewEmbedSharesWorkflowHome(homeSource) &&
    overviewRejectsN8nTabs(homeSource) &&
    overviewRejectsDeferredIa(homeSource) &&
    homeSource.includes("data-ff-overview") &&
    homeSource.includes("FF_OVERVIEW_VALUE") &&
    homeSource.includes("OVERVIEW_CARD_SURFACE_CLASS") &&
    homeSource.includes("FF_OVERVIEW_CREATE_CLASS") &&
    homeSource.includes("FF_OVERVIEW_RAIL_CLASS")
  );
}

export function overviewVisualHoldsHardLines(): boolean {
  return (
    OVERVIEW_VISUAL.yamlIsSourceOfTruth &&
    OVERVIEW_VISUAL.draftsNeverRun &&
    OVERVIEW_VISUAL.foldersNotInYaml &&
    OVERVIEW_VISUAL.vaultDisplayNameUuidOnly &&
    OVERVIEW_VISUAL.adv021ChromeFromSessionEmbedOnly &&
    OVERVIEW_VISUAL.adv024MembershipIsolationStayGrantGated &&
    OVERVIEW_VISUAL.isolationSuccessIsDenial &&
    OVERVIEW_VISUAL.unfiledIsVirtual &&
    OVERVIEW_VISUAL.refuseIfNonemptyDelete &&
    OVERVIEW_VISUAL.notAnN8nClone &&
    OVERVIEW_VISUAL.noN8nOrange &&
    OVERVIEW_VISUAL.noN8nOverviewTabs &&
    OVERVIEW_VISUAL.noMillerColumns &&
    OVERVIEW_VISUAL.noStats &&
    OVERVIEW_VISUAL.noPersonal &&
    OVERVIEW_VISUAL.noLinkCount &&
    OVERVIEW_VISUAL.moveStillPatchFolderIdOnly &&
    OVERVIEW_VISUAL.sameWorkflowHomeOnEmbed &&
    OVERVIEW_VISUAL.keep359Open &&
    OVERVIEW_VISUAL.inheritV1Tokens &&
    OVERVIEW_VISUAL.uiOnly &&
    OVERVIEW_VISUAL.noGreenfieldApis &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_CANVAS.toLowerCase() === "#0f1218" &&
    FF_SURFACE.toLowerCase() === "#171b22" &&
    OVERVIEW_HOME.cardsArePrimaryBrowseSurface &&
    OVERVIEW_PATH_PILLS.compactFinderRail &&
    OVERVIEW_PATH_PILLS.unfiledHasNoPathPills &&
    OVERVIEW_EMPTY.emptyHomeUsesCardChrome &&
    OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree &&
    F4_HOME_FOLDER.dragAndMenuCallSamePatch &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    overviewCardClassIsDarkTokenRow()
  );
}

export function overviewVisualInheritsPriorStories(): boolean {
  return (
    OVERVIEW_VISUAL.inheritV1Tokens &&
    OVERVIEW_VISUAL.inheritV2Shell &&
    OVERVIEW_VISUAL.inheritF1ThroughF7 &&
    OVERVIEW_VISUAL.inheritO1ThroughO4 &&
    OVERVIEW_VISUAL.inheritUxl5ScanEnds &&
    OVERVIEW_VISUAL.inheritUxl6EmptyVerbs &&
    OVERVIEW_HOME.keep325Open &&
    OVERVIEW_PATH_PILLS.keep326Open &&
    OVERVIEW_EMPTY.keep327Open &&
    OVERVIEW_EMBED.keep328Open &&
    F4_HOME_FOLDER.keep311Open &&
    F7_HOME_FOLDER.keep314Open
  );
}

export function overviewChromeRejectsForbiddenLook(source: string): boolean {
  return (
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source) &&
    overviewChromeRejectsLightLook(source) &&
    overviewRejectsN8nTabs(source) &&
    !FORBIDDEN_THEME_TREES.some((tree) => source.includes(tree)) &&
    !N8N_ORANGE_TOKENS.some((token) =>
      source.toLowerCase().includes(token.toLowerCase()),
    )
  );
}
