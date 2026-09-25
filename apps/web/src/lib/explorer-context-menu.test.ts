import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_COLLAPSE_LABEL,
  EXPLORER_CONTEXT_AUTO_CLOSE_TOKENS,
  EXPLORER_CONTEXT_DEFERRED_TOKENS,
  EXPLORER_CONTEXT_MENU,
  EXPLORER_CONTEXT_MENU_SOURCES,
  EXPLORER_EXPAND_LABEL,
  EXPLORER_INVENTED_WORKFLOW_VERBS,
  EXPLORER_OPEN_LABEL,
  FF_EXPLORER_MENU_CLASS,
  FF_EXPLORER_MENU_ITEM_CLASS,
  X2_BRIEF,
  X2_EPIC,
  X2_ID,
  X2_KEEP_EPIC_OPEN,
  X2_KEEP_STORY_OPEN,
  X2_STORY,
  childFoldersForPane,
  explorerContextHoldsHardLines,
  explorerContextInheritsFolderStories,
  explorerDocsKeepEpicOpen,
  explorerEmptyPaneMenuItems,
  explorerFolderMenuItems,
  explorerHomeDismissesMenu,
  explorerHomeGrantGatesMenus,
  explorerHomeWiresExistingVerbs,
  explorerMenuFolderVerb,
  explorerMenuPosition,
  explorerMenuShowsMutateForViewer,
  explorerWorkflowMenuItems,
  visibleExplorerMenuItems,
} from "./explorer-context-menu.ts";
import {
  DELETE_FOLDER_LABEL,
  FOLDER_DEPTH_HELP,
  FOLDER_MOVE_VERB,
  FOLDER_NOT_EMPTY_HELP,
  NEW_FOLDER_LABEL,
  RENAME_FOLDER_LABEL,
  type WorkflowFolder,
} from "./workflow-folder.ts";
import { OVERVIEW_CREATE_LABEL } from "./overview-home.ts";
import { HOME_EMPTY_IMPORT_LABEL } from "./empty-states-teach-model.ts";

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

describe("X.2 Explorer context menus", () => {
  it("keeps #381 and #379 open and cites the folder IA", () => {
    assert.equal(X2_STORY, 381);
    assert.equal(X2_EPIC, 379);
    assert.equal(X2_KEEP_STORY_OPEN, true);
    assert.equal(X2_KEEP_EPIC_OPEN, true);
    assert.equal(X2_ID, "X.2-explorer-context-menus");
    assert.equal(X2_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_CONTEXT_MENU.keep381Open, true);
    assert.equal(EXPLORER_CONTEXT_MENU.keep379Open, true);
    assert.equal(EXPLORER_CONTEXT_MENU.noAutoCloseEpic, true);
    assert.equal(EXPLORER_CONTEXT_MENU.noJonnyChange, true);
    assert.equal(EXPLORER_CONTEXT_MENU.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepEpicOpen(frontend), true);
    assert.match(frontend, /right-click|context menu/i);
    for (const token of EXPLORER_CONTEXT_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
    }
  });

  it("builds a grant-gated folder menu and locks Unfiled plus refuse-if-nonempty", () => {
    const editor = visibleExplorerMenuItems(
      explorerFolderMenuItems({
        canMutate: true,
        isUnfiled: false,
        canCreateChild: true,
        deleteBlocked: false,
        canExpand: true,
        expanded: false,
      }),
    );
    assert.deepEqual(
      editor.map((item) => item.id),
      ["new-folder", "rename", "delete", "expand"],
    );
    assert.equal(editor[0]?.label, NEW_FOLDER_LABEL);
    assert.equal(editor[1]?.label, RENAME_FOLDER_LABEL);
    assert.equal(editor[2]?.label, DELETE_FOLDER_LABEL);
    assert.equal(editor[3]?.label, EXPLORER_EXPAND_LABEL);
    assert.equal(explorerMenuFolderVerb("new-folder"), "new");
    assert.equal(explorerMenuFolderVerb("rename"), "rename");
    assert.equal(explorerMenuFolderVerb("delete"), "delete");
    assert.equal(explorerMenuFolderVerb("expand"), undefined);

    const nonempty = explorerFolderMenuItems({
      canMutate: true,
      isUnfiled: false,
      canCreateChild: true,
      deleteBlocked: true,
      canExpand: false,
      expanded: false,
    });
    const deleteItem = nonempty.find((item) => item.id === "delete");
    assert.equal(deleteItem?.hidden, undefined);
    assert.equal(deleteItem?.disabled, true);
    assert.equal(deleteItem?.reason, FOLDER_NOT_EMPTY_HELP);

    const deep = explorerFolderMenuItems({
      canMutate: true,
      isUnfiled: false,
      canCreateChild: false,
      deleteBlocked: false,
      canExpand: true,
      expanded: true,
    });
    assert.equal(deep.find((item) => item.id === "new-folder")?.disabled, true);
    assert.equal(deep.find((item) => item.id === "new-folder")?.reason, FOLDER_DEPTH_HELP);
    assert.equal(deep.find((item) => item.id === "expand")?.label, EXPLORER_COLLAPSE_LABEL);

    const unfiled = visibleExplorerMenuItems(
      explorerFolderMenuItems({
        canMutate: true,
        isUnfiled: true,
        canCreateChild: true,
        deleteBlocked: true,
        canExpand: false,
        expanded: false,
      }),
    );
    assert.deepEqual(
      unfiled.map((item) => item.id),
      ["new-folder"],
    );

    const viewer = visibleExplorerMenuItems(
      explorerFolderMenuItems({
        canMutate: false,
        isUnfiled: false,
        canCreateChild: true,
        deleteBlocked: false,
        canExpand: true,
        expanded: false,
      }),
    );
    assert.deepEqual(
      viewer.map((item) => item.id),
      ["expand"],
    );
    assert.equal(
      explorerMenuShowsMutateForViewer(
        explorerFolderMenuItems({
          canMutate: false,
          isUnfiled: false,
          canCreateChild: true,
          deleteBlocked: false,
          canExpand: true,
          expanded: false,
        }),
        false,
      ),
      false,
    );
  });

  it("builds workflow and empty-pane menus from existing verbs only", () => {
    const editor = visibleExplorerMenuItems(
      explorerWorkflowMenuItems({ canMutate: true }),
    );
    assert.deepEqual(
      editor.map((item) => item.id),
      ["open", "move"],
    );
    assert.equal(editor[0]?.label, EXPLORER_OPEN_LABEL);
    assert.equal(editor[1]?.label, FOLDER_MOVE_VERB);

    const viewer = visibleExplorerMenuItems(
      explorerWorkflowMenuItems({ canMutate: false }),
    );
    assert.deepEqual(
      viewer.map((item) => item.id),
      ["open"],
    );
    assert.equal(
      explorerMenuShowsMutateForViewer(
        explorerWorkflowMenuItems({ canMutate: false }),
        false,
      ),
      false,
    );

    const invented = explorerWorkflowMenuItems({
      canMutate: true,
      canRenameWorkflow: true,
      canDeleteWorkflow: true,
    });
    assert.equal(EXPLORER_CONTEXT_MENU.workflowRenameOmittedNoApi, true);
    assert.equal(EXPLORER_CONTEXT_MENU.workflowDeleteOmittedNoApi, false);
    assert.equal(EXPLORER_CONTEXT_MENU.workflowDeleteCapabilityGated, true);
    assert.equal(
      visibleExplorerMenuItems(
        explorerWorkflowMenuItems({ canMutate: true }),
      ).some((item) => item.id === "rename" || item.id === "delete"),
      false,
    );
    assert.equal(
      invented.some((item) => item.id === "rename" && !item.hidden),
      true,
    );
    const deletable = visibleExplorerMenuItems(invented);
    assert.equal(
      deletable.some((item) => item.id === "delete" && item.label === "Delete workflow"),
      true,
    );
    const ownerViewer = visibleExplorerMenuItems(
      explorerWorkflowMenuItems({
        canMutate: false,
        canDeleteWorkflow: true,
      }),
    );
    assert.deepEqual(
      ownerViewer.map((item) => item.id),
      ["open", "delete"],
    );
    assert.equal(
      visibleExplorerMenuItems(
        explorerWorkflowMenuItems({
          canMutate: true,
          canDeleteWorkflow: false,
        }),
      ).some((item) => item.id === "delete"),
      false,
    );

    const empty = visibleExplorerMenuItems(
      explorerEmptyPaneMenuItems({
        canMutateFolders: true,
        canCreate: true,
        importExistsInHomeChrome: true,
      }),
    );
    assert.deepEqual(
      empty.map((item) => item.id),
      ["new-folder", "create-workflow", "import"],
    );
    assert.equal(empty[1]?.label, OVERVIEW_CREATE_LABEL);
    assert.equal(empty[2]?.label, HOME_EMPTY_IMPORT_LABEL);

    const emptyViewer = visibleExplorerMenuItems(
      explorerEmptyPaneMenuItems({
        canMutateFolders: false,
        canCreate: false,
        importExistsInHomeChrome: true,
      }),
    );
    assert.deepEqual(emptyViewer, []);

    const noImport = visibleExplorerMenuItems(
      explorerEmptyPaneMenuItems({
        canMutateFolders: true,
        canCreate: true,
        importExistsInHomeChrome: false,
      }),
    );
    assert.deepEqual(
      noImport.map((item) => item.id),
      ["new-folder", "create-workflow"],
    );
  });

  it("lists selected-folder children in the pane and clamps the menu", () => {
    assert.deepEqual(
      childFoldersForPane([ops, oncall], { kind: "folder", id: ops.id }).map(
        (folder) => folder.id,
      ),
      [oncall.id],
    );
    assert.deepEqual(
      childFoldersForPane([ops, oncall], { kind: "unfiled" }),
      [],
    );
    assert.deepEqual(
      childFoldersForPane([ops, oncall], { kind: "folder", id: ops.id }, {
        acrossSearch: true,
      }),
      [],
    );
    assert.deepEqual(
      explorerMenuPosition(
        900,
        700,
        { width: 200, height: 160 },
        { width: 1000, height: 800 },
      ),
      { left: 792, top: 632 },
    );
  });

  it("wires menus to existing handlers and skips invented APIs", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const page = source("src/app/workflows/page.tsx");
    const globals = source("src/app/globals.css");
    const lib = source("src/lib/explorer-context-menu.ts");
    assert.equal(explorerHomeWiresExistingVerbs(home), true);
    assert.equal(explorerHomeGrantGatesMenus(home), true);
    assert.equal(explorerHomeDismissesMenu(home), true);
    assert.match(home, /data-x2="context-menu"/);
    assert.match(home, /data-x2="pane-surface"/);
    assert.match(home, /data-x2="folder-row"/);
    assert.match(home, /onContextMenu/);
    assert.match(home, /openCreateFolder/);
    assert.match(home, /openRenameFolder/);
    assert.match(home, /removeFolder/);
    assert.match(home, /openMoveDialog/);
    assert.match(home, /moveWorkflowToFolder/);
    assert.match(home, /folderIdForMove/);
    assert.equal(FF_EXPLORER_MENU_CLASS, "ff-explorer-menu");
    assert.equal(FF_EXPLORER_MENU_ITEM_CLASS, "ff-explorer-menu-item");
    assert.match(globals, /\.ff-explorer-menu/);
    assert.match(globals, /var\(--ff-surface\)/);
    assert.match(globals, /var\(--ff-accent\)/);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.match(home, /data-x2="context-menu"/);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    for (const token of EXPLORER_INVENTED_WORKFLOW_VERBS) {
      assert.equal(home.includes(token), false, token);
    }
    assert.match(lib, /Paste is deferred/);
    assert.doesNotMatch(home, /data-x2="paste"/);
    assert.doesNotMatch(home, /data-x2="favorites"/);
    assert.doesNotMatch(home, /data-x2="tags-first"/);
    for (const token of EXPLORER_CONTEXT_DEFERRED_TOKENS) {
      assert.equal(home.includes(token) && token.startsWith("data-x2="), false, token);
    }
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.equal(EXPLORER_CONTEXT_MENU.usesExistingApisOnly, true);
    assert.equal(EXPLORER_CONTEXT_MENU.noClipboardPaste, true);
    assert.equal(EXPLORER_CONTEXT_MENU.importOnlyIfHomeChromeHasIt, true);
  });

  it("holds hard lines and inherits F.1–F.7 / X.1 keep-opens", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerContextHoldsHardLines(), true);
    assert.equal(explorerContextInheritsFolderStories(), true);
    assert.equal(EXPLORER_CONTEXT_MENU.yamlIsSourceOfTruth, true);
    assert.equal(EXPLORER_CONTEXT_MENU.draftsNeverRun, true);
    assert.equal(EXPLORER_CONTEXT_MENU.identityProxyAllowlistUnchanged, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of EXPLORER_CONTEXT_MENU_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
