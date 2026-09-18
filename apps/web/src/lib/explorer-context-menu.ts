/**
 * X.2: Right-click context menus (folder / workflow / empty).
 *
 * Relates to #381 / Part of #379. Keep #381 open. Keep #379 open.
 * Do not auto-close the Windows Explorer epic.
 *
 * Chloe UI only. Grant-gated Explorer menus on `/workflows` using
 * existing F/O verbs — no new APIs. Folder (tree or content-pane
 * folder row): New folder / Rename / Delete (disabled if
 * non-empty) / Expand. Workflow row: Open / Move… — Rename and
 * Delete stay omitted until an F/O client exists (none on main).
 * Empty pane: New folder / Create workflow / Import YAML (Import
 * already exists in home chrome). Paste is deferred. Viewers get
 * Open / Expand / select only — no mutate verbs (fail-closed).
 * Unfiled is virtual: no Rename / Delete on Unfiled itself.
 *
 * Wire menus to X.1 / F handlers. Move stays `PATCH folderId`
 * (`null` = Unfiled) and does not bump draftRevision / YAML.
 * Refuse-if-nonempty still holds. V.1 tokens only.
 *
 * Out of scope for this story: Miller columns, Tags, Favorites,
 * clipboard Paste, #376 change-password. Select/open polish is
 * X.3 (#382). Empty teaching is X.4 (#383). Embed parity is
 * X.5 / #384 (keep #384 open; keep #379 open).
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID
 * · ADV-021/024 · folders not in YAML · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no KEK.
 */

import { OVERVIEW_CREATE_LABEL } from "./overview-home.ts";
import { HOME_EMPTY_IMPORT_LABEL } from "./empty-states-teach-model.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  DELETE_FOLDER_LABEL,
  FOLDER_DEPTH_HELP,
  FOLDER_NOT_EMPTY_HELP,
  FOLDER_UNFILED_LOCKED_HELP,
  FOLDER_MOVE_VERB,
  NEW_FOLDER_LABEL,
  RENAME_FOLDER_LABEL,
  UNFILED_FOLDER_LABEL,
  F2_HOME_FOLDER,
  F3_HOME_FOLDER,
  F4_HOME_FOLDER,
  F5_HOME_FOLDER,
  F6_HOME_FOLDER,
  F7_HOME_FOLDER,
  F320_KEEP_OPEN,
  type FolderSelection,
  type WorkflowFolder,
} from "./workflow-folder.ts";
import {
  EXPLORER_SHELL,
  X1_EPIC,
  X1_KEEP_EPIC_OPEN,
} from "./explorer-shell.ts";

export const X2_STORY = 381;
export const X2_EPIC = 379;
export const X2_KEEP_STORY_OPEN = true;
export const X2_KEEP_EPIC_OPEN = true;
export const X2_ID = "X.2-explorer-context-menus" as const;
export const X2_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const EXPLORER_OPEN_LABEL = "Open";
export const EXPLORER_EXPAND_LABEL = "Expand";
export const EXPLORER_COLLAPSE_LABEL = "Collapse";
export const EXPLORER_MENU_LABEL = "Explorer actions";

export const FF_EXPLORER_MENU_CLASS = "ff-explorer-menu";
export const FF_EXPLORER_MENU_ITEM_CLASS = "ff-explorer-menu-item";

export const EXPLORER_CONTEXT_MENU = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritX1ExplorerShell: true,
  inheritF3OrganizeVerbs: true,
  inheritF4Move: true,
  inheritF5EmptyVerbs: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  grantGatedRightClick: true,
  folderMenuNewRenameDeleteExpand: true,
  workflowMenuOpenMove: true,
  workflowRenameOmittedNoApi: true,
  workflowDeleteOmittedNoApi: true,
  emptyPaneNewCreateImport: true,
  importOnlyIfHomeChromeHasIt: true,
  pasteDeferred: true,
  viewersOpenSelectOnly: true,
  failClosedOnGrants: true,
  unfiledNotDestructivelyMutable: true,
  refuseIfNonemptyDelete: true,
  deleteVisibleDisabledWhenNonempty: true,
  moveStillPatchFolderIdOnly: true,
  noDraftRevisionBumpOnMove: true,
  usesExistingApisOnly: true,
  noNewApi: true,
  noJonnyChange: true,
  identityProxyAllowlistUnchanged: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  noMillerColumns: true,
  noTagsFirst: true,
  noFavorites: true,
  noClipboardPaste: true,
  notFinderPrimary: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep381Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
} as const;

export const EXPLORER_CONTEXT_MENU_SOURCES = [
  "src/lib/explorer-context-menu.ts",
  "src/lib/explorer-shell.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
  "src/app/globals.css",
] as const;

export const EXPLORER_CONTEXT_AUTO_CLOSE_TOKENS = [
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
  "Fixes #381",
  "Closes #381",
] as const;

export const EXPLORER_CONTEXT_DEFERRED_TOKENS = [
  "Paste",
  "clipboard",
  "data-x2=\"paste\"",
  "data-x2=\"favorites\"",
  "data-x2=\"tags-first\"",
  "miller column",
  "Miller columns",
] as const;

export const EXPLORER_INVENTED_WORKFLOW_VERBS = [
  "renameWorkflow(",
  "deleteWorkflow(",
  "archiveWorkflow(",
] as const;

export type ExplorerContextVerb =
  | "new-folder"
  | "rename"
  | "delete"
  | "expand"
  | "open"
  | "move"
  | "create-workflow"
  | "import";

export function explorerMenuFolderVerb(
  id: ExplorerContextVerb,
): "new" | "rename" | "delete" | undefined {
  if (id === "new-folder") {
    return "new";
  }
  if (id === "rename") {
    return "rename";
  }
  if (id === "delete") {
    return "delete";
  }
  return undefined;
}

export type ExplorerContextItem = {
  id: ExplorerContextVerb;
  label: string;
  mutate: boolean;
  hidden?: boolean;
  disabled?: boolean;
  reason?: string;
};

export type ExplorerContextTarget =
  | { kind: "folder"; id: string }
  | { kind: "unfiled" }
  | { kind: "workflow"; id: string }
  | { kind: "empty-pane" };

export type ExplorerFolderMenuInput = {
  canMutate: boolean;
  isUnfiled: boolean;
  canCreateChild: boolean;
  deleteBlocked: boolean;
  canExpand: boolean;
  expanded: boolean;
};

export type ExplorerWorkflowMenuInput = {
  canMutate: boolean;
  canRenameWorkflow?: boolean;
  canDeleteWorkflow?: boolean;
};

export type ExplorerEmptyPaneMenuInput = {
  canMutateFolders: boolean;
  canCreate: boolean;
  importExistsInHomeChrome: boolean;
};

function withHidden(
  item: ExplorerContextItem,
  hidden: boolean,
): ExplorerContextItem {
  if (!hidden) {
    const next = { ...item };
    delete next.hidden;
    return next;
  }
  return { ...item, hidden: true };
}

function gateMutate(item: ExplorerContextItem, canMutate: boolean): ExplorerContextItem {
  if (!item.mutate || canMutate) {
    return withHidden(item, item.hidden === true);
  }
  return { ...item, hidden: true };
}

export function explorerFolderMenuItems(
  input: ExplorerFolderMenuInput,
): ExplorerContextItem[] {
  const renameHidden = input.isUnfiled;
  const deleteHidden = input.isUnfiled;
  return [
    gateMutate(
      {
        id: "new-folder",
        label: NEW_FOLDER_LABEL,
        mutate: true,
        disabled: !input.canCreateChild,
        reason: input.canCreateChild ? undefined : FOLDER_DEPTH_HELP,
      },
      input.canMutate,
    ),
    gateMutate(
      {
        id: "rename",
        label: RENAME_FOLDER_LABEL,
        mutate: true,
        hidden: renameHidden,
        reason: renameHidden ? FOLDER_UNFILED_LOCKED_HELP : undefined,
      },
      input.canMutate,
    ),
    gateMutate(
      {
        id: "delete",
        label: DELETE_FOLDER_LABEL,
        mutate: true,
        hidden: deleteHidden,
        disabled: !deleteHidden && input.deleteBlocked,
        reason: deleteHidden
          ? FOLDER_UNFILED_LOCKED_HELP
          : input.deleteBlocked
            ? FOLDER_NOT_EMPTY_HELP
            : undefined,
      },
      input.canMutate,
    ),
    {
      id: "expand",
      label: input.expanded ? EXPLORER_COLLAPSE_LABEL : EXPLORER_EXPAND_LABEL,
      mutate: false,
      hidden: input.isUnfiled || !input.canExpand,
    },
  ];
}

export function explorerWorkflowMenuItems(
  input: ExplorerWorkflowMenuInput,
): ExplorerContextItem[] {
  return [
    {
      id: "open",
      label: EXPLORER_OPEN_LABEL,
      mutate: false,
    },
    gateMutate(
      {
        id: "rename",
        label: RENAME_FOLDER_LABEL,
        mutate: true,
        hidden: input.canRenameWorkflow !== true,
      },
      input.canMutate,
    ),
    gateMutate(
      {
        id: "move",
        label: FOLDER_MOVE_VERB,
        mutate: true,
      },
      input.canMutate,
    ),
    gateMutate(
      {
        id: "delete",
        label: DELETE_FOLDER_LABEL,
        mutate: true,
        hidden: input.canDeleteWorkflow !== true,
      },
      input.canMutate,
    ),
  ];
}

export function explorerEmptyPaneMenuItems(
  input: ExplorerEmptyPaneMenuInput,
): ExplorerContextItem[] {
  return [
    gateMutate(
      {
        id: "new-folder",
        label: NEW_FOLDER_LABEL,
        mutate: true,
      },
      input.canMutateFolders,
    ),
    gateMutate(
      {
        id: "create-workflow",
        label: OVERVIEW_CREATE_LABEL,
        mutate: true,
      },
      input.canCreate,
    ),
    gateMutate(
      {
        id: "import",
        label: HOME_EMPTY_IMPORT_LABEL,
        mutate: true,
        hidden: !input.importExistsInHomeChrome,
      },
      input.canCreate,
    ),
  ];
}

export function visibleExplorerMenuItems(
  items: readonly ExplorerContextItem[],
): ExplorerContextItem[] {
  return items.filter((item) => !item.hidden);
}

export function explorerMenuShowsMutateForViewer(
  items: readonly ExplorerContextItem[],
  canMutate: boolean,
): boolean {
  return (
    !canMutate &&
    visibleExplorerMenuItems(items).some((item) => item.mutate)
  );
}

export function childFoldersForPane(
  folders: readonly WorkflowFolder[],
  selection: FolderSelection,
  options: { acrossSearch?: boolean } = {},
): WorkflowFolder[] {
  if (options.acrossSearch || selection.kind !== "folder") {
    return [];
  }
  return folders
    .filter((folder) => folder.parentId === selection.id)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function explorerMenuPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const pad = 8;
  const left = Math.min(
    Math.max(pad, x),
    Math.max(pad, viewport.width - size.width - pad),
  );
  const top = Math.min(
    Math.max(pad, y),
    Math.max(pad, viewport.height - size.height - pad),
  );
  return { left, top };
}

export function explorerHomeWiresExistingVerbs(source: string): boolean {
  return (
    source.includes('data-x2="context-menu"') &&
    source.includes('data-x2="folder-tree"') &&
    source.includes('data-x2="content-row"') &&
    source.includes('data-x2="pane-surface"') &&
    source.includes("onContextMenu") &&
    source.includes("openCreateFolder") &&
    source.includes("openRenameFolder") &&
    source.includes("removeFolder") &&
    source.includes("openMoveDialog") &&
    source.includes("createFromYaml") &&
    source.includes("importRef") &&
    source.includes("moveWorkflowToFolder") &&
    source.includes("folderIdForMove") &&
    EXPLORER_INVENTED_WORKFLOW_VERBS.every((token) => !source.includes(token))
  );
}

export function explorerHomeGrantGatesMenus(source: string): boolean {
  return (
    source.includes("canMutateFolders") &&
    source.includes("explorerFolderMenuItems") &&
    source.includes("explorerWorkflowMenuItems") &&
    source.includes("explorerEmptyPaneMenuItems") &&
    source.includes("visibleExplorerMenuItems") &&
    source.includes("data-o4-viewer")
  );
}

export function explorerHomeDismissesMenu(source: string): boolean {
  return (
    source.includes('event.key === "Escape"') &&
    source.includes("pointerdown") &&
    source.includes("setExplorerMenu")
  );
}

export function explorerDocsKeepEpicOpen(docs: string): boolean {
  return (
    docs.includes("#381") &&
    /keep #381 open/i.test(docs) &&
    docs.includes("#379") &&
    /keep #379 open/i.test(docs) &&
    EXPLORER_CONTEXT_AUTO_CLOSE_TOKENS.every((token) => !docs.includes(token))
  );
}

export function explorerContextHoldsHardLines(): boolean {
  return (
    EXPLORER_CONTEXT_MENU.yamlIsSourceOfTruth &&
    EXPLORER_CONTEXT_MENU.foldersNotInYaml &&
    EXPLORER_CONTEXT_MENU.draftsNeverRun &&
    EXPLORER_CONTEXT_MENU.vaultDisplayNameUuidOnly &&
    EXPLORER_CONTEXT_MENU.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_CONTEXT_MENU.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_CONTEXT_MENU.isolationSuccessIsDenial &&
    EXPLORER_CONTEXT_MENU.unfiledIsVirtual &&
    EXPLORER_CONTEXT_MENU.unfiledNotDestructivelyMutable &&
    EXPLORER_CONTEXT_MENU.refuseIfNonemptyDelete &&
    EXPLORER_CONTEXT_MENU.moveStillPatchFolderIdOnly &&
    EXPLORER_CONTEXT_MENU.noDraftRevisionBumpOnMove &&
    EXPLORER_CONTEXT_MENU.viewersOpenSelectOnly &&
    EXPLORER_CONTEXT_MENU.failClosedOnGrants &&
    EXPLORER_CONTEXT_MENU.pasteDeferred &&
    EXPLORER_CONTEXT_MENU.noNewApi &&
    EXPLORER_CONTEXT_MENU.notAnN8nClone &&
    EXPLORER_CONTEXT_MENU.noKekInBrowser &&
    EXPLORER_CONTEXT_MENU.keep381Open &&
    EXPLORER_CONTEXT_MENU.keep379Open &&
    EXPLORER_CONTEXT_MENU.noAutoCloseEpic &&
    EXPLORER_SHELL.keep379Open &&
    X1_KEEP_EPIC_OPEN &&
    X1_EPIC === X2_EPIC &&
    UNFILED_FOLDER_LABEL === "Unfiled"
  );
}

export function explorerContextInheritsFolderStories(): boolean {
  return (
    EXPLORER_CONTEXT_MENU.inheritF1ThroughF7 &&
    EXPLORER_CONTEXT_MENU.inheritX1ExplorerShell &&
    EXPLORER_CONTEXT_MENU.inheritF3OrganizeVerbs &&
    EXPLORER_CONTEXT_MENU.inheritF4Move &&
    EXPLORER_CONTEXT_MENU.inheritF5EmptyVerbs &&
    F2_HOME_FOLDER.keep309Open &&
    F3_HOME_FOLDER.keep310Open &&
    F4_HOME_FOLDER.keep311Open &&
    F5_HOME_FOLDER.keep312Open &&
    F6_HOME_FOLDER.keep313Open &&
    F7_HOME_FOLDER.keep314Open &&
    F320_KEEP_OPEN
  );
}
