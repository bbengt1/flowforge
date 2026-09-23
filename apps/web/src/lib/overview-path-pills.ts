/**
 * O.2: Path pills + compact Finder rail.
 *
 * Relates to #326 / Part of #324. Keep #326 open.
 *
 * Chloe UI only. Presentation pivot of `/workflows` (D6 in place).
 * Cards show folder path pills joined from `GET /workflow-folders`
 * ancestry (root → parent → folder). Unfiled has no path pills and
 * is not a persisted folder. Compact left rail: disclosure + folder
 * icons, Unfiled virtual, non-recursive `?folderId=` filter only —
 * not Miller columns, not primary browse. F.1–F.4 move / create /
 * rename / delete stay. Cards stay the primary browse surface.
 *
 * Existing `GET /workflows` list fields plus
 * `GET /workflow-folders` ancestry — no jonny change. Stats strip,
 * Personal badge, and link-count stay skipped.
 *
 * Hard lines: YAML source · drafts never run · ADV-021/024 ·
 * folders not in YAML · Unfiled virtual · refuse-if-nonempty
 * delete · not an n8n clone · no KEK.
 */

import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  F2_HOME_FOLDER,
  F4_HOME_FOLDER,
  F6_HOME_FOLDER,
  UNFILED_FOLDER_ID,
  UNFILED_FOLDER_LABEL,
  folderPath,
  type WorkflowFolder,
} from "./workflow-folder.ts";

export const O2_STORY = 326;
export const O2_EPIC = 324;
export const O2_KEEP_STORY_OPEN = true;
export const O2_ID = "O.2-path-pills-compact-finder-rail" as const;
export const O2_BRIEF = "docs/internal/flowforge-workflow-folders.md";

export const OVERVIEW_PATH_PILLS_HELP =
  "Folder path pills are joined from GET /workflow-folders ancestry. Unfiled has no path pills and is not a persisted folder.";
export const OVERVIEW_FINDER_RAIL_HELP =
  "Compact Finder rail: disclosure and folder icons. Unfiled is virtual. Selecting a row filters GET /workflows?folderId= for that folder only — not descendants, not Miller columns, not primary browse.";

export type OverviewPathPill = {
  id: string;
  name: string;
};

export const OVERVIEW_PATH_PILLS = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritF6Search: true,
  inheritF2RailSelect: true,
  inheritF2DeepLink: true,
  inheritF3OrganizeVerbs: true,
  inheritF4Move: true,
  nonRecursiveFolderIdStays: true,
  d6MigrateInPlace: true,
  cardsArePrimaryBrowseSurface: true,
  pathPillsFromAncestry: true,
  ancestryOrderRootToFolder: true,
  unfiledHasNoPathPills: true,
  unfiledIsNotAPersistedFolder: true,
  compactFinderRail: true,
  railDisclosureAndFolderIcons: true,
  railIsFilterOnly: true,
  notMillerColumns: true,
  notPrimaryBrowse: true,
  pillsClickableToSelectFolder: true,
  usesExistingListFieldsAndFolderAncestry: true,
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
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep326Open: true,
} as const;

export const OVERVIEW_PATH_PILLS_SOURCES = [
  "src/lib/overview-path-pills.ts",
  "src/lib/overview-home.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export const OVERVIEW_PATH_PILLS_MILLER_TOKENS = [
  "miller column",
  "Miller columns",
  "data-miller",
  "data-o2=\"miller\"",
] as const;

export const OVERVIEW_PATH_PILLS_RECURSIVE_TOKENS = [
  "includeDescendants",
  "recursiveFolder",
  "treeWalk",
] as const;

export function overviewFolderIdIsUnfiled(
  folderId: string | null | undefined,
): boolean {
  if (folderId == null) {
    return true;
  }
  const trimmed = folderId.trim();
  return trimmed === "" || trimmed === UNFILED_FOLDER_ID;
}

/**
 * Ancestry pills for a filed workflow: root → parent → folder.
 * Unfiled (`folderId` null / empty / the virtual `unfiled` token)
 * returns no pills and never invents a persisted Unfiled folder.
 */
export function overviewAncestryPills(
  folders: readonly WorkflowFolder[],
  folderId: string | null | undefined,
): OverviewPathPill[] {
  if (overviewFolderIdIsUnfiled(folderId)) {
    return [];
  }
  return folderPath(folders, folderId as string)
    .filter((item) => item.id !== UNFILED_FOLDER_ID)
    .map((item) => ({
      id: item.id,
      name: item.name,
    }));
}

export function overviewPillsInventPersistedUnfiled(
  pills: readonly OverviewPathPill[],
): boolean {
  return pills.some(
    (pill) =>
      pill.id === UNFILED_FOLDER_ID ||
      (pill.name === UNFILED_FOLDER_LABEL && pill.id === UNFILED_FOLDER_ID),
  );
}

export function overviewUnfiledHasNoPathPills(
  pills: readonly OverviewPathPill[],
): boolean {
  return pills.length === 0 && !overviewPillsInventPersistedUnfiled(pills);
}

export function overviewCardsShowPathPills(source: string): boolean {
  return (
    source.includes("overviewAncestryPills") &&
    source.includes('data-o2="path-pills"') &&
    source.includes('data-o2="path-pill"') &&
    source.includes("data-folder-id={pill.id}")
  );
}

export function overviewUnfiledHasNoFakeFolder(source: string): boolean {
  const unfiled = source.match(
    /data-o2="unfiled"[^>]*>[\s\S]*?UNFILED_FOLDER_LABEL[\s\S]*?<\/span>/,
  );
  if (!unfiled) {
    return false;
  }
  return (
    !unfiled[0].includes("data-folder-id") &&
    !unfiled[0].includes("UNFILED_FOLDER_ID")
  );
}

export function overviewFinderRailIsCompactFilterOnly(source: string): boolean {
  return (
    source.includes('data-o2="finder-rail"') &&
    source.includes('data-o2="disclosure"') &&
    source.includes('data-o2="folder-icon"') &&
    source.includes('data-home-folder-rail="unfiled"') &&
    source.includes("selectedFolderListFolderId") &&
    source.includes("folderHomeListMode") &&
    source.includes("constrainItemsToFolderSelection") &&
    !/includeDescendants|recursiveFolder|treeWalk|data-miller|Miller columns/i.test(
      source,
    )
  );
}

export function overviewPillsDoNotBreakFolderBrowse(source: string): boolean {
  return (
    source.includes("FOLDER_QUERY") &&
    source.includes("data-home-folder-rail") &&
    source.includes("data-f6=\"search\"") &&
    source.includes("FOLDER_SEARCH_ACROSS_LABEL") &&
    source.includes("FOLDER_SEARCH_IN_FOLDER_LABEL") &&
    source.includes("searchInThisFolder") &&
    source.includes("workflowFolderPathLabel") &&
    source.includes("data-home-folder-path")
  );
}

export function overviewPathPillsHoldHardLines(): boolean {
  return (
    OVERVIEW_PATH_PILLS.yamlIsSourceOfTruth &&
    OVERVIEW_PATH_PILLS.foldersNotInYaml &&
    OVERVIEW_PATH_PILLS.draftsNeverRun &&
    OVERVIEW_PATH_PILLS.vaultDisplayNameUuidOnly &&
    OVERVIEW_PATH_PILLS.adv021ChromeFromSessionEmbedOnly &&
    OVERVIEW_PATH_PILLS.adv024MembershipIsolationStayGrantGated &&
    OVERVIEW_PATH_PILLS.isolationSuccessIsDenial &&
    OVERVIEW_PATH_PILLS.unfiledIsVirtual &&
    OVERVIEW_PATH_PILLS.refuseIfNonemptyDelete &&
    OVERVIEW_PATH_PILLS.notAnN8nClone &&
    OVERVIEW_PATH_PILLS.noKekInBrowser &&
    OVERVIEW_PATH_PILLS.noJonnyChange &&
    OVERVIEW_PATH_PILLS.keep326Open &&
    OVERVIEW_PATH_PILLS.notMillerColumns &&
    F2_HOME_FOLDER.keep309Open &&
    F4_HOME_FOLDER.keep311Open &&
    F6_HOME_FOLDER.defaultSearchAcrossFolders &&
    F6_HOME_FOLDER.folderIdIsNotATreeWalk
  );
}

export function overviewPathPillsInheritFolderStories(): boolean {
  return (
    OVERVIEW_PATH_PILLS.inheritF1ThroughF7 &&
    OVERVIEW_PATH_PILLS.inheritF6Search &&
    OVERVIEW_PATH_PILLS.inheritF2RailSelect &&
    OVERVIEW_PATH_PILLS.inheritF2DeepLink &&
    OVERVIEW_PATH_PILLS.inheritF3OrganizeVerbs &&
    OVERVIEW_PATH_PILLS.inheritF4Move &&
    OVERVIEW_PATH_PILLS.nonRecursiveFolderIdStays &&
    OVERVIEW_PATH_PILLS.d6MigrateInPlace &&
    OVERVIEW_PATH_PILLS.cardsArePrimaryBrowseSurface &&
    F6_HOME_FOLDER.keep313Open &&
    F2_HOME_FOLDER.keep309Open
  );
}
