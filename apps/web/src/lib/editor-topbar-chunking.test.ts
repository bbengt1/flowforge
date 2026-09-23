import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITOR_CHROME, editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import { EDITOR_TOP_BAR_CONTROLS } from "./e12-accessibility-contract.ts";
import {
  EDITOR_CANVAS_PLUS_FITTS,
  EDITOR_TOPBAR_CHUNKING,
  EDITOR_TOPBAR_CHUNKING_HELP,
  EDITOR_TOPBAR_CHUNKING_SOURCES,
  EDITOR_TOPBAR_GROUPS,
  EDITOR_TOPBAR_GROUP_LABELS,
  EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS,
  EDITOR_TOPBAR_REQUIRED_VERBS,
  EDITOR_TOPBAR_SERIAL,
  UXL1_BRIEF,
  UXL1_EPIC,
  UXL1_ID,
  UXL1_KEEP_STORY_OPEN,
  UXL1_STORY,
  editorCanvasPlusFittsUnchanged,
  editorTopBarChunkAttr,
  editorTopBarChunkOrder,
  editorTopBarControlIdsUnchanged,
  editorTopBarDraftsNeverRun,
  editorTopBarFittsPrimaryClassPresent,
  editorTopBarGroupContains,
  editorTopBarHasThreeGroups,
  editorTopBarHidesAuthoringInOverflow,
  editorTopBarHoldsHardLines,
  editorTopBarInventedVerb,
  editorTopBarKeepsUndoRedo,
  editorTopBarPublishLastSavedOnly,
  editorTopBarRemovesRequiredVerb,
  editorTopBarSameEmbedTree,
  editorTopBarSerialPosition,
} from "./editor-topbar-chunking.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UXL.1 top-bar verb chunking", () => {
  it("keeps #288 open and cites epic #287", () => {
    assert.equal(UXL1_STORY, 288);
    assert.equal(UXL1_EPIC, 287);
    assert.equal(UXL1_KEEP_STORY_OPEN, true);
    assert.equal(UXL1_ID, "UXL.1-topbar-chunking");
    assert.equal(UXL1_BRIEF, "docs/internal/flowforge-ux-laws.md");
    assert.match(EDITOR_TOPBAR_CHUNKING_HELP, /three groups/);
    assert.equal(EDITOR_TOPBAR_CHUNKING.uxl2ThroughUxl8OutOfScope, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.jonnyNoneExpected, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /three groups/);
  });

  it("names three groups: authoring, satellites, and run", () => {
    assert.deepEqual([...EDITOR_TOPBAR_GROUPS.authoring], ["save", "publish"]);
    assert.deepEqual([...EDITOR_TOPBAR_GROUPS.satellites], [
      "library",
      "inspector",
      "yaml",
      "runs",
    ]);
    assert.deepEqual([...EDITOR_TOPBAR_GROUPS.run], ["start", "test-run"]);
    assert.equal(EDITOR_TOPBAR_GROUP_LABELS.authoring, "Authoring");
    assert.equal(EDITOR_TOPBAR_GROUP_LABELS.satellites, "Editor satellites");
    assert.equal(EDITOR_TOPBAR_GROUP_LABELS.run, "Run");
    assert.equal(EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers, true);
    assert.equal(editorTopBarControlIdsUnchanged(), true);
  });

  it("chunks EditorTopBar in place with identity leading and run trailing", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.equal(editorTopBarHasThreeGroups(topBar), true);
    assert.equal(editorTopBarSerialPosition(topBar), true);
    assert.deepEqual(editorTopBarChunkOrder(topBar), [
      "identity",
      "authoring",
      "history",
      "satellites",
      "activation",
      "run",
    ]);
    assert.equal(editorTopBarGroupContains(topBar, "authoring"), true);
    assert.equal(editorTopBarGroupContains(topBar, "satellites"), true);
    assert.equal(editorTopBarGroupContains(topBar, "run"), true);
    assert.match(topBar, /role="group"/);
    assert.match(topBar, /EDITOR_TOPBAR_GROUP_LABELS.authoring/);
    assert.match(topBar, /EDITOR_TOPBAR_GROUP_LABELS.satellites/);
    assert.match(topBar, /EDITOR_TOPBAR_GROUP_LABELS.run/);
    assert.equal(EDITOR_TOPBAR_SERIAL.lead, "identity");
    assert.equal(EDITOR_TOPBAR_SERIAL.trail, "run");
    assert.match(topBar, /editorDirtyLabel/);
    assert.match(topBar, /editorStickyContext/);
  });

  it("keeps Save and Publish large, labeled, and visible — not overflow-only", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.equal(editorTopBarHidesAuthoringInOverflow(topBar), false);
    assert.equal(editorTopBarFittsPrimaryClassPresent(topBar), true);
    assert.match(topBar, /EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS/);
    assert.match(topBar, /"save"/);
    assert.match(topBar, /"publish"/);
    assert.doesNotMatch(topBar, /<details/);
    assert.doesNotMatch(topBar, /aria-haspopup="menu"/);
    assert.equal(EDITOR_TOPBAR_CHUNKING.savePublishNotOverflowOnly, true);
    assert.equal(EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS, "px-2.5 py-1 text-sm font-medium");
  });

  it("does not shrink canvas + below the current Fitts height", () => {
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.equal(editorCanvasPlusFittsUnchanged(canvas), true);
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.pending, "h-9 w-9");
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.empty, "h-12 w-12");
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.node, "h-7 w-7");
    assert.equal(EDITOR_TOPBAR_CHUNKING.fittsDoNotShrinkCanvasPlus, true);
  });

  it("keeps undo/redo and every existing verb; drafts still never run", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.equal(editorTopBarRemovesRequiredVerb(topBar), false);
    assert.equal(editorTopBarInventedVerb(topBar), false);
    assert.equal(editorTopBarKeepsUndoRedo(), true);
    assert.equal(editorTopBarPublishLastSavedOnly(), true);
    assert.equal(editorTopBarDraftsNeverRun(), true);
    assert.match(topBar, /"undo"/);
    assert.match(topBar, /"redo"/);
    assert.equal(EDITOR_CHROME.publishLastSavedDraftOnly, true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
    for (const id of EDITOR_TOPBAR_REQUIRED_VERBS) {
      assert.ok(
        EDITOR_TOP_BAR_CONTROLS.some((control) => control.id === id),
        id,
      );
    }
  });

  it("uses the same EditorTopBar on embed after session.embed — no second tree", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    const chrome = source("src/components/workflows/EditorChrome.tsx");
    assert.equal(editorTopBarSameEmbedTree(topBar), true);
    assert.equal(editorTopBarSameEmbedTree(operator), true);
    assert.equal(editorEmbedRouteUnchanged(), true);
    assert.match(topBar, /useEmbedMode/);
    assert.match(operator, /<EditorTopBar/);
    assert.equal((operator.match(/<EditorTopBar/g) ?? []).length, 1);
    assert.doesNotMatch(operator, /EmbedEditorTopBar/);
    assert.doesNotMatch(chrome, /<main[\s>]/);
    assert.equal(EDITOR_TOPBAR_CHUNKING.sameGroupingOnEmbed, true);
    assert.equal(R7_HARD_LINE.noSecondEmbedTreeSameMountsAsStandalone, true);
    assert.equal(editorTopBarChunkAttr("authoring"), 'data-editor-topbar="authoring"');
  });

  it("holds product hard lines and does not invent apps/api work", () => {
    assert.equal(editorTopBarHoldsHardLines(), true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.noAppsApiChanges, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.yamlIsSourceOfTruth, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.vaultDisplayNameUuidOnly, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.oneReplayPath, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.loudIndeterminate, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.failClosedCatalogs, true);
    assert.equal(EDITOR_TOPBAR_CHUNKING.notAnN8nClone, true);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
    for (const path of EDITOR_TOPBAR_CHUNKING_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
