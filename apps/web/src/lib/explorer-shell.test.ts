import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_AUTO_CLOSE_TOKENS,
  EXPLORER_HELP,
  EXPLORER_SHELL,
  EXPLORER_SHELL_SOURCES,
  FF_EXPLORER_CRUMB_CLASS,
  FF_EXPLORER_LAYOUT_CLASS,
  FF_EXPLORER_LIST_CLASS,
  FF_EXPLORER_PANE_CLASS,
  FF_EXPLORER_ROW_CLASS,
  FF_EXPLORER_SHELL_CLASS,
  FF_EXPLORER_TREE_CLASS,
  X1_BRIEF,
  X1_EPIC,
  X1_ID,
  X1_KEEP_EPIC_OPEN,
  X1_KEEP_STORY_OPEN,
  X1_STORY,
  explorerBreadcrumbFromAncestry,
  explorerBreadcrumbSegments,
  explorerCardsDemoted,
  explorerContentIsSelectedFolderOnly,
  explorerLayoutDoesNotClipOverlays,
  explorerDocsKeepEpicOpen,
  explorerHoldsHardLines,
  explorerInheritsFolderStories,
  explorerOrganizeVerbsStayReachable,
  explorerShellIsPrimary,
  explorerSkipsDeferredChrome,
  explorerTreeHasDisclosureAndUnfiled,
  explorerUnfiledBreadcrumbInventedId,
  explorerUnfiledIsVirtual,
} from "./explorer-shell.ts";
import {
  F320_KEEP_OPEN,
  F2_KEEP_STORY_OPEN,
  F6_KEEP_STORY_OPEN,
  UNFILED_FOLDER_ID,
  UNFILED_FOLDER_LABEL,
  type WorkflowFolder,
} from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
}

const ops: WorkflowFolder = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parentId: null,
  name: "Ops",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

const oncall: WorkflowFolder = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: ops.workspaceId,
  parentId: ops.id,
  name: "On-call",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

describe("X.1 Explorer shell", () => {
  it("keeps #380 and #379 open and cites the folder IA", () => {
    assert.equal(X1_STORY, 380);
    assert.equal(X1_EPIC, 379);
    assert.equal(X1_KEEP_STORY_OPEN, true);
    assert.equal(X1_KEEP_EPIC_OPEN, true);
    assert.equal(X1_ID, "X.1-explorer-shell");
    assert.equal(X1_BRIEF, "docs/internal/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_SHELL.keep380Open, true);
    assert.equal(EXPLORER_SHELL.keep379Open, true);
    assert.equal(EXPLORER_SHELL.noAutoCloseEpic, true);
    assert.equal(EXPLORER_SHELL.noJonnyChange, true);
    assert.equal(EXPLORER_SHELL.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepEpicOpen(frontend), true);
    assert.match(frontend, /Explorer shell/i);
    assert.match(EXPLORER_HELP, /Windows Explorer-style home/);
    assert.match(EXPLORER_HELP, /Drafts do not run/);
    for (const token of EXPLORER_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
    }
  });

  it("locks Explorer tree + content pane + breadcrumb as the default home", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const page = source("src/app/workflows/page.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(explorerShellIsPrimary(home), true);
    assert.equal(explorerTreeHasDisclosureAndUnfiled(home), true);
    assert.equal(explorerBreadcrumbFromAncestry(home), true);
    assert.equal(explorerCardsDemoted(home), true);
    assert.match(home, /data-x1="explorer-shell"/);
    assert.match(home, /data-x1="folder-tree"/);
    assert.match(home, /data-x1="content-pane"/);
    assert.match(home, /data-x1="breadcrumb"/);
    assert.match(home, /data-x1="content-list"/);
    assert.match(home, /FF_EXPLORER_SHELL_CLASS/);
    assert.match(home, /FF_EXPLORER_ROW_CLASS/);
    assert.equal(FF_EXPLORER_SHELL_CLASS, "ff-explorer-shell");
    assert.equal(FF_EXPLORER_LAYOUT_CLASS, "ff-explorer-layout");
    assert.equal(FF_EXPLORER_TREE_CLASS, "ff-explorer-tree");
    assert.equal(FF_EXPLORER_PANE_CLASS, "ff-explorer-pane");
    assert.equal(FF_EXPLORER_CRUMB_CLASS, "ff-explorer-crumb");
    assert.equal(FF_EXPLORER_ROW_CLASS, "ff-explorer-row");
    assert.equal(FF_EXPLORER_LIST_CLASS, "ff-explorer-list");
    assert.match(globals, /\.ff-explorer-shell/);
    assert.match(globals, /\.ff-explorer-layout/);
    assert.match(globals, /\.ff-explorer-tree/);
    assert.match(globals, /\.ff-explorer-pane/);
    assert.match(globals, /\.ff-explorer-crumb/);
    assert.equal(explorerLayoutDoesNotClipOverlays(globals), true);
    assert.match(globals, /var\(--ff-surface\)/);
    assert.match(globals, /var\(--ff-accent\)/);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    assert.equal(EXPLORER_SHELL.explorerIsDefaultHome, true);
    assert.equal(EXPLORER_SHELL.treePlusContentPlusBreadcrumb, true);
    assert.equal(EXPLORER_SHELL.cardsDemotedFromPrimary, true);
    assert.equal(EXPLORER_SHELL.denseListRowsOk, true);
    assert.equal(home.includes('setView("list")'), false);
    assert.equal(home.includes("data-home-view"), false);
  });

  it("selects a folder in the tree and lists that folder only", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerContentIsSelectedFolderOnly(home), true);
    assert.match(home, /selectedFolderListFolderId/);
    assert.match(home, /constrainItemsToFolderSelection/);
    assert.match(home, /folderHomeListMode/);
    assert.match(home, /intendedFolderSelectionFromUrl/);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.equal(EXPLORER_SHELL.contentPaneSelectedFolderOnly, true);
    assert.equal(EXPLORER_SHELL.nonRecursiveFolderIdStays, true);
    assert.equal(F2_KEEP_STORY_OPEN, true);
    assert.equal(F6_KEEP_STORY_OPEN, true);
    assert.equal(F320_KEEP_OPEN, true);
  });

  it("keeps Unfiled virtual and breadcrumb from ancestry", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const crumbs = explorerBreadcrumbSegments([ops, oncall], {
      kind: "folder",
      id: oncall.id,
    });
    assert.deepEqual(
      crumbs.map((crumb) => crumb.label),
      ["Ops", "On-call"],
    );
    const unfiled = explorerBreadcrumbSegments([], { kind: "unfiled" });
    assert.deepEqual(unfiled, [
      { selection: { kind: "unfiled" }, label: UNFILED_FOLDER_LABEL },
    ]);
    assert.equal(explorerUnfiledBreadcrumbInventedId(unfiled), false);
    assert.equal(UNFILED_FOLDER_ID, "unfiled");
    assert.equal(explorerUnfiledIsVirtual(home), true);
    assert.equal(explorerBreadcrumbFromAncestry(home), true);
    assert.equal(EXPLORER_SHELL.unfiledIsVirtual, true);
    assert.equal(EXPLORER_SHELL.unfiledBreadcrumbIsVirtual, true);
    assert.equal(EXPLORER_SHELL.breadcrumbFromAncestry, true);
  });

  it("keeps create / rename / delete / move reachable and skips later X slices", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerOrganizeVerbsStayReachable(home), true);
    assert.equal(explorerSkipsDeferredChrome(home), true);
    assert.match(home, /data-home-folder-verb=\{explorerMenuFolderVerb/);
    assert.match(home, /data-home-workflow-verb="move"/);
    assert.match(home, /moveWorkflowToFolder/);
    assert.doesNotMatch(home, /data-miller|Miller columns/);
    assert.doesNotMatch(home, /data-x1="favorites"|data-x1="tags-first"/);
    assert.equal(EXPLORER_SHELL.noRightClickMenusThisStory, true);
    assert.equal(EXPLORER_SHELL.noViewToggleThisStory, true);
    assert.equal(EXPLORER_SHELL.noMillerColumns, true);
    assert.equal(EXPLORER_SHELL.notFinderPrimary, true);
  });

  it("holds hard lines and inherits F.1–F.7 / O keep-opens", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerHoldsHardLines(), true);
    assert.equal(explorerInheritsFolderStories(), true);
    assert.equal(EXPLORER_SHELL.yamlIsSourceOfTruth, true);
    assert.equal(EXPLORER_SHELL.draftsNeverRun, true);
    assert.equal(EXPLORER_SHELL.identityProxyAllowlistUnchanged, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of EXPLORER_SHELL_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
