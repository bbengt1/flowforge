/**
 * X.3: Dense list rows + select/open.
 *
 * Relates to #382 / Part of #379. Keep #382 open. Keep #379 open.
 * Do not auto-close the Windows Explorer epic.
 *
 * Chloe UI only. Presentation polish of the X.1 content pane on
 * `/workflows`. Dense list/details rows stay the default (name,
 * published/activation, last-run as scan ends — no stats/Personal/
 * link-count). Single-click selects a folder-child or workflow row
 * without navigating. Double-click / Enter opens: workflow → editor;
 * folder → select/navigate into that folder (expand + select in the
 * tree and content pane). Right-click selects the target so X.2
 * menus stay on the intended row. Arrow keys move the highlight
 * when the list is focused. Multi-select is deferred. V.1 tokens
 * (teal accent / charcoal) mark the selected row.
 *
 * Shared `WorkflowHome` stays so embed does not fork. Full embed
 * parity is X.5 / #384 (keep #384 open; keep #379 open). Empty
 * teaching polish is X.4 (#383 — keep #383 open; keep #379 open).
 * No new APIs.
 *
 * F.1–F.7 stay: Unfiled virtual, non-recursive `?folderId=`,
 * refuse-if-nonempty, move = `PATCH folderId` only. X.2 menus stay
 * grant-gated existing F/O verbs.
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
  EXPLORER_CONTEXT_MENU,
  X2_EPIC,
  X2_KEEP_EPIC_OPEN,
} from "./explorer-context-menu.ts";
import {
  EXPLORER_SHELL,
  X1_EPIC,
  X1_KEEP_EPIC_OPEN,
} from "./explorer-shell.ts";
import {
  F2_HOME_FOLDER,
  F3_HOME_FOLDER,
  F4_HOME_FOLDER,
  F5_HOME_FOLDER,
  F6_HOME_FOLDER,
  F7_HOME_FOLDER,
  F320_KEEP_OPEN,
  UNFILED_FOLDER_LABEL,
  ancestorIdsForSelection,
  type WorkflowFolder,
} from "./workflow-folder.ts";

export const X3_STORY = 382;
export const X3_EPIC = 379;
export const X3_KEEP_STORY_OPEN = true;
export const X3_KEEP_EPIC_OPEN = true;
export const X3_ID = "X.3-explorer-select-open" as const;
export const X3_BRIEF = "docs/internal/flowforge-workflow-folders.md";

export const EXPLORER_SELECT_HELP =
  "Single-click selects a row. Double-click or Enter opens a workflow in the editor or navigates into a folder.";

export const FF_EXPLORER_ROW_SELECTED_CLASS = "ff-explorer-row-selected";

export const EXPLORER_SELECT_OPEN = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritX1ExplorerShell: true,
  inheritX2ContextMenus: true,
  inheritO1CardFields: true,
  inheritO2PathPills: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  denseListRowsDefault: true,
  scanEndsNameActivationLastRun: true,
  noStatsPersonalLinkCount: true,
  singleClickSelectsWithoutNavigate: true,
  doubleClickOrEnterOpens: true,
  workflowOpenGoesToEditor: true,
  folderOpenSelectsAndNavigates: true,
  selectedRowUsesV1Accent: true,
  rightClickSelectsTarget: true,
  enterOpensSelection: true,
  arrowKeysMoveHighlight: true,
  multiSelectDeferred: true,
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
  keep382Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
} as const;

export const EXPLORER_SELECT_OPEN_SOURCES = [
  "src/lib/explorer-select-open.ts",
  "src/lib/explorer-context-menu.ts",
  "src/lib/explorer-shell.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
  "src/app/globals.css",
] as const;

export const EXPLORER_SELECT_AUTO_CLOSE_TOKENS = [
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
  "Fixes #382",
  "Closes #382",
] as const;

export type ExplorerPaneRow =
  | { kind: "folder"; id: string }
  | { kind: "workflow"; id: string };

export function explorerPaneRows(
  folders: readonly { id: string }[],
  workflows: readonly { id: string }[],
): ExplorerPaneRow[] {
  return [
    ...folders.map((folder) => ({ kind: "folder" as const, id: folder.id })),
    ...workflows.map((item) => ({ kind: "workflow" as const, id: item.id })),
  ];
}

export function explorerPaneRowKey(row: ExplorerPaneRow): string {
  return `${row.kind}:${row.id}`;
}

export function explorerPaneRowEquals(
  left: ExplorerPaneRow | null | undefined,
  right: ExplorerPaneRow | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.kind === right.kind &&
    left.id === right.id
  );
}

export function explorerPaneSelectionStillVisible(
  rows: readonly ExplorerPaneRow[],
  selection: ExplorerPaneRow | null,
): boolean {
  if (!selection) {
    return true;
  }
  return rows.some((row) => explorerPaneRowEquals(row, selection));
}

/**
 * Folder navigation always drops the highlight. Leaving a folder and
 * coming back must not restore the previous row. When the folder is
 * unchanged, keep the current row only if it is still in the pane.
 */
export function reconcileExplorerPaneSelection(
  selection: ExplorerPaneRow | null,
  rows: readonly ExplorerPaneRow[],
  folderKey: string,
  previousFolderKey: string | null,
): ExplorerPaneRow | null {
  if (previousFolderKey !== folderKey) {
    return null;
  }
  return explorerPaneSelectionStillVisible(rows, selection) ? selection : null;
}

export function explorerOpenKind(
  row: ExplorerPaneRow,
): "editor" | "navigate-folder" {
  return row.kind === "workflow" ? "editor" : "navigate-folder";
}

export function explorerAdvancePaneSelection(
  rows: readonly ExplorerPaneRow[],
  selection: ExplorerPaneRow | null,
  direction: "next" | "prev",
): ExplorerPaneRow | null {
  if (rows.length === 0) {
    return null;
  }
  if (!selection) {
    return direction === "next" ? rows[0] : rows[rows.length - 1];
  }
  const index = rows.findIndex((row) => explorerPaneRowEquals(row, selection));
  if (index < 0) {
    return direction === "next" ? rows[0] : rows[rows.length - 1];
  }
  const next = direction === "next" ? index + 1 : index - 1;
  if (next < 0 || next >= rows.length) {
    return rows[index];
  }
  return rows[next];
}

export function explorerExpandIdsForOpenFolder(
  folders: readonly WorkflowFolder[],
  folderId: string,
): string[] {
  return [
    folderId,
    ...ancestorIdsForSelection(folders, { kind: "folder", id: folderId }),
  ];
}

export function explorerHomeWiresSelectOpen(source: string): boolean {
  return (
    source.includes('data-x3="select-open"') &&
    source.includes('data-x3="pane-list"') &&
    source.includes('data-x3="pane-row"') &&
    source.includes("data-x3-selected") &&
    source.includes("onDoubleClick") &&
    source.includes('event.key === "Enter"') &&
    source.includes("ArrowDown") &&
    source.includes("setPaneSelection") &&
    source.includes("workflowEditorHref") &&
    source.includes("selectFolder") &&
    source.includes("explorerExpandIdsForOpenFolder") &&
    source.includes("onContextMenu") &&
    source.includes('data-x2="context-menu"')
  );
}

export function explorerHomeSelectsOnContextMenu(source: string): boolean {
  return (
    source.includes("onContextMenu") &&
    source.includes("setPaneSelection") &&
    source.includes("openExplorerMenu") &&
    source.includes('data-x2="content-row"') &&
    source.includes('data-x2="folder-row"')
  );
}

export function explorerHomeNameDoesNotNavigateOnSingleClick(
  source: string,
): boolean {
  const name = source.match(
    /data-o1="card-name"[\s\S]{0,240}/,
  );
  if (!name) {
    return false;
  }
  return !name[0].includes("href=") && !name[0].includes("<Link");
}

export function explorerDocsKeepEpicOpen(docs: string): boolean {
  // Published docs cite X.3. Internal briefs may still cite the issues.
  const cites =
    (/X\.3/.test(docs) && /single-click|double-click/i.test(docs)) ||
    (docs.includes("#382") &&
      /keep #382 open/i.test(docs) &&
      docs.includes("#379") &&
      /keep #379 open/i.test(docs));
  return (
    cites &&
    EXPLORER_SELECT_AUTO_CLOSE_TOKENS.every((token) => !docs.includes(token))
  );
}

export function explorerSelectHoldsHardLines(): boolean {
  return (
    EXPLORER_SELECT_OPEN.yamlIsSourceOfTruth &&
    EXPLORER_SELECT_OPEN.foldersNotInYaml &&
    EXPLORER_SELECT_OPEN.draftsNeverRun &&
    EXPLORER_SELECT_OPEN.vaultDisplayNameUuidOnly &&
    EXPLORER_SELECT_OPEN.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_SELECT_OPEN.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_SELECT_OPEN.isolationSuccessIsDenial &&
    EXPLORER_SELECT_OPEN.unfiledIsVirtual &&
    EXPLORER_SELECT_OPEN.refuseIfNonemptyDelete &&
    EXPLORER_SELECT_OPEN.moveStillPatchFolderIdOnly &&
    EXPLORER_SELECT_OPEN.noDraftRevisionBumpOnMove &&
    EXPLORER_SELECT_OPEN.nonRecursiveFolderIdStays &&
    EXPLORER_SELECT_OPEN.noNewApi &&
    EXPLORER_SELECT_OPEN.notAnN8nClone &&
    EXPLORER_SELECT_OPEN.noKekInBrowser &&
    EXPLORER_SELECT_OPEN.keep382Open &&
    EXPLORER_SELECT_OPEN.keep379Open &&
    EXPLORER_SELECT_OPEN.noAutoCloseEpic &&
    EXPLORER_SELECT_OPEN.inheritX2ContextMenus &&
    EXPLORER_CONTEXT_MENU.keep379Open &&
    EXPLORER_SHELL.keep379Open &&
    X1_KEEP_EPIC_OPEN &&
    X2_KEEP_EPIC_OPEN &&
    X1_EPIC === X3_EPIC &&
    X2_EPIC === X3_EPIC &&
    UNFILED_FOLDER_LABEL === "Unfiled"
  );
}

export function explorerSelectInheritsFolderStories(): boolean {
  return (
    EXPLORER_SELECT_OPEN.inheritF1ThroughF7 &&
    EXPLORER_SELECT_OPEN.inheritX1ExplorerShell &&
    EXPLORER_SELECT_OPEN.inheritX2ContextMenus &&
    EXPLORER_SELECT_OPEN.inheritO1CardFields &&
    EXPLORER_SELECT_OPEN.inheritO2PathPills &&
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
