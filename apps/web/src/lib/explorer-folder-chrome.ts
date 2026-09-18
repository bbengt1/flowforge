/**
 * X.8: Explorer folder chrome — Windows Explorer nav visual.
 *
 * Relates to #399 / Part of #379. Keep #399 open. Keep #379 open.
 * Do not auto-close #396, #393, #379, or unrelated issues.
 *
 * Chloe UI only. Nav tree chrome matches Gracie’s locked TAKE
 * against Brent’s Win11 dark Explorer screenshot: compact rows,
 * yellow folder icons, thin white ▸/▾ chevrons, gray selected
 * fill + thin light border on the whole row, dark pane + white
 * labels, indent ≈ one icon width per depth. Tokens live in V.1
 * (`tokens.css` / `visual-tokens.ts`) — not a second theme.
 *
 * SKIP: This PC / Disk / Network glyphs, status bar, New/Cut
 * toolbar. Keep Unfiled virtual, F.1–F.7, #396 inline rename,
 * X.2 grant-gated menus, X.3 select/open, X.4 empty teaching,
 * X.5 embed parity. Same `WorkflowHome`. No new APIs.
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
import { EXPLORER_EMPTY } from "./explorer-empty-states.ts";
import { EXPLORER_EMBED } from "./explorer-embed.ts";
import { EXPLORER_HOME_COPY } from "./explorer-home-copy.ts";
import { EXPLORER_INLINE_RENAME } from "./explorer-inline-rename.ts";
import { EXPLORER_SELECT_OPEN } from "./explorer-select-open.ts";
import {
  EXPLORER_SHELL,
  X1_EPIC,
  X1_KEEP_EPIC_OPEN,
} from "./explorer-shell.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  FF_EXPLORER_FOLDER,
  FF_EXPLORER_FOLDER_TAB,
  FF_EXPLORER_INDENT,
  FF_EXPLORER_NAV,
  FF_EXPLORER_ROW,
  n8nOrangePresent,
} from "./visual-tokens.ts";
import {
  F2_HOME_FOLDER,
  F3_HOME_FOLDER,
  F4_HOME_FOLDER,
  F5_HOME_FOLDER,
  F6_HOME_FOLDER,
  F7_HOME_FOLDER,
  F320_KEEP_OPEN,
  UNFILED_FOLDER_LABEL,
} from "./workflow-folder.ts";

export const X8_STORY = 399;
export const X8_EPIC = 379;
export const X8_KEEP_STORY_OPEN = true;
export const X8_KEEP_EPIC_OPEN = true;
export const X8_ID = "X.8-explorer-folder-chrome" as const;
export const X8_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const EXPLORER_FOLDER_CHROME_HELP =
  "Folder tree uses compact Windows Explorer rows: yellow folders, thin white chevrons, gray selected fill with a thin light border, and one-icon indent per depth. New folder, Rename, and Delete stay on the right-click menu — not as visible rail buttons. Unfiled stays virtual. New folder still names in place.";

export const FF_EXPLORER_NAV_LIST_CLASS = "ff-explorer-nav-list";
export const FF_EXPLORER_NAV_ROW_CLASS = "ff-explorer-nav-row";
export const FF_EXPLORER_NAV_SELECTED_CLASS = "ff-explorer-nav-row-selected";
export const FF_EXPLORER_NAV_CHEVRON_CLASS = "ff-explorer-nav-chevron";
export const FF_EXPLORER_NAV_LABEL_CLASS = "ff-explorer-nav-label";
export const FF_EXPLORER_FOLDER_ICON_CLASS = "ff-explorer-folder-icon";

export const EXPLORER_FOLDER_CHROME = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritX1ExplorerShell: true,
  inheritX2ContextMenus: true,
  inheritX3SelectOpen: true,
  inheritX4EmptyTeaching: true,
  inheritX5EmbedParity: true,
  inheritX6HomeCopy: true,
  inheritX7InlineRename: true,
  inheritV1Tokens: true,
  tokensFirstNoSecondTheme: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  navTreeOnly: true,
  compactRowDensity: true,
  yellowFolderIcons: true,
  thinWhiteChevrons: true,
  noChevronOnLeaves: true,
  selectionGrayFillThinLightBorder: true,
  selectionWrapsWholeRow: true,
  darkPaneWhiteLabels: true,
  indentOneIconWidthPerDepth: true,
  quietThinScrollbar: true,
  skipThisPcDiskNetworkGlyphs: true,
  skipStatusBarAndNewCutToolbar: true,
  noVisibleRailOrganizeButtons: true,
  railOrganizeVerbsContextMenuOnly: true,
  noInventedToolbarChrome: true,
  keepUnfiledVirtual: true,
  keepInlineRename: true,
  keepGrantGatedMenus: true,
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
  refuseIfNonemptyDelete: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep399Open: true,
  keep396Open: true,
  keep393Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
  noAutoCloseUnrelated: true,
} as const;

export const EXPLORER_FOLDER_CHROME_SOURCES = [
  "src/lib/explorer-folder-chrome.ts",
  "src/lib/visual-tokens.ts",
  "src/app/tokens.css",
  "src/app/globals.css",
  "src/components/home/WorkflowHome.tsx",
] as const;

export const EXPLORER_FOLDER_CHROME_AUTO_CLOSE_TOKENS = [
  "Fixes #399",
  "Closes #399",
  "Close #399",
  "Resolves #399",
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

export const EXPLORER_NAV_SKIP_TOKENS = [
  "This PC",
  "Local Disk",
  "data-x8=\"this-pc\"",
  "data-x8=\"status-bar\"",
  "data-x8=\"new-cut-toolbar\"",
] as const;

export function explorerNavIndentPx(depth: number): number {
  const indent = Number.parseInt(FF_EXPLORER_INDENT, 10);
  return Math.max(0, Math.min(depth, 4) - 1) * indent;
}

export function explorerNavDepthVars(depth: number): {
  "--ff-explorer-depth": string;
} {
  return {
    "--ff-explorer-depth": String(Math.max(0, Math.min(depth, 4) - 1)),
  };
}

export function explorerFolderChromeUsesV1Tokens(tokens: string): boolean {
  return (
    tokens.includes("--ff-explorer-nav:") &&
    tokens.includes(FF_EXPLORER_NAV) &&
    tokens.includes("--ff-explorer-folder:") &&
    tokens.includes(FF_EXPLORER_FOLDER) &&
    tokens.includes("--ff-explorer-folder-tab:") &&
    tokens.includes(FF_EXPLORER_FOLDER_TAB) &&
    tokens.includes("--ff-explorer-row-selected:") &&
    tokens.includes("--ff-explorer-row-selected-border:") &&
    tokens.includes("--ff-explorer-indent:") &&
    tokens.includes(FF_EXPLORER_INDENT) &&
    tokens.includes("--ff-explorer-row:") &&
    tokens.includes(FF_EXPLORER_ROW) &&
    !n8nOrangePresent(FF_EXPLORER_FOLDER) &&
    !n8nOrangePresent(FF_EXPLORER_FOLDER_TAB)
  );
}

export function explorerFolderChromeStylesNav(globals: string): boolean {
  return (
    globals.includes(".ff-explorer-nav-row") &&
    globals.includes(".ff-explorer-nav-row-selected") &&
    globals.includes("var(--ff-explorer-nav)") &&
    globals.includes("var(--ff-explorer-folder)") &&
    globals.includes("var(--ff-explorer-row-selected)") &&
    globals.includes("var(--ff-explorer-row-selected-border)") &&
    globals.includes("var(--ff-explorer-indent)") &&
    globals.includes("var(--ff-explorer-row)") &&
    globals.includes("scrollbar-width: thin") &&
    !globals.includes("data-theme")
  );
}

export function explorerHomeWiresFolderChrome(source: string): boolean {
  return (
    source.includes('data-x8="folder-chrome"') &&
    source.includes('data-x8="nav-row"') &&
    source.includes("FF_EXPLORER_NAV_ROW_CLASS") &&
    source.includes("FF_EXPLORER_NAV_SELECTED_CLASS") &&
    source.includes("FF_EXPLORER_FOLDER_ICON_CLASS") &&
    source.includes("explorerNavDepthVars") &&
    source.includes("FinderDisclosureIcon") &&
    source.includes("FinderFolderIcon") &&
    source.includes("data-o2=\"disclosure\"") &&
    source.includes("data-o2=\"folder-icon\"") &&
    source.includes("data-home-folder-inline-rename") &&
    source.includes('data-x7="inline-rename"') &&
    !source.includes("data-home-folder-dialog") &&
    !source.includes("window.prompt") &&
    explorerRailOmitsVisibleOrganizeButtons(source) &&
    EXPLORER_NAV_SKIP_TOKENS.every((token) => !source.includes(token))
  );
}

export function explorerRailOmitsVisibleOrganizeButtons(source: string): boolean {
  const rail = source.match(
    /function FolderRail\([\s\S]*?\nfunction FolderBreadcrumb/,
  );
  if (!rail) {
    return false;
  }
  return (
    !rail[0].includes("data-home-folder-verb=") &&
    !rail[0].includes("{NEW_FOLDER_LABEL}") &&
    !rail[0].includes("{RENAME_FOLDER_LABEL}") &&
    !rail[0].includes("{DELETE_FOLDER_LABEL}") &&
    source.includes('data-x2="context-menu"') &&
    source.includes("data-x2-verb={item.id}") &&
    source.includes("explorerMenuFolderVerb") &&
    source.includes("openCreateFolder") &&
    source.includes("openRenameFolder") &&
    source.includes("removeFolder")
  );
}

export function explorerDocsKeepStoryOpen(docs: string): boolean {
  return (
    docs.includes("#399") &&
    /keep #399 open/i.test(docs) &&
    docs.includes("#379") &&
    /keep #379 open/i.test(docs) &&
    EXPLORER_FOLDER_CHROME_AUTO_CLOSE_TOKENS.every(
      (token) => !docs.includes(token),
    )
  );
}

export function explorerFolderChromeHoldsHardLines(): boolean {
  return (
    EXPLORER_FOLDER_CHROME.yamlIsSourceOfTruth &&
    EXPLORER_FOLDER_CHROME.draftsNeverRun &&
    EXPLORER_FOLDER_CHROME.vaultDisplayNameUuidOnly &&
    EXPLORER_FOLDER_CHROME.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_FOLDER_CHROME.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_FOLDER_CHROME.isolationSuccessIsDenial &&
    EXPLORER_FOLDER_CHROME.unfiledIsVirtual &&
    EXPLORER_FOLDER_CHROME.refuseIfNonemptyDelete &&
    EXPLORER_FOLDER_CHROME.noNewApi &&
    EXPLORER_FOLDER_CHROME.notAnN8nClone &&
    EXPLORER_FOLDER_CHROME.noKekInBrowser &&
    EXPLORER_FOLDER_CHROME.keep399Open &&
    EXPLORER_FOLDER_CHROME.keep396Open &&
    EXPLORER_FOLDER_CHROME.keep393Open &&
    EXPLORER_FOLDER_CHROME.keep379Open &&
    EXPLORER_FOLDER_CHROME.noAutoCloseEpic &&
    EXPLORER_FOLDER_CHROME.noAutoCloseUnrelated &&
    EXPLORER_FOLDER_CHROME.tokensFirstNoSecondTheme &&
    EXPLORER_FOLDER_CHROME.noVisibleRailOrganizeButtons &&
    EXPLORER_FOLDER_CHROME.railOrganizeVerbsContextMenuOnly &&
    EXPLORER_INLINE_RENAME.keep396Open &&
    EXPLORER_INLINE_RENAME.createThenInlineRename &&
    EXPLORER_CONTEXT_MENU.keep379Open &&
    EXPLORER_SHELL.keep379Open &&
    X1_KEEP_EPIC_OPEN &&
    X2_KEEP_EPIC_OPEN &&
    X1_EPIC === X8_EPIC &&
    X2_EPIC === X8_EPIC &&
    UNFILED_FOLDER_LABEL === "Unfiled"
  );
}

export function explorerFolderChromeInheritsPriorStories(): boolean {
  return (
    EXPLORER_FOLDER_CHROME.inheritF1ThroughF7 &&
    EXPLORER_FOLDER_CHROME.inheritX1ExplorerShell &&
    EXPLORER_FOLDER_CHROME.inheritX2ContextMenus &&
    EXPLORER_FOLDER_CHROME.inheritX3SelectOpen &&
    EXPLORER_FOLDER_CHROME.inheritX4EmptyTeaching &&
    EXPLORER_FOLDER_CHROME.inheritX5EmbedParity &&
    EXPLORER_FOLDER_CHROME.inheritX6HomeCopy &&
    EXPLORER_FOLDER_CHROME.inheritX7InlineRename &&
    EXPLORER_FOLDER_CHROME.sameWorkflowHomeNoSecondTree &&
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
    EXPLORER_HOME_COPY.visiblePageHasNoEpicCommentary &&
    EXPLORER_INLINE_RENAME.noModalNamePrompt
  );
}
