import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { EDITOR_LIBRARY } from "./editor-library.ts";
import { EDITOR_NDV } from "./editor-ndv.ts";
import { EDITOR_RUNS } from "./editor-runs.ts";
import {
  EDITOR_CANVAS_PLUS_FITTS,
  EDITOR_TOPBAR_CHUNKING,
  EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS,
  editorTopBarDraftsNeverRun,
  editorTopBarHasThreeGroups,
  editorTopBarSerialPosition,
} from "./editor-topbar-chunking.ts";
import { EDITOR_WORKING_MEMORY } from "./editor-working-memory.ts";
import {
  EDITOR_NODE_FAMILY_MARKS,
  EDITOR_VISUAL,
  FF_EDITOR_CANVAS_CLASS,
  FF_EDITOR_GRID_CLASS,
  FF_EDITOR_NODE_SELECTED_CLASS,
  FF_EDITOR_PLUS_CLASS,
  FF_EDITOR_SATELLITE_CLASS,
  FF_EDITOR_TOPBAR_CLASS,
  LIGHT_EDITOR_TOKENS,
  N8N_NDV_CLONE_TOKENS,
  V4_BRIEF,
  V4_CHROME_SOURCES,
  V4_EPIC,
  V4_HELP,
  V4_ID,
  V4_KEEP_STORY_OPEN,
  V4_SOURCES,
  V4_STORY,
  V4_TOKEN_FILE,
  editorChromeRejectsForbiddenLook,
  editorChromeRejectsLightLook,
  editorNodeFamilyMark,
  editorNodeFamilyShapeClass,
  editorOneOverlayHeld,
  editorRejectsN8nNdvClone,
  editorRejectsRainbowPalette,
  editorUsesV1TokenClasses,
  editorUxlBehaviorsHeld,
  editorVisualHoldsAcceptance,
  editorVisualHoldsHardLines,
  editorVisualInheritsPriorStories,
} from "./editor-visual.ts";
import { PALETTE_CATEGORY_FIRST } from "./palette-category-first.ts";
import { PEAK_END_OPERATE } from "./peak-end-operate-endings.ts";
import { FF_ACCENT, FF_CANVAS, FF_SURFACE } from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("V.4 Editor chrome", () => {
  it("keeps #360 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V4_STORY, 360);
    assert.equal(V4_EPIC, 353);
    assert.equal(V4_KEEP_STORY_OPEN, true);
    assert.equal(V4_ID, "V.4-editor-chrome");
    assert.equal(V4_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(V4_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(EDITOR_VISUAL.keep360Open, true);
    assert.equal(EDITOR_VISUAL.uiOnly, true);
    assert.equal(EDITOR_VISUAL.jonnyNoneExpected, true);
    assert.match(V4_HELP, /Dark canvas/);
    assert.match(V4_HELP, /Not an n8n NDV clone/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /#360/);
    assert.match(frontend, /keep #360 open/i);
    assert.match(frontend, /dark canvas/i);
  });

  it("locks dark editor tokens on the V.1 tree", () => {
    const globals = source("src/app/globals.css");
    const chrome = source("src/components/workflows/EditorChrome.tsx");
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.equal(editorUsesV1TokenClasses(globals), true);
    assert.match(chrome, /data-ff-editor/);
    assert.match(chrome, /FF_EDITOR_VALUE/);
    assert.match(chrome, /FF_EDITOR_ROOT_CLASS/);
    assert.match(chrome, /FF_EDITOR_SATELLITE_CLASS/);
    assert.match(canvas, /FF_EDITOR_CANVAS_CLASS/);
    assert.match(canvas, /FF_EDITOR_GRID_CLASS/);
    assert.match(globals, /\.ff-editor-canvas/);
    assert.match(globals, /\.ff-editor-grid/);
    assert.match(globals, /background: var\(--ff-canvas\)/);
    assert.match(globals, /background: var\(--ff-surface\)/);
    assert.match(globals, /box-shadow: 0 0 0 2px var\(--ff-accent\)/);
    assert.equal(EDITOR_VISUAL.darkCanvas, true);
    assert.equal(EDITOR_VISUAL.darkSatelliteChrome, true);
    assert.equal(EDITOR_VISUAL.inheritV1Tokens, true);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_SURFACE, "#171b22");
    assert.equal(FF_ACCENT, "#0f766e");
    assert.ok(FF_EDITOR_CANVAS_CLASS);
    assert.ok(FF_EDITOR_GRID_CLASS);
    assert.ok(FF_EDITOR_SATELLITE_CLASS);
    assert.ok(FF_EDITOR_TOPBAR_CLASS);
  });

  it("holds UXL.1–UXL.4 / UXL.7 grouping and working memory", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    const library = source("src/components/workflows/ActionLibrary.tsx");
    const inspector = source("src/components/workflows/EditorInspector.tsx");
    const runs = source("src/components/workflows/EditorRunsDrawer.tsx");
    assert.equal(editorTopBarHasThreeGroups(topBar), true);
    assert.equal(editorTopBarSerialPosition(topBar), true);
    assert.equal(editorUxlBehaviorsHeld({ topBar, canvas, library, inspector, runs }), true);
    assert.match(topBar, /data-editor-topbar="authoring"/);
    assert.match(topBar, /data-editor-topbar="satellites"/);
    assert.match(topBar, /data-editor-topbar="run"/);
    assert.match(topBar, /data-editor-working-memory="draft"/);
    assert.match(topBar, /data-editor-working-memory="test-run"/);
    assert.match(topBar, /DohertyStatus/);
    assert.match(library, /data-uxl7="palette"/);
    assert.match(library, /data-uxl7="categories"/);
    assert.equal(EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers, true);
    assert.equal(EDITOR_WORKING_MEMORY.persistentChromeNotTooltip, true);
    assert.equal(PALETTE_CATEGORY_FIRST.firstPaintIsCategories, true);
    assert.equal(PEAK_END_OPERATE.afterStartOrTestRunOpenOverlay, true);
  });

  it("does not guess a graph from invalid YAML, never runs drafts, keeps one overlay, and stays loud on indeterminate", () => {
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    const runs = source("src/components/workflows/EditorRunsDrawer.tsx");
    assert.match(canvas, /will not guess a graph/);
    assert.match(canvas, /Invalid YAML is not projected/);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
    assert.equal(editorTopBarDraftsNeverRun(), true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
    assert.equal(EDITOR_CHROME.startPublishedVersionsOnly, true);
    assert.equal(editorOneOverlayHeld(runs), true);
    assert.match(runs, /EDITOR_RUNS_SKIP_INDETERMINATE_LABEL/);
    assert.match(runs, /PeakEndEnding/);
    assert.doesNotMatch(runs, /ExecutionReplay/);
    assert.doesNotMatch(runs, /\/replay/);
    assert.equal(EDITOR_RUNS.noSecondReplayCanvas, true);
    assert.equal(EDITOR_RUNS.indeterminateIconAndText, true);
    assert.equal(EDITOR_VISUAL.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_VISUAL.draftsNeverRun, true);
    assert.equal(EDITOR_VISUAL.oneOverlay, true);
    assert.equal(EDITOR_VISUAL.loudIndeterminate, true);
  });

  it("keeps Save / Publish / Test run / canvas + at Fitts size", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.match(topBar, /EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS/);
    assert.equal(
      EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS,
      "px-2.5 py-1 text-sm font-medium",
    );
    assert.equal(topBar.split("EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS").length - 1 >= 4, true);
    assert.match(canvas, /h-9 w-9/);
    assert.match(canvas, /h-12 w-12/);
    assert.match(canvas, /h-7 w-7/);
    assert.match(canvas, /px-2 py-1 text-xs font-semibold/);
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.pending, "h-9 w-9");
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.empty, "h-12 w-12");
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.node, "h-7 w-7");
    assert.equal(EDITOR_CANVAS_PLUS_FITTS.toolbar, "px-2 py-1 text-xs font-semibold");
    assert.equal(EDITOR_VISUAL.savePublishTestRunCanvasPlusFullSize, true);
    assert.equal(EDITOR_VISUAL.fittsDoNotShrinkPrimary, true);
    assert.equal(EDITOR_VISUAL.fittsDoNotShrinkCanvasPlus, true);
  });

  it("uses one accent selection ring and family shape + icon + label with clear ports", () => {
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    const globals = source("src/app/globals.css");
    assert.match(canvas, /FF_EDITOR_NODE_SELECTED_CLASS/);
    assert.match(canvas, /editorNodeFamilyMark/);
    assert.match(canvas, /editorNodeFamilyShapeClass/);
    assert.match(canvas, /FF_EDITOR_PORT_CLASS/);
    assert.match(canvas, /FF_EDITOR_PLUS_CLASS/);
    assert.match(globals, /\.ff-editor-node-selected/);
    assert.match(globals, /box-shadow: 0 0 0 2px var\(--ff-accent\)/);
    assert.equal(editorNodeFamilyMark("control"), "Cf");
    assert.equal(editorNodeFamilyMark("kubernetes"), "Ks");
    assert.equal(editorNodeFamilyShapeClass("data"), "ff-editor-node-family-data");
    assert.equal(EDITOR_NODE_FAMILY_MARKS.script, "Sc");
    assert.equal(EDITOR_VISUAL.oneAccentSelectionRing, true);
    assert.equal(EDITOR_VISUAL.nodesFamilyShapeIconLabel, true);
    assert.equal(EDITOR_VISUAL.clearPorts, true);
    assert.ok(FF_EDITOR_NODE_SELECTED_CLASS);
    assert.ok(FF_EDITOR_PLUS_CLASS);
  });

  it("rejects leftover light chrome, n8n orange, branded NDV, rainbow palette, and a second theme", () => {
    for (const relative of V4_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(editorChromeRejectsForbiddenLook(text), true, relative);
      assert.equal(editorChromeRejectsLightLook(text), true, relative);
      for (const token of LIGHT_EDITOR_TOKENS) {
        assert.equal(text.includes(token), false, `${relative} ${token}`);
      }
    }
    const chrome = source("src/components/workflows/EditorChrome.tsx");
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    const library = source("src/components/workflows/ActionLibrary.tsx");
    const inspector = source("src/components/workflows/EditorInspector.tsx");
    const runs = source("src/components/workflows/EditorRunsDrawer.tsx");
    assert.equal(
      editorVisualHoldsAcceptance({ chrome, topBar, canvas, library, inspector, runs }),
      true,
    );
    assert.equal(editorRejectsN8nNdvClone(inspector), true);
    assert.equal(editorRejectsRainbowPalette(library), true);
    for (const token of N8N_NDV_CLONE_TOKENS) {
      assert.equal(inspector.includes(token), false, token);
    }
    assert.equal(EDITOR_NDV.noBrandedNdvInUi, true);
    assert.equal(EDITOR_VISUAL.noN8nOrange, true);
    assert.equal(EDITOR_VISUAL.noSecondThemeTree, true);
    assert.equal(EDITOR_VISUAL.notAnN8nNdvClone, true);
    const tokens = source(V4_TOKEN_FILE);
    assert.doesNotMatch(tokens, /#f97316|#ea4b71|#ff6d5a/);
  });

  it("holds hard lines and inherits V.1 / V.2 / UXL stories", () => {
    assert.equal(editorVisualHoldsHardLines(), true);
    assert.equal(editorVisualInheritsPriorStories(), true);
    assert.equal(EDITOR_VISUAL.yamlIsSourceOfTruth, true);
    assert.equal(EDITOR_VISUAL.draftsNeverRun, true);
    assert.equal(EDITOR_VISUAL.d3TriggersAreWorkflowLevel, true);
    assert.equal(EDITOR_VISUAL.noCanvasTriggerNodes, true);
    assert.equal(EDITOR_VISUAL.vaultDisplayNameUuidOnly, true);
    assert.equal(EDITOR_VISUAL.noKekInBrowser, true);
    assert.equal(EDITOR_VISUAL.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(EDITOR_VISUAL.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(EDITOR_VISUAL.isolationSuccessIsDenial, true);
    assert.equal(EDITOR_VISUAL.noGreenfieldApis, true);
    assert.equal(EDITOR_LIBRARY.triggersExcluded, true);
    for (const path of V4_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
