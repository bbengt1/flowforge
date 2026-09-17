import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_SELECT_AUTO_CLOSE_TOKENS,
  EXPLORER_SELECT_HELP,
  EXPLORER_SELECT_OPEN,
  EXPLORER_SELECT_OPEN_SOURCES,
  FF_EXPLORER_ROW_SELECTED_CLASS,
  X3_BRIEF,
  X3_EPIC,
  X3_ID,
  X3_KEEP_EPIC_OPEN,
  X3_KEEP_STORY_OPEN,
  X3_STORY,
  explorerAdvancePaneSelection,
  explorerDocsKeepEpicOpen,
  explorerExpandIdsForOpenFolder,
  explorerHomeNameDoesNotNavigateOnSingleClick,
  explorerHomeSelectsOnContextMenu,
  explorerHomeWiresSelectOpen,
  explorerOpenKind,
  explorerPaneRowEquals,
  explorerPaneRowKey,
  explorerPaneRows,
  explorerPaneSelectionStillVisible,
  explorerSelectHoldsHardLines,
  explorerSelectInheritsFolderStories,
} from "./explorer-select-open.ts";
import {
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

describe("X.3 Explorer select/open", () => {
  it("keeps #382 and #379 open and cites the folder IA", () => {
    assert.equal(X3_STORY, 382);
    assert.equal(X3_EPIC, 379);
    assert.equal(X3_KEEP_STORY_OPEN, true);
    assert.equal(X3_KEEP_EPIC_OPEN, true);
    assert.equal(X3_ID, "X.3-explorer-select-open");
    assert.equal(X3_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_SELECT_OPEN.keep382Open, true);
    assert.equal(EXPLORER_SELECT_OPEN.keep379Open, true);
    assert.equal(EXPLORER_SELECT_OPEN.noAutoCloseEpic, true);
    assert.equal(EXPLORER_SELECT_OPEN.noJonnyChange, true);
    assert.equal(EXPLORER_SELECT_OPEN.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepEpicOpen(frontend), true);
    assert.match(frontend, /single-click|select\/open|double-click/i);
    assert.match(EXPLORER_SELECT_HELP, /Single-click selects/);
    assert.match(EXPLORER_SELECT_HELP, /Double-click or Enter/);
    for (const token of EXPLORER_SELECT_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
    }
  });

  it("orders pane rows and opens workflow vs folder", () => {
    const rows = explorerPaneRows([{ id: ops.id }, { id: oncall.id }], [
      { id: "wf-1" },
      { id: "wf-2" },
    ]);
    assert.deepEqual(rows, [
      { kind: "folder", id: ops.id },
      { kind: "folder", id: oncall.id },
      { kind: "workflow", id: "wf-1" },
      { kind: "workflow", id: "wf-2" },
    ]);
    assert.equal(explorerPaneRowKey(rows[0]!), `folder:${ops.id}`);
    assert.equal(explorerOpenKind(rows[0]!), "navigate-folder");
    assert.equal(explorerOpenKind(rows[2]!), "editor");
    assert.equal(
      explorerPaneRowEquals(rows[2]!, { kind: "workflow", id: "wf-1" }),
      true,
    );
    assert.equal(
      explorerPaneSelectionStillVisible(rows, { kind: "workflow", id: "wf-2" }),
      true,
    );
    assert.equal(
      explorerPaneSelectionStillVisible(rows, { kind: "workflow", id: "gone" }),
      false,
    );
    assert.equal(explorerPaneSelectionStillVisible(rows, null), true);
  });

  it("moves highlight with arrows and expands a folder on open", () => {
    const rows = explorerPaneRows([{ id: ops.id }], [{ id: "wf-1" }]);
    assert.deepEqual(
      explorerAdvancePaneSelection(rows, null, "next"),
      { kind: "folder", id: ops.id },
    );
    assert.deepEqual(
      explorerAdvancePaneSelection(rows, null, "prev"),
      { kind: "workflow", id: "wf-1" },
    );
    assert.deepEqual(
      explorerAdvancePaneSelection(
        rows,
        { kind: "folder", id: ops.id },
        "next",
      ),
      { kind: "workflow", id: "wf-1" },
    );
    assert.deepEqual(
      explorerAdvancePaneSelection(
        rows,
        { kind: "workflow", id: "wf-1" },
        "next",
      ),
      { kind: "workflow", id: "wf-1" },
    );
    assert.deepEqual(
      explorerAdvancePaneSelection(
        rows,
        { kind: "workflow", id: "wf-1" },
        "prev",
      ),
      { kind: "folder", id: ops.id },
    );
    assert.deepEqual(explorerAdvancePaneSelection([], null, "next"), null);
    const expanded = explorerExpandIdsForOpenFolder([ops, oncall], oncall.id);
    assert.equal(expanded.includes(oncall.id), true);
    assert.equal(expanded.includes(ops.id), true);
    assert.equal(UNFILED_FOLDER_LABEL, "Unfiled");
  });

  it("wires single-click select, double-click/Enter open, and X.2 menus", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const page = source("src/app/workflows/page.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(explorerHomeWiresSelectOpen(home), true);
    assert.equal(explorerHomeSelectsOnContextMenu(home), true);
    assert.equal(explorerHomeNameDoesNotNavigateOnSingleClick(home), true);
    assert.match(home, /data-x3="select-open"/);
    assert.match(home, /data-x3="pane-list"/);
    assert.match(home, /data-x3="pane-row"/);
    assert.match(home, /onDoubleClick/);
    assert.match(home, /event.key === "Enter"/);
    assert.match(home, /ArrowDown/);
    assert.match(home, /setPaneSelection/);
    assert.match(home, /workflowEditorHref/);
    assert.match(home, /data-x2="context-menu"/);
    assert.match(home, /data-x2="content-row"/);
    assert.match(home, /onContextMenu/);
    assert.equal(FF_EXPLORER_ROW_SELECTED_CLASS, "ff-explorer-row-selected");
    assert.match(globals, /\.ff-explorer-row-selected/);
    assert.match(globals, /var\(--ff-accent\)/);
    assert.match(globals, /var\(--ff-canvas\)/);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.match(EXPLORER_SELECT_HELP, /Single-click selects/);
    assert.match(EXPLORER_SELECT_HELP, /Double-click or Enter/);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.doesNotMatch(home, /data-x3="multi-select"/);
    assert.doesNotMatch(home, /data-x3="favorites"|data-x3="tags-first"/);
    assert.doesNotMatch(home, /data-miller|Miller columns/);
    assert.equal(EXPLORER_SELECT_OPEN.singleClickSelectsWithoutNavigate, true);
    assert.equal(EXPLORER_SELECT_OPEN.doubleClickOrEnterOpens, true);
    assert.equal(EXPLORER_SELECT_OPEN.rightClickSelectsTarget, true);
    assert.equal(EXPLORER_SELECT_OPEN.enterOpensSelection, true);
    assert.equal(EXPLORER_SELECT_OPEN.inheritX2ContextMenus, true);
    assert.equal(EXPLORER_SELECT_OPEN.multiSelectDeferred, true);
  });

  it("holds hard lines and inherits F.1–F.7 / X.1 / X.2 keep-opens", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerSelectHoldsHardLines(), true);
    assert.equal(explorerSelectInheritsFolderStories(), true);
    assert.equal(EXPLORER_SELECT_OPEN.yamlIsSourceOfTruth, true);
    assert.equal(EXPLORER_SELECT_OPEN.draftsNeverRun, true);
    assert.equal(EXPLORER_SELECT_OPEN.identityProxyAllowlistUnchanged, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of EXPLORER_SELECT_OPEN_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
