/**
 * X.7: New folder creates then inline-renames in the Explorer
 * tree/pane (Windows Explorer style).
 *
 * Relates to #396 / Part of #379. Keep #396 open. Keep #379 open.
 * Do not auto-close #393, #379, or unrelated issues.
 *
 * Chloe UI only. New folder (rail, empty teaching, or X.2
 * context menu) POSTs via the existing F.3 folder API, selects
 * the new row, and enters an in-place name field. Rename from
 * the folder menu / rail / F2 uses the same inline field and
 * the existing name PATCH. No modal, `window.prompt`, or
 * separate name dialog.
 *
 * Escape / empty blur keeps the server name so a nameless row
 * is never stranded. Enter commits when the name is valid.
 * Unfiled stays virtual. Refuse-if-nonempty delete is unchanged.
 * Visual density/icons wait on Brent’s reference screenshot —
 * this story is interaction only. Same `WorkflowHome` on embed
 * after `session.embed`. No new APIs.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID
 * · ADV-021/024 · folders not in YAML · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no KEK.
 */

import {
  EXPLORER_CONTEXT_MENU,
  X2_EPIC,
  X2_KEEP_EPIC_OPEN,
} from "./explorer-context-menu.ts";
import {
  EXPLORER_EMPTY,
} from "./explorer-empty-states.ts";
import { EXPLORER_EMBED } from "./explorer-embed.ts";
import { EXPLORER_HOME_COPY } from "./explorer-home-copy.ts";
import {
  EXPLORER_SELECT_OPEN,
  type ExplorerPaneRow,
} from "./explorer-select-open.ts";
import {
  EXPLORER_SHELL,
  X1_EPIC,
  X1_KEEP_EPIC_OPEN,
} from "./explorer-shell.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  F2_HOME_FOLDER,
  F3_HOME_FOLDER,
  F4_HOME_FOLDER,
  F5_HOME_FOLDER,
  F6_HOME_FOLDER,
  F7_HOME_FOLDER,
  F320_KEEP_OPEN,
  NEW_FOLDER_LABEL,
  UNFILED_FOLDER_LABEL,
  folderAllowsRenameOrDelete,
  folderNameSubmitError,
  siblingFolderNameTaken,
  type FolderSelection,
  type WorkflowFolder,
} from "./workflow-folder.ts";

export const X7_STORY = 396;
export const X7_EPIC = 379;
export const X7_KEEP_STORY_OPEN = true;
export const X7_KEEP_EPIC_OPEN = true;
export const X7_ID = "X.7-explorer-inline-rename" as const;
export const X7_BRIEF = "docs/internal/flowforge-workflow-folders.md";

export const EXPLORER_INLINE_RENAME_HELP =
  "New folder creates a folder, then names it in the tree. F2 or Rename edits the name in place. Enter saves. Escape keeps the current name.";

export const EXPLORER_INLINE_RENAME = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritX1ExplorerShell: true,
  inheritX2ContextMenus: true,
  inheritX3SelectOpen: true,
  inheritX4EmptyTeaching: true,
  inheritX5EmbedParity: true,
  inheritX6HomeCopy: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  createThenInlineRename: true,
  noModalNamePrompt: true,
  noWindowPrompt: true,
  renameUsesInlineField: true,
  f2RenamesSelectedFolder: true,
  enterCommits: true,
  escapeKeepsServerName: true,
  emptyBlurKeepsServerName: true,
  interactionOnlyNoNewLook: true,
  sameWorkflowHomeNoSecondTree: true,
  noJonnyChange: true,
  noNewApi: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  unfiledCannotRename: true,
  refuseIfNonemptyDelete: true,
  workflowRenameOmittedNoApi: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep396Open: true,
  keep379Open: true,
  keep393Open: true,
  noAutoCloseEpic: true,
  noAutoCloseUnrelated: true,
} as const;

export const EXPLORER_INLINE_RENAME_SOURCES = [
  "src/lib/explorer-inline-rename.ts",
  "src/lib/explorer-context-menu.ts",
  "src/lib/workflow-folder.ts",
  "src/lib/workflow-folder-client.ts",
  "src/components/home/WorkflowHome.tsx",
] as const;

export const EXPLORER_INLINE_RENAME_AUTO_CLOSE_TOKENS = [
  "Fixes #396",
  "Closes #396",
  "Close #396",
  "Resolves #396",
  "Fixes #393",
  "Closes #393",
  "Close #393",
  "Resolves #393",
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
] as const;

export const EXPLORER_INLINE_RENAME_MODAL_TOKENS = [
  "data-home-folder-dialog",
  "window.prompt",
  "window.prompt(",
] as const;

export type InlineRenameDecision =
  | { action: "keep" }
  | { action: "commit"; name: string }
  | { action: "invalid"; error: string };

export function nextNewFolderName(
  items: readonly WorkflowFolder[],
  parentId: string | null,
): string {
  if (!siblingFolderNameTaken(items, NEW_FOLDER_LABEL, parentId)) {
    return NEW_FOLDER_LABEL;
  }
  for (let index = 2; index < 1000; index += 1) {
    const name = `${NEW_FOLDER_LABEL} (${index})`;
    if (!siblingFolderNameTaken(items, name, parentId)) {
      return name;
    }
  }
  return `${NEW_FOLDER_LABEL} (${Date.now()})`;
}

export function inlineRenameEnterDecision(
  items: readonly WorkflowFolder[],
  draft: string,
  parentId: string | null,
  folderId: string,
  currentName: string,
): InlineRenameDecision {
  const trimmed = draft.trim();
  if (!trimmed) {
    return { action: "keep" };
  }
  const error = folderNameSubmitError(items, draft, parentId, folderId);
  if (error) {
    return { action: "invalid", error };
  }
  if (trimmed === currentName) {
    return { action: "keep" };
  }
  return { action: "commit", name: trimmed };
}

export function inlineRenameBlurDecision(
  items: readonly WorkflowFolder[],
  draft: string,
  parentId: string | null,
  folderId: string,
  currentName: string,
): InlineRenameDecision {
  const trimmed = draft.trim();
  if (!trimmed) {
    return { action: "keep" };
  }
  const error = folderNameSubmitError(items, draft, parentId, folderId);
  if (error) {
    return { action: "keep" };
  }
  if (trimmed === currentName) {
    return { action: "keep" };
  }
  return { action: "commit", name: trimmed };
}

export function inlineRenameF2Target(
  canMutate: boolean,
  treeSelection: FolderSelection,
  paneSelection: ExplorerPaneRow | null,
): string | null {
  if (!canMutate) {
    return null;
  }
  if (paneSelection) {
    if (paneSelection.kind !== "folder") {
      return null;
    }
    return folderAllowsRenameOrDelete({
      kind: "folder",
      id: paneSelection.id,
    })
      ? paneSelection.id
      : null;
  }
  if (treeSelection.kind === "folder") {
    return folderAllowsRenameOrDelete(treeSelection)
      ? treeSelection.id
      : null;
  }
  return null;
}

export function explorerEventBlocksInlineRenameHotkey(
  target:
    | EventTarget
    | { tagName?: string; isContentEditable?: boolean }
    | null,
): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
  };
  const tag = el.tagName?.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

export function explorerHomeCreatesThenInlineRenames(source: string): boolean {
  return (
    source.includes("openCreateFolder") &&
    source.includes("createWorkflowFolder") &&
    source.includes("nextNewFolderName") &&
    source.includes("startInlineRename") &&
    source.includes("data-home-folder-inline-rename") &&
    source.includes('data-x7="inline-rename"') &&
    source.includes("renameWorkflowFolder") &&
    source.includes('event.key === "F2"') &&
    source.includes('event.key === "Enter"') &&
    source.includes('event.key === "Escape"') &&
    !source.includes("data-home-folder-dialog") &&
    !source.includes("window.prompt")
  );
}

export function explorerHomeRenameStaysInline(source: string): boolean {
  return (
    source.includes("openRenameFolder") &&
    source.includes("startInlineRename") &&
    source.includes("inlineRenameEnterDecision") &&
    source.includes("inlineRenameBlurDecision") &&
    source.includes("folderAllowsRenameOrDelete") &&
    !source.includes("data-home-folder-dialog")
  );
}

export function explorerHomeRenameDoesNotRefreshAfterCommit(
  source: string,
): boolean {
  const submit = source.match(
    /async function submitInlineRename[\s\S]*?(?=\n  async function |\n  function )/,
  );
  if (!submit) {
    return false;
  }
  return (
    submit[0].includes("setFolders") &&
    submit[0].includes("renameWorkflowFolder") &&
    !submit[0].includes("refresh(")
  );
}

export function explorerDocsKeepStoryOpen(docs: string): boolean {
  // Published docs cite X.7. Internal briefs may still cite the issues.
  const cites =
    /X\.7/.test(docs) ||
    (docs.includes("#396") &&
      /keep #396 open/i.test(docs) &&
      docs.includes("#379") &&
      /keep #379 open/i.test(docs));
  return (
    cites &&
    EXPLORER_INLINE_RENAME_AUTO_CLOSE_TOKENS.every(
      (token) => !docs.includes(token),
    )
  );
}

export function explorerInlineRenameHoldsHardLines(): boolean {
  return (
    EXPLORER_INLINE_RENAME.yamlIsSourceOfTruth &&
    EXPLORER_INLINE_RENAME.draftsNeverRun &&
    EXPLORER_INLINE_RENAME.vaultDisplayNameUuidOnly &&
    EXPLORER_INLINE_RENAME.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_INLINE_RENAME.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_INLINE_RENAME.isolationSuccessIsDenial &&
    EXPLORER_INLINE_RENAME.unfiledIsVirtual &&
    EXPLORER_INLINE_RENAME.unfiledCannotRename &&
    EXPLORER_INLINE_RENAME.refuseIfNonemptyDelete &&
    EXPLORER_INLINE_RENAME.noNewApi &&
    EXPLORER_INLINE_RENAME.notAnN8nClone &&
    EXPLORER_INLINE_RENAME.noKekInBrowser &&
    EXPLORER_INLINE_RENAME.keep396Open &&
    EXPLORER_INLINE_RENAME.keep379Open &&
    EXPLORER_INLINE_RENAME.keep393Open &&
    EXPLORER_INLINE_RENAME.noAutoCloseEpic &&
    EXPLORER_INLINE_RENAME.noAutoCloseUnrelated &&
    EXPLORER_INLINE_RENAME.interactionOnlyNoNewLook &&
    EXPLORER_INLINE_RENAME.workflowRenameOmittedNoApi &&
    EXPLORER_CONTEXT_MENU.workflowRenameOmittedNoApi &&
    EXPLORER_HOME_COPY.keep393Open &&
    EXPLORER_SHELL.keep379Open &&
    X1_KEEP_EPIC_OPEN &&
    X2_KEEP_EPIC_OPEN &&
    X1_EPIC === X7_EPIC &&
    X2_EPIC === X7_EPIC &&
    UNFILED_FOLDER_LABEL === "Unfiled"
  );
}

export function explorerInlineRenameInheritsPriorStories(): boolean {
  return (
    EXPLORER_INLINE_RENAME.inheritF1ThroughF7 &&
    EXPLORER_INLINE_RENAME.inheritX1ExplorerShell &&
    EXPLORER_INLINE_RENAME.inheritX2ContextMenus &&
    EXPLORER_INLINE_RENAME.inheritX3SelectOpen &&
    EXPLORER_INLINE_RENAME.inheritX4EmptyTeaching &&
    EXPLORER_INLINE_RENAME.inheritX5EmbedParity &&
    EXPLORER_INLINE_RENAME.inheritX6HomeCopy &&
    EXPLORER_INLINE_RENAME.sameWorkflowHomeNoSecondTree &&
    F2_HOME_FOLDER.keep309Open &&
    F3_HOME_FOLDER.keep310Open &&
    F4_HOME_FOLDER.keep311Open &&
    F5_HOME_FOLDER.keep312Open &&
    F6_HOME_FOLDER.keep313Open &&
    F7_HOME_FOLDER.keep314Open &&
    F320_KEEP_OPEN &&
    EXPLORER_SELECT_OPEN.singleClickSelectsWithoutNavigate &&
    EXPLORER_EMPTY.draftsDoNotRunStaysLoud &&
    EXPLORER_EMBED.sameWorkflowHomeNoSecondTree &&
    EXPLORER_HOME_COPY.visiblePageHasNoEpicCommentary
  );
}
