/**
 * X.4: Empty / Unfiled teaching states on Explorer chrome.
 *
 * Relates to #383 / Part of #379. Keep #383 open. Keep #379 open.
 * Do not auto-close the Windows Explorer epic.
 *
 * Chloe UI only. Presentation polish of empty home / empty folder /
 * Unfiled-empty on the X.1 tree + content pane. Carry F.5 / O.3
 * teaching (Create / Import YAML / reviewed template / New folder;
 * create here / move / delete; drafts do not run) into Explorer
 * chrome — not a second Overview-card empty surface. Empty folder
 * and empty Unfiled differ: a real folder teaches create/move (and
 * refuse-if-nonempty delete); Unfiled stays virtual and never looks
 * deletable or renamable. Drafts-do-not-run chrome stays loud on
 * empty/home create surfaces. X.2 empty-pane context menu (New
 * folder / Create workflow / Import) stays on the pane surface.
 *
 * Shared `WorkflowHome` stays so embed does not fork. Full embed
 * parity is X.5. No new APIs. V.1 tokens only.
 *
 * F.1–F.7 stay: Unfiled virtual, non-recursive `?folderId=`,
 * refuse-if-nonempty, move = `PATCH folderId` only. X.2 / X.3 stay.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID
 * · ADV-021/024 · folders not in YAML · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no KEK.
 */

import { LOUD_WARNING_CLASS } from "./aesthetic-usability-density.ts";
import { EMPTY_STATE_DEVELOPER_FIXTURE_TOKENS } from "./empty-states-teach-model.ts";
import {
  EXPLORER_CONTEXT_MENU,
  X2_EPIC,
  X2_KEEP_EPIC_OPEN,
} from "./explorer-context-menu.ts";
import {
  EXPLORER_SELECT_OPEN,
  X3_EPIC,
  X3_KEEP_EPIC_OPEN,
} from "./explorer-select-open.ts";
import {
  EXPLORER_SHELL,
  X1_EPIC,
  X1_KEEP_EPIC_OPEN,
} from "./explorer-shell.ts";
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
  FOLDER_EMPTY_CREATE_LABEL,
  FOLDER_EMPTY_HELP,
  FOLDER_EMPTY_MOVE_LABEL,
  FOLDER_UNFILED_LOCKED_HELP,
  UNFILED_EMPTY_NONE_HELP,
  UNFILED_FOLDER_LABEL,
  emptyFolderDeleteAllowed,
  type FolderHomeEmptyKind,
} from "./workflow-folder.ts";

export const X4_STORY = 383;
export const X4_EPIC = 379;
export const X4_KEEP_STORY_OPEN = true;
export const X4_KEEP_EPIC_OPEN = true;
export const X4_ID = "X.4-explorer-empty-unfiled-teaching" as const;
export const X4_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const EXPLORER_EMPTY_HELP =
  "Empty folder and empty Unfiled teach different Explorer moves. A real folder can take a new draft or a moved workflow; delete stays refuse-if-nonempty. Unfiled is virtual — not a folder you can rename or delete. Drafts do not run — publish, then start a published version.";
export const EXPLORER_DRAFTS_DO_NOT_RUN =
  "Drafts do not run — publish, then start a published version.";
export const EXPLORER_UNFILED_VIRTUAL_LABEL = "Virtual — not a folder";
export const EXPLORER_FOLDER_TEACH =
  "This is a real folder. Create a draft here or move an existing workflow in. Delete is available only when the folder has no workflows and no child folders.";
export const EXPLORER_UNFILED_TEACH =
  "Unfiled is a virtual bag, not a folder. Create a draft here, or select a folder in the tree. You cannot rename or delete Unfiled.";
export const EXPLORER_UNFILED_FILED_TEACH =
  "Unfiled is empty because workflows in this workspace are already in the folder tree. Select a folder at left. Unfiled cannot be renamed or deleted.";
export const EXPLORER_EMPTY_PANE_HINT =
  "Right-click this pane for New folder, Create, or Import YAML.";

export const FF_EXPLORER_EMPTY_CLASS = "ff-explorer-empty";
export const FF_EXPLORER_EMPTY_FOLDER_CLASS = "ff-explorer-empty-folder";
export const FF_EXPLORER_EMPTY_UNFILED_CLASS = "ff-explorer-empty-unfiled";
export const FF_EXPLORER_VIRTUAL_CHIP_CLASS = "ff-explorer-virtual-chip";
export const FF_EXPLORER_DRAFTS_BANNER_CLASS = `ff-explorer-drafts-banner ${LOUD_WARNING_CLASS}`;

export const EXPLORER_EMPTY = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritF5EmptyVerbs: true,
  inheritO3Teaching: true,
  inheritX1ExplorerShell: true,
  inheritX2ContextMenus: true,
  inheritX3SelectOpen: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  emptyStatesOnExplorerChrome: true,
  emptyFolderDiffersFromEmptyUnfiled: true,
  emptyFolderTeachesCreateMove: true,
  unfiledStaysVirtual: true,
  unfiledNeverLooksDeletableOrRenamable: true,
  draftsDoNotRunStaysLoud: true,
  emptyPaneKeepsX2ContextMenu: true,
  noNewApi: true,
  noJonnyChange: true,
  usesExistingApisOnly: true,
  identityProxyAllowlistUnchanged: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  moveStillPatchFolderIdOnly: true,
  noDraftRevisionBumpOnMove: true,
  nonRecursiveFolderIdStays: true,
  noMillerColumns: true,
  noTagsFirst: true,
  noFavorites: true,
  notFinderPrimary: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  noDeveloperFixtures: true,
  keep383Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
} as const;

export const EXPLORER_EMPTY_SOURCES = [
  "src/lib/explorer-empty-states.ts",
  "src/lib/explorer-select-open.ts",
  "src/lib/explorer-context-menu.ts",
  "src/lib/explorer-shell.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
  "src/app/globals.css",
] as const;

export const EXPLORER_EMPTY_AUTO_CLOSE_TOKENS = [
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
  "Fixes #383",
  "Closes #383",
] as const;

export type ExplorerEmptyKind =
  | "home"
  | "folder"
  | "unfiled-none"
  | "unfiled-filed"
  | "filtered";

export function explorerEmptyKindFromFolderHome(
  kind: FolderHomeEmptyKind,
  unfiledUsesHomeVerbs: boolean,
): ExplorerEmptyKind | null {
  if (kind === "populated") {
    return null;
  }
  if (kind === "teach") {
    return "home";
  }
  if (kind === "folder") {
    return "folder";
  }
  if (kind === "filtered") {
    return "filtered";
  }
  return unfiledUsesHomeVerbs ? "unfiled-none" : "unfiled-filed";
}

export function explorerEmptyShowsDraftsBanner(
  kind: ExplorerEmptyKind,
): boolean {
  return kind === "home" || kind === "folder" || kind === "unfiled-none";
}

export function explorerEmptyIsVirtualUnfiled(
  kind: ExplorerEmptyKind,
): boolean {
  return kind === "unfiled-none" || kind === "unfiled-filed";
}

export function explorerEmptyShowsFolderDelete(
  kind: ExplorerEmptyKind,
): boolean {
  return kind === "folder";
}

export function explorerEmptyTeachesCreateMove(
  kind: ExplorerEmptyKind,
): boolean {
  return kind === "home" || kind === "folder" || kind === "unfiled-none";
}

export function explorerEmptyTeachCopy(kind: ExplorerEmptyKind): string {
  if (kind === "folder") {
    return EXPLORER_FOLDER_TEACH;
  }
  if (kind === "unfiled-filed") {
    return EXPLORER_UNFILED_FILED_TEACH;
  }
  if (kind === "unfiled-none") {
    return EXPLORER_UNFILED_TEACH;
  }
  return EXPLORER_EMPTY_HELP;
}

export function explorerEmptyUsesExplorerChrome(source: string): boolean {
  return (
    source.includes('data-x4="pane-surface"') &&
    source.includes('data-x4="empty-home"') &&
    source.includes('data-x4="empty-folder"') &&
    source.includes('data-x4="empty-unfiled"') &&
    source.includes("FF_EXPLORER_EMPTY_CLASS") &&
    source.includes("FF_EXPLORER_EMPTY_FOLDER_CLASS") &&
    source.includes("FF_EXPLORER_EMPTY_UNFILED_CLASS") &&
    source.includes("EXPLORER_FOLDER_TEACH") &&
    source.includes("EXPLORER_UNFILED_TEACH")
  );
}

export function explorerEmptyDifferentiatesFolderAndUnfiled(
  source: string,
): boolean {
  return (
    source.includes('data-x4="empty-folder"') &&
    source.includes('data-x4="empty-unfiled"') &&
    source.includes("EXPLORER_FOLDER_TEACH") &&
    source.includes("EXPLORER_UNFILED_TEACH") &&
    source.includes("EXPLORER_UNFILED_VIRTUAL_LABEL") &&
    source.includes("FOLDER_UNFILED_LOCKED_HELP") &&
    source.includes("FOLDER_EMPTY_CREATE_LABEL") &&
    source.includes("FOLDER_EMPTY_MOVE_LABEL") &&
    source.includes('data-home-folder-empty-verb="delete"') &&
    explorerEmptyShowsFolderDelete("folder") &&
    !explorerEmptyShowsFolderDelete("unfiled-none") &&
    !explorerEmptyShowsFolderDelete("unfiled-filed") &&
    /cannot rename or delete/i.test(EXPLORER_UNFILED_TEACH) &&
    /real folder/i.test(EXPLORER_FOLDER_TEACH) &&
    /create a draft here or move/i.test(EXPLORER_FOLDER_TEACH)
  );
}

export function explorerEmptyKeepsUnfiledVirtual(source: string): boolean {
  const unfiledTeach = source.match(
    /function HomeEmptyTeach[\s\S]*?function FolderEmpty/,
  );
  const unfiledFiled = source.match(
    /function UnfiledEmptyFiled[\s\S]*?function HomeFilteredEmpty/,
  );
  if (!unfiledTeach || !unfiledFiled) {
    return false;
  }
  return (
    source.includes("EXPLORER_UNFILED_VIRTUAL_LABEL") &&
    source.includes("FOLDER_UNFILED_LOCKED_HELP") &&
    source.includes("UNFILED_FOLDER_LABEL") &&
    !unfiledTeach[0].includes('data-home-folder-empty-verb="delete"') &&
    !unfiledFiled[0].includes('data-home-folder-empty-verb="delete"') &&
    !unfiledTeach[0].includes("DELETE_FOLDER_LABEL") &&
    !unfiledFiled[0].includes("DELETE_FOLDER_LABEL") &&
    FOLDER_UNFILED_LOCKED_HELP.includes("virtual") &&
    UNFILED_FOLDER_LABEL === "Unfiled"
  );
}

export function explorerEmptyKeepsDraftsLoud(source: string): boolean {
  return (
    source.includes("EXPLORER_DRAFTS_DO_NOT_RUN") &&
    source.includes('data-x4="drafts-do-not-run"') &&
    source.includes("FF_EXPLORER_DRAFTS_BANNER_CLASS") &&
    /drafts do not run/i.test(EXPLORER_DRAFTS_DO_NOT_RUN) &&
    /drafts do not run/i.test(EXPLORER_EMPTY_HELP) &&
    /drafts do not run/i.test(FOLDER_EMPTY_HELP) &&
    /drafts do not run/i.test(UNFILED_EMPTY_NONE_HELP) &&
    FF_EXPLORER_DRAFTS_BANNER_CLASS.includes("ff-loud-warning")
  );
}

export function explorerEmptyKeepsX2EmptyPaneMenu(source: string): boolean {
  return (
    source.includes('data-x2="pane-surface"') &&
    source.includes('data-x4="pane-surface"') &&
    source.includes('openExplorerMenu({ kind: "empty-pane" }') &&
    source.includes("explorerEmptyPaneMenuItems") &&
    EXPLORER_CONTEXT_MENU.emptyPaneNewCreateImport &&
    /Right-click this pane/i.test(EXPLORER_EMPTY_PANE_HINT)
  );
}

export function explorerEmptyShowsDeveloperFixtures(source: string): boolean {
  return EMPTY_STATE_DEVELOPER_FIXTURE_TOKENS.some((token) =>
    source.includes(token),
  );
}

export function explorerDocsKeepEpicOpen(docs: string): boolean {
  return (
    docs.includes("#383") &&
    /keep #383 open/i.test(docs) &&
    docs.includes("#379") &&
    /keep #379 open/i.test(docs) &&
    EXPLORER_EMPTY_AUTO_CLOSE_TOKENS.every((token) => !docs.includes(token))
  );
}

export function explorerEmptyHoldsHardLines(): boolean {
  return (
    EXPLORER_EMPTY.yamlIsSourceOfTruth &&
    EXPLORER_EMPTY.foldersNotInYaml &&
    EXPLORER_EMPTY.draftsNeverRun &&
    EXPLORER_EMPTY.vaultDisplayNameUuidOnly &&
    EXPLORER_EMPTY.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_EMPTY.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_EMPTY.isolationSuccessIsDenial &&
    EXPLORER_EMPTY.unfiledIsVirtual &&
    EXPLORER_EMPTY.unfiledNeverLooksDeletableOrRenamable &&
    EXPLORER_EMPTY.refuseIfNonemptyDelete &&
    EXPLORER_EMPTY.moveStillPatchFolderIdOnly &&
    EXPLORER_EMPTY.noDraftRevisionBumpOnMove &&
    EXPLORER_EMPTY.nonRecursiveFolderIdStays &&
    EXPLORER_EMPTY.noNewApi &&
    EXPLORER_EMPTY.notAnN8nClone &&
    EXPLORER_EMPTY.noKekInBrowser &&
    EXPLORER_EMPTY.noDeveloperFixtures &&
    EXPLORER_EMPTY.keep383Open &&
    EXPLORER_EMPTY.keep379Open &&
    EXPLORER_EMPTY.noAutoCloseEpic &&
    EXPLORER_EMPTY.inheritX2ContextMenus &&
    EXPLORER_EMPTY.inheritX3SelectOpen &&
    EXPLORER_CONTEXT_MENU.keep379Open &&
    EXPLORER_SELECT_OPEN.keep379Open &&
    EXPLORER_SHELL.keep379Open &&
    X1_KEEP_EPIC_OPEN &&
    X2_KEEP_EPIC_OPEN &&
    X3_KEEP_EPIC_OPEN &&
    X1_EPIC === X4_EPIC &&
    X2_EPIC === X4_EPIC &&
    X3_EPIC === X4_EPIC &&
    UNFILED_FOLDER_LABEL === "Unfiled" &&
    FOLDER_EMPTY_CREATE_LABEL === "Create here" &&
    FOLDER_EMPTY_MOVE_LABEL === "Move existing" &&
    emptyFolderDeleteAllowed({ childFolderCount: 0, workflowCount: 0 }) &&
    !emptyFolderDeleteAllowed({ childFolderCount: 1, workflowCount: 0 }) &&
    !emptyFolderDeleteAllowed({ childFolderCount: 0, workflowCount: 1 })
  );
}

export function explorerEmptyInheritsPriorStories(): boolean {
  return (
    EXPLORER_EMPTY.inheritF1ThroughF7 &&
    EXPLORER_EMPTY.inheritF5EmptyVerbs &&
    EXPLORER_EMPTY.inheritO3Teaching &&
    EXPLORER_EMPTY.inheritX1ExplorerShell &&
    EXPLORER_EMPTY.inheritX2ContextMenus &&
    EXPLORER_EMPTY.inheritX3SelectOpen &&
    EXPLORER_EMPTY.emptyPaneKeepsX2ContextMenu &&
    F2_HOME_FOLDER.keep309Open &&
    F3_HOME_FOLDER.keep310Open &&
    F4_HOME_FOLDER.keep311Open &&
    F5_HOME_FOLDER.keep312Open &&
    F6_HOME_FOLDER.keep313Open &&
    F7_HOME_FOLDER.keep314Open &&
    F320_KEEP_OPEN &&
    OVERVIEW_HOME.keep325Open &&
    OVERVIEW_PATH_PILLS.keep326Open &&
    OVERVIEW_EMPTY.keep327Open &&
    OVERVIEW_EMBED.keep328Open
  );
}
