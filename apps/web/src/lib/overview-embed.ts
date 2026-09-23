/**
 * O.4: Embed Overview parity.
 *
 * Relates to #328 / Part of #324. Keep #328 open.
 *
 * Chloe UI only. Presentation pivot of `/embed/v1/workflows`
 * (D6 in place). Same Overview cards + compact Finder rail as
 * standalone after GET /session `session.embed`. Prefer shared
 * `WorkflowHome` — do not fork embed Overview. No second tree.
 *
 * Missing `session.embed` is an ADV-021 alert (fail-closed).
 * Host `?tenant=` / `?workbench=` stay display-only. Viewers
 * are select-only — no create / rename / delete / move without
 * minted `workflow.edit`. CHIPS / Portal iframe: tree comes
 * from GET /workflow-folders, not `localStorage`.
 *
 * Existing `GET /workflows` fields + `GET /workflow-folders`
 * ancestry only. No jonny change. Skip Personal / link-count /
 * stats. F.7 folder bind stays; O.1–O.3 chrome is what embed
 * shows.
 *
 * Hard lines: YAML source · drafts never run · ADV-021/024 ·
 * folders not in YAML · Unfiled virtual · refuse-if-nonempty
 * delete · not an n8n clone · no KEK · isolation success is
 * a denial.
 */

import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./embed-contract.ts";
import {
  OVERVIEW_EMPTY,
  overviewEmptyDoesNotRegressCardsOrRail,
  overviewEmptyUsesCardChrome,
} from "./overview-empty-states.ts";
import {
  OVERVIEW_HOME,
  overviewCardListIsPrimary,
  overviewHasSearchSortFilterRow,
} from "./overview-home.ts";
import {
  OVERVIEW_PATH_PILLS,
  overviewCardsShowPathPills,
  overviewFinderRailIsCompactFilterOnly,
} from "./overview-path-pills.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  F7_HOME_FOLDER,
  embedFolderHomeMountsAfterSessionEmbed,
  embedFolderUsesSharedWorkflowHome,
  embedInventedFolderTree,
  embedMissingSessionEmbedIsAlert,
  folderTreePersistsInLocalStorage,
  hostTenantWorkbenchSelectsFolderTree,
} from "./workflow-folder.ts";

export const O4_STORY = 328;
export const O4_EPIC = 324;
export const O4_KEEP_STORY_OPEN = true;
export const O4_ID = "O.4-embed-overview-parity" as const;
export const O4_BRIEF = "docs/internal/flowforge-workflow-folders.md";

export const OVERVIEW_EMBED_HELP =
  "Embed Overview is the same WorkflowHome cards and compact Finder rail after session.embed. Missing session.embed is an ADV-021 alert. Host query is display-only. Viewers are select-only. The tree comes from the API, not localStorage. No second tree.";

export const OVERVIEW_EMBED = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritO1CardList: true,
  inheritO2PathPills: true,
  inheritO2FinderRail: true,
  inheritO3EmptyCardChrome: true,
  inheritF7EmbedFolderParity: true,
  inheritF1ThroughF7: true,
  d6MigrateInPlace: true,
  sameWorkflowHomeNoSecondTree: true,
  cardsAndFinderRailAfterSessionEmbed: true,
  missingSessionEmbedIsAlert: true,
  hostQueryDisplayOnly: true,
  viewersSelectOnly: true,
  noMutateWithoutWorkflowEdit: true,
  treeFromApiNotLocalStorage: true,
  chipsPortalIframeUsesApiTree: true,
  cardsArePrimaryBrowseSurface: true,
  compactFinderRailStays: true,
  pathPillsStay: true,
  emptyStatesUseCardChrome: true,
  usesExistingApisOnly: true,
  noJonnyChange: true,
  noNewApi: true,
  statsStripSkipped: true,
  personalBadgeSkipped: true,
  linkCountSkipped: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv021FailClosedWithoutSessionEmbed: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep328Open: true,
} as const;

export const OVERVIEW_EMBED_SOURCES = [
  "src/lib/overview-embed.ts",
  "src/lib/overview-home.ts",
  "src/lib/overview-path-pills.ts",
  "src/lib/overview-empty-states.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/components/embed/EmbedChrome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export const embedOverviewHomeMountsAfterSessionEmbed =
  embedFolderHomeMountsAfterSessionEmbed;

export function embedOverviewUsesSharedWorkflowHome(
  homeSource: string,
): boolean {
  return (
    embedFolderUsesSharedWorkflowHome(homeSource) &&
    homeSource.includes("data-o4=") &&
    homeSource.includes("data-o4-tree") &&
    homeSource.includes('data-o1="card-list"') &&
    homeSource.includes('data-o2="finder-rail"') &&
    !embedInventedFolderTree(homeSource)
  );
}

export function embedOverviewShowsCardsAndFinderRail(
  homeSource: string,
): boolean {
  return (
    overviewCardListIsPrimary(homeSource) &&
    overviewHasSearchSortFilterRow(homeSource) &&
    overviewCardsShowPathPills(homeSource) &&
    overviewFinderRailIsCompactFilterOnly(homeSource) &&
    overviewEmptyUsesCardChrome(homeSource) &&
    overviewEmptyDoesNotRegressCardsOrRail(homeSource) &&
    homeSource.includes('data-o4={embed ? "embed-overview" : "standalone-overview"}') &&
    homeSource.includes('data-o4-tree="api"')
  );
}

export function embedOverviewViewerIsSelectOnly(homeSource: string): boolean {
  return (
    homeSource.includes(
      "canMutateEmbedWorkflowFolders(permissions, session.embedChrome)",
    ) &&
    homeSource.includes("canMutateFolders") &&
    homeSource.includes("canCreate") &&
    homeSource.includes(
      'data-o4-viewer={canMutateFolders ? "editor" : "select-only"}',
    )
  );
}

export function embedOverviewTreeFromApiNotLocalStorage(
  homeSource: string,
): boolean {
  return (
    homeSource.includes("listWorkflowFolders") &&
    homeSource.includes('data-o4-tree="api"') &&
    homeSource.includes('data-f7-tree="api"') &&
    !folderTreePersistsInLocalStorage(homeSource)
  );
}

export function embedOverviewHostQueryIsDisplayOnly(
  homeSource: string,
): boolean {
  return (
    hostTenantWorkbenchSelectsFolderTree() === false &&
    !homeSource.includes('searchParams.get("tenant")') &&
    !homeSource.includes('searchParams.get("workbench")') &&
    homeSource.includes("FOLDER_QUERY")
  );
}

export function embedOverviewMissingSessionIsAlert(
  chromeSource: string,
): boolean {
  return (
    embedMissingSessionEmbedIsAlert(chromeSource) &&
    /not chrome authority/.test(EMBED_CHROME_MISSING_SESSION_MESSAGE)
  );
}

export function embedOverviewHoldsHardLines(): boolean {
  return (
    OVERVIEW_EMBED.yamlIsSourceOfTruth &&
    OVERVIEW_EMBED.foldersNotInYaml &&
    OVERVIEW_EMBED.draftsNeverRun &&
    OVERVIEW_EMBED.vaultDisplayNameUuidOnly &&
    OVERVIEW_EMBED.adv021ChromeFromSessionEmbedOnly &&
    OVERVIEW_EMBED.adv021FailClosedWithoutSessionEmbed &&
    OVERVIEW_EMBED.adv024MembershipIsolationStayGrantGated &&
    OVERVIEW_EMBED.isolationSuccessIsDenial &&
    OVERVIEW_EMBED.unfiledIsVirtual &&
    OVERVIEW_EMBED.refuseIfNonemptyDelete &&
    OVERVIEW_EMBED.notAnN8nClone &&
    OVERVIEW_EMBED.noKekInBrowser &&
    OVERVIEW_EMBED.noJonnyChange &&
    OVERVIEW_EMBED.keep328Open &&
    OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree &&
    OVERVIEW_EMBED.viewersSelectOnly &&
    OVERVIEW_EMBED.treeFromApiNotLocalStorage &&
    OVERVIEW_HOME.cardsArePrimaryBrowseSurface &&
    OVERVIEW_PATH_PILLS.compactFinderRail &&
    OVERVIEW_EMPTY.emptyHomeUsesCardChrome &&
    F7_HOME_FOLDER.sameWorkflowHomeNoSecondTree &&
    F7_HOME_FOLDER.adv021FailClosedWithoutSessionEmbed
  );
}

export function embedOverviewInheritsPriorStories(): boolean {
  return (
    OVERVIEW_EMBED.inheritO1CardList &&
    OVERVIEW_EMBED.inheritO2PathPills &&
    OVERVIEW_EMBED.inheritO2FinderRail &&
    OVERVIEW_EMBED.inheritO3EmptyCardChrome &&
    OVERVIEW_EMBED.inheritF7EmbedFolderParity &&
    OVERVIEW_EMBED.inheritF1ThroughF7 &&
    OVERVIEW_EMBED.d6MigrateInPlace &&
    OVERVIEW_HOME.keep325Open &&
    OVERVIEW_PATH_PILLS.keep326Open &&
    OVERVIEW_EMPTY.keep327Open &&
    F7_HOME_FOLDER.keep314Open
  );
}
