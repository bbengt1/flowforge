/**
 * X.1: Explorer shell (tree + content pane + breadcrumb).
 *
 * Relates to #380 / Part of #379. Keep #380 open. Keep #379 open.
 * Do not auto-close the Windows Explorer epic.
 *
 * Chloe UI only. Presentation pivot of `/workflows` (D6 in place).
 * Default home chrome is Windows Explorer-style: left folder tree
 * (disclosure + folder icons; Unfiled virtual) + right content pane
 * for the **selected folder only** (non-recursive `?folderId=`) +
 * breadcrumb from server ancestry. Overview cards are demoted from
 * the primary layout — dense content-pane rows are the default.
 * Optional view toggle waits. Full select/open polish is X.3;
 * right-click menus are X.2; empty teaching polish is X.4
 * (#383 — keep #383 open; keep #379 open); embed parity gate
 * is X.5 / #384 (keep #384 open; keep #379 open). Shared
 * `WorkflowHome` stays so embed does not fork.
 *
 * F.1–F.7 stay: server-backed nested folders, Unfiled virtual,
 * refuse-if-nonempty, move = `PATCH folderId` only, no
 * draftRevision/YAML bump, depth ≤ 4, cold-load `?folder=` (F.6 /
 * #320). No new APIs. V.1 tokens (dark charcoal + teal). Not an
 * n8n clone. Not Finder-primary. Not Miller columns.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID
 * · ADV-021/024 · folders not in YAML · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no KEK.
 */

import { OVERVIEW_EMPTY } from "./overview-empty-states.ts";
import { OVERVIEW_EMBED } from "./overview-embed.ts";
import { OVERVIEW_HOME } from "./overview-home.ts";
import { OVERVIEW_PATH_PILLS } from "./overview-path-pills.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  F2_HOME_FOLDER,
  F3_HOME_FOLDER,
  F4_HOME_FOLDER,
  F5_HOME_FOLDER,
  F6_HOME_FOLDER,
  F7_HOME_FOLDER,
  F320_KEEP_OPEN,
  UNFILED_FOLDER_ID,
  UNFILED_FOLDER_LABEL,
  breadcrumbSegments,
  type FolderSelection,
  type WorkflowFolder,
} from "./workflow-folder.ts";

export const X1_STORY = 380;
export const X1_EPIC = 379;
export const X1_KEEP_STORY_OPEN = true;
export const X1_KEEP_EPIC_OPEN = true;
export const X1_ID = "X.1-explorer-shell" as const;
export const X1_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const EXPLORER_HEADING = "Explorer";
export const EXPLORER_HELP =
  "Windows Explorer-style home: folder tree, selected-folder content pane, and ancestry breadcrumb. Unfiled is virtual. The selected list is this folder only — not descendants. Single-click selects a row; double-click or Enter opens a workflow in the editor or navigates into a folder. Drafts do not run — publish, then start a published version.";
export const EXPLORER_TREE_LABEL = "Folder tree";
export const EXPLORER_PANE_LABEL = "Folder contents";
export const EXPLORER_CRUMB_LABEL = "Folder path";

export const FF_EXPLORER_SHELL_CLASS = "ff-explorer-shell";
export const FF_EXPLORER_LAYOUT_CLASS = "ff-explorer-layout";
export const FF_EXPLORER_TREE_CLASS = "ff-explorer-tree";
export const FF_EXPLORER_PANE_CLASS = "ff-explorer-pane";
export const FF_EXPLORER_CRUMB_CLASS = "ff-explorer-crumb";
export const FF_EXPLORER_ROW_CLASS = "ff-explorer-row";
export const FF_EXPLORER_LIST_CLASS = "ff-explorer-list";

export const EXPLORER_SHELL = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritF2RailSelect: true,
  inheritF3OrganizeVerbs: true,
  inheritF4Move: true,
  inheritF5EmptyVerbs: true,
  inheritF6Search: true,
  inheritF6ColdLoadFolder: true,
  inheritF7EmbedFolderParity: true,
  inheritO1CardFields: true,
  inheritO2PathPills: true,
  inheritO3EmptyCardChrome: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  explorerIsDefaultHome: true,
  treePlusContentPlusBreadcrumb: true,
  leftFolderTreeDisclosureAndIcons: true,
  unfiledIsVirtual: true,
  unfiledBreadcrumbIsVirtual: true,
  contentPaneSelectedFolderOnly: true,
  nonRecursiveFolderIdStays: true,
  breadcrumbFromAncestry: true,
  cardsDemotedFromPrimary: true,
  denseListRowsOk: true,
  noViewToggleThisStory: true,
  noRightClickMenusThisStory: true,
  noMillerColumns: true,
  noTagsFirst: true,
  noFavorites: true,
  notFinderPrimary: true,
  notAnN8nClone: true,
  usesExistingApisOnly: true,
  noJonnyChange: true,
  noNewApi: true,
  identityProxyAllowlistUnchanged: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  refuseIfNonemptyDelete: true,
  moveStillPatchFolderIdOnly: true,
  noDraftRevisionBumpOnMove: true,
  noKekInBrowser: true,
  keep380Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
} as const;

export const EXPLORER_SHELL_SOURCES = [
  "src/lib/explorer-shell.ts",
  "src/lib/workflow-folder.ts",
  "src/lib/overview-home.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
  "src/app/globals.css",
] as const;

export const EXPLORER_MILLER_TOKENS = [
  "miller column",
  "Miller columns",
  "data-miller",
  'data-x1="miller"',
] as const;

export const EXPLORER_RECURSIVE_TOKENS = [
  "includeDescendants",
  "recursiveFolder",
  "treeWalk",
] as const;

export const EXPLORER_AUTO_CLOSE_TOKENS = [
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
  "Fixes #380",
  "Closes #380",
] as const;

export function explorerBreadcrumbSegments(
  folders: readonly WorkflowFolder[],
  selection: FolderSelection,
): Array<{ selection: FolderSelection; label: string }> {
  return breadcrumbSegments(folders, selection);
}

export function explorerUnfiledBreadcrumbInventedId(
  crumbs: readonly { selection: FolderSelection; label: string }[],
): boolean {
  return crumbs.some(
    (crumb) =>
      crumb.selection.kind === "unfiled" &&
      "id" in crumb.selection &&
      crumb.selection.id === UNFILED_FOLDER_ID,
  );
}

export function explorerShellIsPrimary(source: string): boolean {
  return (
    source.includes('data-x1="explorer-shell"') &&
    source.includes('data-x1="folder-tree"') &&
    source.includes('data-x1="content-pane"') &&
    source.includes('data-x1="breadcrumb"') &&
    source.includes("FF_EXPLORER_SHELL_CLASS") &&
    source.includes("FF_EXPLORER_LAYOUT_CLASS") &&
    source.includes("FF_EXPLORER_TREE_CLASS") &&
    source.includes("FF_EXPLORER_PANE_CLASS") &&
    !source.includes('setView("list")') &&
    !source.includes('data-home-view')
  );
}

export function explorerTreeHasDisclosureAndUnfiled(source: string): boolean {
  return (
    source.includes('data-x1="folder-tree"') &&
    source.includes('data-o2="disclosure"') &&
    source.includes('data-o2="folder-icon"') &&
    source.includes('data-home-folder-rail="unfiled"') &&
    source.includes("UNFILED_FOLDER_LABEL") &&
    source.includes("FinderDisclosureIcon") &&
    source.includes("FinderFolderIcon")
  );
}

export function explorerContentIsSelectedFolderOnly(source: string): boolean {
  return (
    source.includes('data-x1="content-pane"') &&
    source.includes("selectedFolderListFolderId") &&
    source.includes("folderHomeListMode") &&
    source.includes("constrainItemsToFolderSelection") &&
    source.includes("intendedFolderSelectionFromUrl") &&
    EXPLORER_RECURSIVE_TOKENS.every((token) => !source.includes(token))
  );
}

export function explorerBreadcrumbFromAncestry(source: string): boolean {
  return (
    source.includes('data-x1="breadcrumb"') &&
    source.includes("data-home-folder-crumb") &&
    source.includes("breadcrumbSegments") &&
    source.includes("UNFILED_FOLDER_LABEL")
  );
}

export function explorerUnfiledIsVirtual(source: string): boolean {
  const unfiled = source.match(
    /data-home-folder-rail="unfiled"[\s\S]*?<\/button>/,
  );
  if (!unfiled) {
    return false;
  }
  return (
    !unfiled[0].includes("data-folder-id") &&
    !unfiled[0].includes("UNFILED_FOLDER_ID") &&
    unfiled[0].includes("UNFILED_FOLDER_LABEL")
  );
}

export function explorerCardsDemoted(source: string): boolean {
  return (
    explorerShellIsPrimary(source) &&
    source.includes("FF_EXPLORER_ROW_CLASS") &&
    source.includes("FF_EXPLORER_LIST_CLASS") &&
    source.includes('data-x1="content-list"')
  );
}

export function explorerLayoutDoesNotClipOverlays(globals: string): boolean {
  const layout = globals.match(/\.ff-explorer-layout\s*\{[^}]*\}/);
  const pane = globals.match(/\.ff-explorer-pane\s*\{[^}]*\}/);
  if (!layout || !pane) {
    return false;
  }
  return (
    !/overflow:\s*hidden/.test(layout[0]) &&
    !/overflow:\s*hidden/.test(pane[0]) &&
    /overflow:\s*visible/.test(layout[0]) &&
    /overflow:\s*visible/.test(pane[0])
  );
}

export function explorerSkipsDeferredChrome(source: string): boolean {
  return (
    EXPLORER_MILLER_TOKENS.every((token) => !source.includes(token)) &&
    !source.includes('data-x1="favorites"') &&
    !source.includes('data-x1="tags-first"') &&
    !source.includes("data-o1=\"stats\"") &&
    !source.includes("data-o1=\"personal\"")
  );
}

export function explorerOrganizeVerbsStayReachable(source: string): boolean {
  const organizeVerbsOnMenu =
    source.includes("explorerMenuFolderVerb") &&
    source.includes("data-home-folder-verb={explorerMenuFolderVerb");
  const organizeVerbsLiteral =
    source.includes('data-home-folder-verb="new"') &&
    source.includes('data-home-folder-verb="rename"') &&
    source.includes('data-home-folder-verb="delete"');
  return (
    source.includes('data-x2="context-menu"') &&
    source.includes("openCreateFolder") &&
    source.includes("openRenameFolder") &&
    source.includes("removeFolder") &&
    (organizeVerbsOnMenu || organizeVerbsLiteral) &&
    source.includes('data-home-workflow-verb="move"') &&
    source.includes("moveWorkflowToFolder") &&
    source.includes("folderIdForMove")
  );
}

export function explorerDocsKeepEpicOpen(docs: string): boolean {
  return (
    docs.includes("X.1") &&
    EXPLORER_AUTO_CLOSE_TOKENS.every((token) => !docs.includes(token))
  );
}

export function explorerHoldsHardLines(): boolean {
  return (
    EXPLORER_SHELL.yamlIsSourceOfTruth &&
    EXPLORER_SHELL.foldersNotInYaml &&
    EXPLORER_SHELL.draftsNeverRun &&
    EXPLORER_SHELL.vaultDisplayNameUuidOnly &&
    EXPLORER_SHELL.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_SHELL.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_SHELL.isolationSuccessIsDenial &&
    EXPLORER_SHELL.unfiledIsVirtual &&
    EXPLORER_SHELL.refuseIfNonemptyDelete &&
    EXPLORER_SHELL.moveStillPatchFolderIdOnly &&
    EXPLORER_SHELL.noDraftRevisionBumpOnMove &&
    EXPLORER_SHELL.notAnN8nClone &&
    EXPLORER_SHELL.noKekInBrowser &&
    EXPLORER_SHELL.noJonnyChange &&
    EXPLORER_SHELL.keep380Open &&
    EXPLORER_SHELL.keep379Open &&
    EXPLORER_SHELL.noAutoCloseEpic &&
    F2_HOME_FOLDER.keep309Open &&
    F6_HOME_FOLDER.folderIdIsNotATreeWalk &&
    F320_KEEP_OPEN &&
    UNFILED_FOLDER_LABEL === "Unfiled"
  );
}

export function explorerInheritsFolderStories(): boolean {
  return (
    EXPLORER_SHELL.inheritF1ThroughF7 &&
    EXPLORER_SHELL.inheritF2RailSelect &&
    EXPLORER_SHELL.inheritF3OrganizeVerbs &&
    EXPLORER_SHELL.inheritF4Move &&
    EXPLORER_SHELL.inheritF5EmptyVerbs &&
    EXPLORER_SHELL.inheritF6Search &&
    EXPLORER_SHELL.inheritF6ColdLoadFolder &&
    EXPLORER_SHELL.inheritF7EmbedFolderParity &&
    EXPLORER_SHELL.nonRecursiveFolderIdStays &&
    EXPLORER_SHELL.d6MigrateInPlace &&
    F2_HOME_FOLDER.keep309Open &&
    F3_HOME_FOLDER.keep310Open &&
    F4_HOME_FOLDER.keep311Open &&
    F5_HOME_FOLDER.keep312Open &&
    F6_HOME_FOLDER.keep313Open &&
    F7_HOME_FOLDER.keep314Open &&
    OVERVIEW_HOME.keep325Open &&
    OVERVIEW_PATH_PILLS.keep326Open &&
    OVERVIEW_EMPTY.keep327Open &&
    OVERVIEW_EMBED.keep328Open
  );
}
