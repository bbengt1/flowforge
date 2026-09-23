import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_DRAFTS_DO_NOT_RUN,
  EXPLORER_EMPTY,
  EXPLORER_EMPTY_AUTO_CLOSE_TOKENS,
  EXPLORER_EMPTY_HELP,
  EXPLORER_EMPTY_PANE_HINT,
  EXPLORER_EMPTY_SOURCES,
  EXPLORER_FOLDER_TEACH,
  EXPLORER_UNFILED_FILED_TEACH,
  EXPLORER_UNFILED_TEACH,
  EXPLORER_UNFILED_VIRTUAL_LABEL,
  FF_EXPLORER_DRAFTS_BANNER_CLASS,
  FF_EXPLORER_EMPTY_CLASS,
  FF_EXPLORER_EMPTY_FOLDER_CLASS,
  FF_EXPLORER_EMPTY_UNFILED_CLASS,
  FF_EXPLORER_VIRTUAL_CHIP_CLASS,
  X4_BRIEF,
  X4_EPIC,
  X4_ID,
  X4_KEEP_EPIC_OPEN,
  X4_KEEP_STORY_OPEN,
  X4_STORY,
  explorerDocsKeepEpicOpen,
  explorerEmptyDifferentiatesFolderAndUnfiled,
  explorerEmptyHoldsHardLines,
  explorerEmptyInheritsPriorStories,
  explorerEmptyIsVirtualUnfiled,
  explorerEmptyKeepsDraftsLoud,
  explorerEmptyKeepsUnfiledVirtual,
  explorerEmptyKeepsX2EmptyPaneMenu,
  explorerEmptyKindFromFolderHome,
  explorerEmptyShowsDeveloperFixtures,
  explorerEmptyShowsDraftsBanner,
  explorerEmptyShowsFolderDelete,
  explorerEmptyTeachCopy,
  explorerEmptyTeachesCreateMove,
  explorerEmptyUsesExplorerChrome,
} from "./explorer-empty-states.ts";
import { FOLDER_UNFILED_LOCKED_HELP } from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
}

describe("X.4 Explorer empty / Unfiled teaching", () => {
  it("keeps #383 and #379 open and cites the folder IA", () => {
    assert.equal(X4_STORY, 383);
    assert.equal(X4_EPIC, 379);
    assert.equal(X4_KEEP_STORY_OPEN, true);
    assert.equal(X4_KEEP_EPIC_OPEN, true);
    assert.equal(X4_ID, "X.4-explorer-empty-unfiled-teaching");
    assert.equal(X4_BRIEF, "docs/internal/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_EMPTY.keep383Open, true);
    assert.equal(EXPLORER_EMPTY.keep379Open, true);
    assert.equal(EXPLORER_EMPTY.noAutoCloseEpic, true);
    assert.equal(EXPLORER_EMPTY.noJonnyChange, true);
    assert.equal(EXPLORER_EMPTY.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepEpicOpen(frontend), true);
    assert.match(frontend, /empty folder|Unfiled/i);
    assert.match(EXPLORER_EMPTY_HELP, /Drafts do not run/);
    assert.match(EXPLORER_EMPTY_HELP, /virtual/i);
    for (const token of EXPLORER_EMPTY_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
    }
  });

  it("maps folder-home empty kinds onto distinct Explorer teaching states", () => {
    assert.equal(
      explorerEmptyKindFromFolderHome("teach", false),
      "home",
    );
    assert.equal(
      explorerEmptyKindFromFolderHome("folder", false),
      "folder",
    );
    assert.equal(
      explorerEmptyKindFromFolderHome("unfiled", true),
      "unfiled-none",
    );
    assert.equal(
      explorerEmptyKindFromFolderHome("unfiled", false),
      "unfiled-filed",
    );
    assert.equal(
      explorerEmptyKindFromFolderHome("filtered", false),
      "filtered",
    );
    assert.equal(explorerEmptyKindFromFolderHome("populated", false), null);
    assert.equal(explorerEmptyShowsDraftsBanner("home"), true);
    assert.equal(explorerEmptyShowsDraftsBanner("folder"), true);
    assert.equal(explorerEmptyShowsDraftsBanner("unfiled-none"), true);
    assert.equal(explorerEmptyShowsDraftsBanner("unfiled-filed"), false);
    assert.equal(explorerEmptyIsVirtualUnfiled("unfiled-none"), true);
    assert.equal(explorerEmptyIsVirtualUnfiled("unfiled-filed"), true);
    assert.equal(explorerEmptyIsVirtualUnfiled("folder"), false);
    assert.equal(explorerEmptyShowsFolderDelete("folder"), true);
    assert.equal(explorerEmptyShowsFolderDelete("unfiled-none"), false);
    assert.equal(explorerEmptyTeachesCreateMove("folder"), true);
    assert.equal(explorerEmptyTeachesCreateMove("unfiled-none"), true);
    assert.equal(explorerEmptyTeachesCreateMove("unfiled-filed"), false);
    assert.equal(explorerEmptyTeachCopy("folder"), EXPLORER_FOLDER_TEACH);
    assert.equal(explorerEmptyTeachCopy("unfiled-none"), EXPLORER_UNFILED_TEACH);
    assert.equal(
      explorerEmptyTeachCopy("unfiled-filed"),
      EXPLORER_UNFILED_FILED_TEACH,
    );
    assert.match(EXPLORER_FOLDER_TEACH, /real folder/i);
    assert.match(EXPLORER_FOLDER_TEACH, /move/i);
    assert.match(EXPLORER_UNFILED_TEACH, /cannot rename or delete/i);
    assert.match(EXPLORER_UNFILED_VIRTUAL_LABEL, /virtual/i);
    assert.match(FOLDER_UNFILED_LOCKED_HELP, /virtual/i);
    assert.match(EXPLORER_EMPTY_PANE_HINT, /Right-click this pane/);
    assert.equal(FF_EXPLORER_EMPTY_CLASS, "ff-explorer-empty");
    assert.equal(FF_EXPLORER_EMPTY_FOLDER_CLASS, "ff-explorer-empty-folder");
    assert.equal(FF_EXPLORER_EMPTY_UNFILED_CLASS, "ff-explorer-empty-unfiled");
    assert.equal(FF_EXPLORER_VIRTUAL_CHIP_CLASS, "ff-explorer-virtual-chip");
    assert.match(FF_EXPLORER_DRAFTS_BANNER_CLASS, /ff-loud-warning/);
    assert.match(EXPLORER_DRAFTS_DO_NOT_RUN, /Drafts do not run/);
  });

  it("lands empty folder vs empty Unfiled teaching on Explorer chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const page = source("src/app/workflows/page.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(explorerEmptyUsesExplorerChrome(home), true);
    assert.equal(explorerEmptyDifferentiatesFolderAndUnfiled(home), true);
    assert.equal(explorerEmptyKeepsUnfiledVirtual(home), true);
    assert.equal(explorerEmptyKeepsDraftsLoud(home), true);
    assert.equal(explorerEmptyKeepsX2EmptyPaneMenu(home), true);
    assert.match(home, /data-x4="pane-surface"/);
    assert.match(home, /data-x4="empty-home"/);
    assert.match(home, /data-x4="empty-folder"/);
    assert.match(home, /data-x4="empty-unfiled"/);
    assert.match(home, /data-x4="drafts-do-not-run"/);
    assert.match(home, /data-x2="pane-surface"/);
    assert.match(home, /EXPLORER_UNFILED_VIRTUAL_LABEL/);
    assert.match(home, /FOLDER_UNFILED_LOCKED_HELP/);
    assert.match(globals, /\.ff-explorer-empty/);
    assert.match(globals, /\.ff-explorer-empty-folder/);
    assert.match(globals, /\.ff-explorer-empty-unfiled/);
    assert.match(globals, /\.ff-explorer-virtual-chip/);
    assert.match(globals, /\.ff-explorer-drafts-banner/);
    assert.match(globals, /var\(--ff-accent\)/);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.match(EXPLORER_EMPTY_HELP, /Empty folder and empty Unfiled/);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.doesNotMatch(home, /data-x4="favorites"|data-x4="tags-first"/);
    assert.doesNotMatch(home, /data-miller|Miller columns/);
    assert.doesNotMatch(home, /border-dashed/);
    assert.equal(EXPLORER_EMPTY.emptyFolderDiffersFromEmptyUnfiled, true);
    assert.equal(EXPLORER_EMPTY.unfiledNeverLooksDeletableOrRenamable, true);
    assert.equal(EXPLORER_EMPTY.draftsDoNotRunStaysLoud, true);
    assert.equal(EXPLORER_EMPTY.emptyPaneKeepsX2ContextMenu, true);
  });

  it("keeps F.5 / O.3 verbs and does not promote Developer fixtures", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerEmptyShowsDeveloperFixtures(home), false);
    assert.equal(home.includes("Load starter YAML"), false);
    assert.equal(home.includes("Load invalid YAML"), false);
    assert.match(home, /data-uxl6="home-empty"/);
    assert.match(home, /data-f5="folder-empty"/);
    assert.match(home, /data-f5="unfiled-empty-filed"/);
    assert.match(home, /data-home-empty-verb="new-folder"/);
    assert.match(home, /data-home-folder-empty-verb="create"/);
    assert.match(home, /data-home-folder-empty-verb="move"/);
    assert.match(home, /data-home-folder-empty-verb="delete"/);
    assert.match(home, /HOME_EMPTY_CREATE_LABEL/);
    assert.match(home, /HOME_EMPTY_IMPORT_LABEL/);
    assert.match(home, /explorerEmptyPaneMenuItems/);
    assert.equal(EXPLORER_EMPTY.inheritF5EmptyVerbs, true);
    assert.equal(EXPLORER_EMPTY.inheritO3Teaching, true);
    assert.equal(EXPLORER_EMPTY.noDeveloperFixtures, true);
  });

  it("holds hard lines and inherits X.1–X.3 / F.1–F.7 keep-opens", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerEmptyHoldsHardLines(), true);
    assert.equal(explorerEmptyInheritsPriorStories(), true);
    assert.equal(EXPLORER_EMPTY.yamlIsSourceOfTruth, true);
    assert.equal(EXPLORER_EMPTY.draftsNeverRun, true);
    assert.equal(EXPLORER_EMPTY.identityProxyAllowlistUnchanged, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of EXPLORER_EMPTY_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
