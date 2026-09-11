import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyBrowserSession } from "./session.ts";
import {
  E12_A11Y_DOCS,
  E12_A11Y_EPIC,
  E12_A11Y_FIXES,
  E12_A11Y_GAPS,
  E12_A11Y_ID,
  E12_A11Y_RULES,
  E12_A11Y_STORY,
  EDITOR_CANVAS_A11Y,
  EDITOR_CHROME_A11Y,
  EDITOR_DRAWER_IDS,
  EDITOR_DRAWER_PANEL_IDS,
  EDITOR_INSPECTOR_FIRST_MEDIA,
  EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT,
  EDITOR_TOP_BAR_CONTROLS,
  UX10_A11Y_ID,
  UX10_EPIC,
  UX10_KEEP_STORY_OPEN,
  UX10_STORY,
  e12A11yChipName,
  e12A11yExpiredSessionIsAlert,
  e12A11yMembershipIsolationNavIds,
  e12A11yMembershipIsolationVisible,
  e12A11yPaletteContract,
  e12A11yPaletteHighlight,
  e12A11ySkipTarget,
  editorDrawerAfterEscape,
  editorDrawerToClose,
  editorDrawerToggle,
  editorDrawerTriggerId,
  editorInspectorIsDrawer,
  editorSelectionAnnouncement,
  editorTopBarControlLabel,
} from "./e12-accessibility-contract.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("E12.3 accessibility contract", () => {
  it("keeps #184 open and points at the operator guide + review", () => {
    assert.equal(E12_A11Y_STORY, 184);
    assert.equal(E12_A11Y_EPIC, 181);
    assert.equal(E12_A11Y_ID, "E12.3-chloe-a11y");
    assert.equal(E12_A11Y_RULES.keep184Open, true);
    assert.equal(E12_A11Y_DOCS.guide, "docs/guides/operator-admin.md");
    assert.equal(E12_A11Y_DOCS.review, "docs/reference/e12-accessibility-review.md");
    assert.ok(E12_A11Y_FIXES.includes("skip-link"));
    assert.ok(E12_A11Y_GAPS.includes("dialog-focus-trap"));
  });

  it("uses a skip target that does not invent a nested main landmark", () => {
    const skip = e12A11ySkipTarget();
    assert.equal(skip.href, "#main-content");
    assert.equal(skip.id, "main-content");
    assert.equal(skip.label, "Skip to main content");
    assert.equal(E12_A11Y_RULES.noNestedMainInShell, true);
  });

  it("labels the command palette and moves highlight with arrows", () => {
    const palette = e12A11yPaletteContract();
    assert.equal(palette.inputLabel, "Filter commands");
    assert.equal(palette.resultsId, "command-palette-results");
    assert.match(palette.shortcutHelp, /Ctrl\+Shift\+K/);
    assert.equal(e12A11yPaletteHighlight(0, "ArrowDown", 2), 1);
    assert.equal(e12A11yPaletteHighlight(0, "ArrowUp", 2), 1);
  });

  it("announces expired session as alert and names the chip without color-only state", () => {
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    const expired = {
      active: true,
      stale: false,
      session: {
        ...emptyBrowserSession(),
        subject: "ada",
        idleExpiresAt: "2026-09-10T11:00:00.000Z",
      },
    };
    assert.equal(e12A11yExpiredSessionIsAlert(expired, now), true);
    assert.equal(e12A11yChipName(expired, now), "Session expired for ada");
    assert.equal(
      e12A11yChipName(
        { active: false, stale: true, session: emptyBrowserSession() },
        now,
      ),
      "Session stale. Re-establish a cookie session.",
    );
  });

  it("hides membership/isolation unless ADV-024 grant is present", () => {
    assert.equal(e12A11yMembershipIsolationVisible(null), false);
    assert.equal(e12A11yMembershipIsolationVisible(["workflow.view"]), false);
    assert.deepEqual(e12A11yMembershipIsolationNavIds(["workflow.view"]), []);
    assert.equal(
      e12A11yMembershipIsolationVisible(["workspace.administer"]),
      true,
    );
    assert.deepEqual(
      e12A11yMembershipIsolationNavIds(["workspace.administer"]),
      ["membership", "isolation"],
    );
    assert.equal(
      e12A11yMembershipIsolationVisible(["platform.administer"]),
      true,
    );
  });
});

describe("UX.10 canvas-first chrome a11y contract", () => {
  it("keeps #205 open and still skips to #main-content without a nested main", () => {
    assert.equal(UX10_STORY, 205);
    assert.equal(UX10_EPIC, 195);
    assert.equal(UX10_KEEP_STORY_OPEN, true);
    assert.equal(UX10_A11Y_ID, "UX.10-canvas-chrome-a11y");
    assert.equal(EDITOR_CHROME_A11Y.keep205Open, true);
    assert.equal(EDITOR_CHROME_A11Y.skipLinkHref, "#main-content");
    assert.equal(EDITOR_CHROME_A11Y.noNestedMain, true);
    assert.equal(E12_A11Y_RULES.noNestedMainInShell, true);
    const skip = e12A11ySkipTarget();
    assert.equal(skip.href, "#main-content");
    assert.equal(skip.id, "main-content");

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const chrome = source("src/components/workflows/EditorChrome.tsx");
    const page = source("src/app/workflows/[id]/page.tsx");
    assert.match(shell, /href="#main-content"/);
    assert.match(shell, /id="main-content"/);
    assert.doesNotMatch(shell, /<main[\s>]/);
    assert.doesNotMatch(chrome, /<main[\s>]/);
    assert.equal((page.match(/<main[\s>]/g) ?? []).length, 1);
  });

  it("labels editor top bar controls including drawer toggles", () => {
    assert.equal(EDITOR_CHROME_A11Y.editorBarLabeled, true);
    assert.ok(E12_A11Y_FIXES.includes("editor-top-bar-labels"));
    assert.equal(editorTopBarControlLabel("add-action"), "Add action");
    assert.equal(editorTopBarControlLabel("undo"), "Undo (Ctrl+Z)");
    assert.equal(editorTopBarControlLabel("redo"), "Redo (Ctrl+Shift+Z)");
    assert.equal(editorTopBarControlLabel("library"), "Library");
    assert.equal(editorTopBarControlLabel("library", true), "Hide library");
    assert.equal(editorTopBarControlLabel("yaml"), "YAML");
    assert.equal(editorTopBarControlLabel("yaml", true), "Hide YAML");
    assert.equal(editorTopBarControlLabel("inspector"), "Inspector");
    assert.equal(editorTopBarControlLabel("inspector", true), "Hide inspector");
    assert.equal(editorTopBarControlLabel("save"), "Save draft");
    assert.equal(editorTopBarControlLabel("publish"), "Publish");
    assert.equal(editorTopBarControlLabel("runs"), "Runs");
    assert.equal(editorTopBarControlLabel("runs", true), "Hide runs");
    assert.equal(editorTopBarControlLabel("start"), "Start published");
    assert.equal(editorTopBarControlLabel("publish-note"), "Publish note");
    assert.equal(editorDrawerTriggerId("library"), "editor-topbar-library");
    assert.equal(EDITOR_DRAWER_PANEL_IDS.yaml, "editor-yaml-drawer");
    assert.equal(EDITOR_DRAWER_PANEL_IDS.inspector, "editor-inspector-panel");

    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.match(topBar, /editorTopBarControlLabel/);
    for (const control of EDITOR_TOP_BAR_CONTROLS) {
      if (control.id === "back") {
        continue;
      }
      assert.match(topBar, new RegExp(`"${control.id}"`));
    }
  });

  it("closes palette and inspector drawers on Escape and restores focus", () => {
    assert.equal(EDITOR_CHROME_A11Y.drawerEscapeCloses, true);
    assert.equal(EDITOR_CHROME_A11Y.drawerFocusReturns, true);
    assert.ok(E12_A11Y_FIXES.includes("editor-drawer-escape"));
    assert.deepEqual([...EDITOR_DRAWER_IDS], [
      "library",
      "yaml",
      "runs",
      "inspector",
    ]);
    assert.deepEqual(editorDrawerAfterEscape(), {
      open: false,
      restoreFocus: true,
    });
    assert.deepEqual(editorDrawerToggle(false), {
      open: true,
      restoreFocus: false,
    });
    assert.deepEqual(editorDrawerToggle(true), {
      open: false,
      restoreFocus: true,
    });
    assert.equal(editorInspectorIsDrawer(false), false);
    assert.equal(editorInspectorIsDrawer(true), true);
    assert.equal(EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT, true);

    const closed = {
      library: false,
      yaml: false,
      runs: false,
      inspector: true,
    };
    assert.equal(editorDrawerToClose(closed, null), null);
    assert.equal(
      editorDrawerToClose({ ...closed, library: true }, "library"),
      "library",
    );
    assert.equal(
      editorDrawerToClose({ ...closed, yaml: true, runs: true }, "runs"),
      "runs",
    );
    assert.equal(editorDrawerToClose(closed, null, { inspectorIsDrawer: true }), "inspector");
    assert.equal(editorDrawerToClose(closed, "inspector"), "inspector");

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    assert.match(operator, /editorDrawerToClose/);
    assert.match(operator, /editorRestoreDrawerFocus/);
    assert.match(operator, /Escape/);
    const chrome = source("src/components/workflows/EditorChrome.tsx");
    assert.match(chrome, /order-first/);
    assert.match(chrome, /editor-inspector-panel|EDITOR_INSPECTOR_PANEL_ID/);
  });

  it("keeps canvas application role, names, icon+text, and selection announcements", () => {
    assert.equal(EDITOR_CANVAS_A11Y.role, "application");
    assert.equal(EDITOR_CANVAS_A11Y.label, "Workflow canvas");
    assert.equal(EDITOR_CANVAS_A11Y.nodeRole, "group");
    assert.equal(EDITOR_CANVAS_A11Y.edgeNamePrefix, "Edge");
    assert.equal(EDITOR_CANVAS_A11Y.stateIconAndText, true);
    assert.equal(EDITOR_CHROME_A11Y.canvasRoleApplication, true);
    assert.equal(EDITOR_CHROME_A11Y.nodeEdgeAccessibleNames, true);
    assert.equal(EDITOR_CHROME_A11Y.iconPlusTextState, true);
    assert.equal(EDITOR_CHROME_A11Y.selectionAnnouncesInspector, true);
    assert.equal(EDITOR_CHROME_A11Y.statusNeverColorOnly, true);
    assert.equal(EDITOR_CHROME_A11Y.noSrGraphRewrite, true);
    assert.ok(E12_A11Y_FIXES.includes("editor-selection-announce"));
    assert.ok(E12_A11Y_GAPS.includes("canvas-sr-graph"));
    assert.equal(
      editorSelectionAnnouncement({
        kind: "node",
        name: "Deploy",
        type: "http.request",
        id: "deploy",
      }),
      "Selected Deploy (http.request). Inspector shows name, with fields, pins, and credentials.",
    );
    assert.equal(
      editorSelectionAnnouncement({
        kind: "edge",
        from: "a.out",
        to: "b.in",
      }),
      "Selected edge a.out to b.in. Inspector explains port compatibility.",
    );
    assert.match(
      editorSelectionAnnouncement({ kind: "workflow" }),
      /triggers, versions, and pins/,
    );
    assert.match(
      editorSelectionAnnouncement({
        kind: "node",
        name: "Deploy",
        type: "http.request",
        id: "deploy",
        count: 3,
      }),
      /Selected 3 nodes/,
    );

    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.match(canvas, /role="application"/);
    assert.match(canvas, /aria-label="Workflow canvas"/);
    assert.match(canvas, /canvasNodeStateLabel/);
    assert.match(canvas, /canvasNodeStateIcon/);
    assert.match(canvas, /Edge \$\{edge\.from\} to \$\{edge\.to\}/);
    const chrome = source("src/components/workflows/EditorChrome.tsx");
    assert.match(chrome, /editor-selection-status|EDITOR_SELECTION_STATUS_ID/);
  });

  it("documents the inspector-first breakpoint as a frontend-ui gap, not a mobile app", () => {
    assert.equal(EDITOR_CHROME_A11Y.inspectorFirstIsDocumentedGap, true);
    assert.equal(EDITOR_CHROME_A11Y.notAMobileApp, true);
    assert.equal(EDITOR_INSPECTOR_FIRST_MEDIA, "(max-width: 767px)");
    assert.ok(E12_A11Y_GAPS.includes("touch-inspector-first"));
    assert.equal(E12_A11Y_DOCS.frontend, "docs/reference/frontend-ui.md");
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", E12_A11Y_DOCS.frontend),
      "utf8",
    );
    assert.match(frontend, /inspector-first/);
    assert.match(frontend, /#205/);
    assert.match(frontend, /not a mobile app/i);
    assert.match(frontend, /767px|max-width: 767px/);
  });
});
