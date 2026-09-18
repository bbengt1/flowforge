import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_FOLDER_CHROME,
  EXPLORER_FOLDER_CHROME_AUTO_CLOSE_TOKENS,
  EXPLORER_FOLDER_CHROME_HELP,
  EXPLORER_FOLDER_CHROME_SOURCES,
  EXPLORER_NAV_SKIP_TOKENS,
  FF_EXPLORER_FOLDER_ICON_CLASS,
  FF_EXPLORER_NAV_CHEVRON_CLASS,
  FF_EXPLORER_NAV_LABEL_CLASS,
  FF_EXPLORER_NAV_LIST_CLASS,
  FF_EXPLORER_NAV_ROW_CLASS,
  FF_EXPLORER_NAV_SELECTED_CLASS,
  X8_BRIEF,
  X8_EPIC,
  X8_ID,
  X8_KEEP_EPIC_OPEN,
  X8_KEEP_STORY_OPEN,
  X8_STORY,
  explorerDocsKeepStoryOpen,
  explorerFolderChromeHoldsHardLines,
  explorerFolderChromeInheritsPriorStories,
  explorerFolderChromeStylesNav,
  explorerFolderChromeUsesV1Tokens,
  explorerHomeWiresFolderChrome,
  explorerNavDepthVars,
  explorerNavIndentPx,
  explorerRailOmitsVisibleOrganizeButtons,
} from "./explorer-folder-chrome.ts";
import { EXPLORER_INLINE_RENAME } from "./explorer-inline-rename.ts";
import { EXPLORER_CONTEXT_MENU } from "./explorer-context-menu.ts";
import { EXPLORER_EMBED } from "./explorer-embed.ts";
import {
  FF_ACCENT,
  FF_EXPLORER_FOLDER,
  FF_EXPLORER_FOLDER_TAB,
  FF_EXPLORER_INDENT,
  FF_EXPLORER_NAV,
  FF_EXPLORER_ROW,
  FF_TEXT,
  contrastHolds,
  huesAreDistinct,
  n8nOrangePresent,
} from "./visual-tokens.ts";
import { UNFILED_FOLDER_LABEL } from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
}

describe("X.8 Explorer folder chrome", () => {
  it("keeps #399 open and cites the folder IA", () => {
    assert.equal(X8_STORY, 399);
    assert.equal(X8_EPIC, 379);
    assert.equal(X8_KEEP_STORY_OPEN, true);
    assert.equal(X8_KEEP_EPIC_OPEN, true);
    assert.equal(X8_ID, "X.8-explorer-folder-chrome");
    assert.equal(X8_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_FOLDER_CHROME.keep399Open, true);
    assert.equal(EXPLORER_FOLDER_CHROME.keep396Open, true);
    assert.equal(EXPLORER_FOLDER_CHROME.keep393Open, true);
    assert.equal(EXPLORER_FOLDER_CHROME.keep379Open, true);
    assert.equal(EXPLORER_FOLDER_CHROME.noAutoCloseEpic, true);
    assert.equal(EXPLORER_FOLDER_CHROME.noAutoCloseUnrelated, true);
    assert.equal(EXPLORER_FOLDER_CHROME.noJonnyChange, true);
    assert.equal(EXPLORER_FOLDER_CHROME.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepStoryOpen(frontend), true);
    assert.match(frontend, /yellow folder|Explorer folder chrome|Win11|Windows Explorer nav/i);
    const brief = repoSource(X8_BRIEF);
    assert.equal(explorerDocsKeepStoryOpen(brief), true);
    assert.match(brief, /X\.8/);
    for (const token of EXPLORER_FOLDER_CHROME_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
      assert.equal(brief.includes(token), false, token);
    }
  });

  it("maps nav chrome into V.1 tokens, not a second theme", () => {
    const tokens = source("src/app/tokens.css");
    const globals = source("src/app/globals.css");
    assert.equal(explorerFolderChromeUsesV1Tokens(tokens), true);
    assert.equal(explorerFolderChromeStylesNav(globals), true);
    assert.equal(FF_EXPLORER_NAV, "#1a1d24");
    assert.equal(FF_EXPLORER_FOLDER, "#e8c04a");
    assert.equal(FF_EXPLORER_FOLDER_TAB, "#d4a017");
    assert.equal(FF_EXPLORER_INDENT, "16px");
    assert.equal(FF_EXPLORER_ROW, "24px");
    assert.match(tokens, new RegExp(`--ff-explorer-nav:\\s*${FF_EXPLORER_NAV}`));
    assert.match(tokens, new RegExp(`--ff-explorer-folder:\\s*${FF_EXPLORER_FOLDER}`));
    assert.match(tokens, new RegExp(`--ff-explorer-indent:\\s*${FF_EXPLORER_INDENT}`));
    assert.match(tokens, new RegExp(`--ff-explorer-row:\\s*${FF_EXPLORER_ROW}`));
    assert.equal(n8nOrangePresent(FF_EXPLORER_FOLDER), false);
    assert.equal(n8nOrangePresent(FF_EXPLORER_FOLDER_TAB), false);
    assert.equal(huesAreDistinct(FF_EXPLORER_FOLDER, FF_ACCENT), true);
    assert.equal(contrastHolds(FF_TEXT, FF_EXPLORER_NAV), true);
    assert.equal(EXPLORER_FOLDER_CHROME.inheritV1Tokens, true);
    assert.equal(EXPLORER_FOLDER_CHROME.tokensFirstNoSecondTheme, true);
    assert.doesNotMatch(tokens, /\[data-theme=/);
    assert.doesNotMatch(globals, /embed-tokens|tokens-embed|tokens-light/);
  });

  it("indents one icon width per depth and caps at four levels", () => {
    assert.equal(explorerNavIndentPx(1), 0);
    assert.equal(explorerNavIndentPx(2), 16);
    assert.equal(explorerNavIndentPx(3), 32);
    assert.equal(explorerNavIndentPx(4), 48);
    assert.equal(explorerNavIndentPx(5), 48);
    assert.deepEqual(explorerNavDepthVars(1), { "--ff-explorer-depth": "0" });
    assert.deepEqual(explorerNavDepthVars(3), { "--ff-explorer-depth": "2" });
    assert.deepEqual(explorerNavDepthVars(9), { "--ff-explorer-depth": "3" });
  });

  it("wires compact nav rows, yellow folders, and whole-row selection", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(explorerHomeWiresFolderChrome(home), true);
    assert.equal(FF_EXPLORER_NAV_LIST_CLASS, "ff-explorer-nav-list");
    assert.equal(FF_EXPLORER_NAV_ROW_CLASS, "ff-explorer-nav-row");
    assert.equal(FF_EXPLORER_NAV_SELECTED_CLASS, "ff-explorer-nav-row-selected");
    assert.equal(FF_EXPLORER_NAV_CHEVRON_CLASS, "ff-explorer-nav-chevron");
    assert.equal(FF_EXPLORER_NAV_LABEL_CLASS, "ff-explorer-nav-label");
    assert.equal(FF_EXPLORER_FOLDER_ICON_CLASS, "ff-explorer-folder-icon");
    assert.match(home, /data-x8="folder-chrome"/);
    assert.match(home, /data-x8="nav-row"/);
    assert.match(home, /FF_EXPLORER_NAV_SELECTED_CLASS/);
    assert.match(home, /FF_EXPLORER_FOLDER_ICON_CLASS/);
    assert.match(home, /explorerNavDepthVars/);
    assert.match(home, /data-o2="disclosure"/);
    assert.match(home, /data-o2="folder-icon"/);
    assert.match(globals, /\.ff-explorer-nav-row-selected/);
    assert.match(globals, /var\(--ff-explorer-folder\)/);
    assert.match(globals, /var\(--ff-explorer-row-selected-border\)/);
    assert.match(globals, /scrollbar-width:\s*thin/);
    assert.match(EXPLORER_FOLDER_CHROME_HELP, /yellow folders/i);
    assert.match(EXPLORER_FOLDER_CHROME_HELP, /thin white chevrons/i);
    assert.match(EXPLORER_FOLDER_CHROME_HELP, /gray selected fill/i);
    assert.match(EXPLORER_FOLDER_CHROME_HELP, /right-click menu/i);
    assert.equal(EXPLORER_FOLDER_CHROME.compactRowDensity, true);
    assert.equal(EXPLORER_FOLDER_CHROME.yellowFolderIcons, true);
    assert.equal(EXPLORER_FOLDER_CHROME.thinWhiteChevrons, true);
    assert.equal(EXPLORER_FOLDER_CHROME.noChevronOnLeaves, true);
    assert.equal(EXPLORER_FOLDER_CHROME.selectionGrayFillThinLightBorder, true);
    assert.equal(EXPLORER_FOLDER_CHROME.selectionWrapsWholeRow, true);
    assert.equal(EXPLORER_FOLDER_CHROME.indentOneIconWidthPerDepth, true);
    for (const token of EXPLORER_NAV_SKIP_TOKENS) {
      assert.equal(home.includes(token), false, token);
    }
  });

  it("keeps #396 inline rename, grant-gated menus, and Unfiled virtual", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(EXPLORER_INLINE_RENAME.createThenInlineRename, true);
    assert.equal(EXPLORER_INLINE_RENAME.noModalNamePrompt, true);
    assert.equal(EXPLORER_INLINE_RENAME.unfiledCannotRename, true);
    assert.equal(EXPLORER_CONTEXT_MENU.folderMenuNewRenameDeleteExpand, true);
    assert.equal(EXPLORER_CONTEXT_MENU.unfiledNotDestructivelyMutable, true);
    assert.equal(EXPLORER_FOLDER_CHROME.keepInlineRename, true);
    assert.equal(EXPLORER_FOLDER_CHROME.keepGrantGatedMenus, true);
    assert.equal(EXPLORER_FOLDER_CHROME.keepUnfiledVirtual, true);
    assert.match(home, /data-home-folder-inline-rename/);
    assert.match(home, /data-x7="inline-rename"/);
    assert.match(home, /data-home-folder-rail="unfiled"/);
    assert.match(home, /UNFILED_FOLDER_LABEL/);
    assert.match(home, /data-x2="context-menu"/);
    assert.equal(explorerRailOmitsVisibleOrganizeButtons(home), true);
    assert.equal(EXPLORER_FOLDER_CHROME.noVisibleRailOrganizeButtons, true);
    assert.equal(EXPLORER_FOLDER_CHROME.railOrganizeVerbsContextMenuOnly, true);
    assert.equal(EXPLORER_FOLDER_CHROME.noInventedToolbarChrome, true);
    assert.match(home, /explorerMenuFolderVerb/);
    assert.match(home, /data-home-folder-verb=\{explorerMenuFolderVerb/);
    assert.doesNotMatch(home, /data-home-folder-dialog/);
    assert.doesNotMatch(home, /window\.prompt/);
    assert.equal(UNFILED_FOLDER_LABEL, "Unfiled");
  });

  it("holds hard lines and inherits X.1–X.7 / F.1–F.7", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerFolderChromeHoldsHardLines(), true);
    assert.equal(explorerFolderChromeInheritsPriorStories(), true);
    assert.equal(EXPLORER_FOLDER_CHROME.inheritX7InlineRename, true);
    assert.equal(EXPLORER_FOLDER_CHROME.sameWorkflowHomeNoSecondTree, true);
    assert.equal(EXPLORER_EMBED.sameWorkflowHomeNoSecondTree, true);
    assert.equal(EXPLORER_FOLDER_CHROME.adv021ChromeFromSessionEmbedOnly, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    assert.doesNotMatch(home, /#e8c04a|#d4a017|#1a1d24/);
    for (const path of EXPLORER_FOLDER_CHROME_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
