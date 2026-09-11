import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CANVAS_GRID_SIZE,
  EDITOR_CANVAS_FIT_LABEL,
  EDITOR_CANVAS_PRIMITIVES,
  EDITOR_CANVAS_PRIMITIVES_HELP,
  EDITOR_CANVAS_SELECT_ALL_SHORTCUT,
  EDITOR_CANVAS_SNAP_LABEL,
  R24_EPIC,
  R24_KEEP_STORY_OPEN,
  R24_STORY,
  applyNodeMoves,
  canvasFitControlLabel,
  canvasPrimitivesEmbedUnchanged,
  canvasSnapControlLabel,
  fitCanvasViewport,
  fitIdsForSelection,
  isAdditiveSelectModifier,
  isFitShortcut,
  isNodeSelected,
  isSelectAllShortcut,
  isSnapShortcut,
  multiSelectAnnouncement,
  nodeSelection,
  nodesInMarquee,
  normalizeCanvasRect,
  primarySelectedNodeId,
  selectNodes,
  selectedNodeIds,
  snapCoord,
  snapPoint,
  toggleNodeInSelection,
  unionNodeSelection,
} from "./editor-canvas-primitives.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { editorTopBarControlLabel } from "./e12-accessibility-contract.ts";
import {
  EDITOR_CANVAS_HISTORY,
  mergeCanvasPositions,
} from "./editor-canvas-history.ts";
import { projectCanvasGraph } from "./workflow-graph.ts";
import { INVALID_WORKFLOW_YAML } from "./workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function key(
  overrides: Partial<{
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) {
  return {
    key: "f",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("R2.4 canvas multi-select + fit/snap", () => {
  it("keeps #237 open and cites epic #228", () => {
    assert.equal(R24_STORY, 237);
    assert.equal(R24_EPIC, 228);
    assert.equal(R24_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.noAppsApiChanges, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.migrateInPlace, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.noGreenfieldPackage, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.d1LayoutPersistOutOfScope, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.noDraftExecute, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.sessionLayoutOnly, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.layoutNeverInventGraph, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.multiSelect, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.fitToView, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.snapToGrid, true);
    assert.equal(EDITOR_CANVAS_PRIMITIVES.gridSize, 16);
    assert.equal(canvasPrimitivesEmbedUnchanged(), true);
    assert.equal(EDITOR_CHROME.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
    assert.equal(EDITOR_CHROME.keyboard.multiSelectFitSnap, true);
    assert.equal(EDITOR_CANVAS_HISTORY.d1LayoutPersistOutOfScope, true);
  });

  it("labels fit, snap, and select-all shortcuts", () => {
    assert.equal(EDITOR_CANVAS_PRIMITIVES.keyboardLabeled, true);
    assert.equal(EDITOR_CANVAS_SELECT_ALL_SHORTCUT, "Ctrl+A");
    assert.equal(canvasFitControlLabel(), "Fit (F)");
    assert.equal(canvasSnapControlLabel(true), "Snap (G)");
    assert.equal(canvasSnapControlLabel(false), "Snap off (G)");
    assert.equal(EDITOR_CANVAS_FIT_LABEL, "Fit (F)");
    assert.equal(EDITOR_CANVAS_SNAP_LABEL, "Snap (G)");
    assert.match(EDITOR_CANVAS_PRIMITIVES_HELP, /Shift\+click/);
    assert.match(EDITOR_CANVAS_PRIMITIVES_HELP, /Ctrl\+A/);
    assert.match(EDITOR_CANVAS_PRIMITIVES_HELP, /Fit \(F\)/);
    assert.match(EDITOR_CANVAS_PRIMITIVES_HELP, /Snap \(G\)/);
    assert.equal(editorTopBarControlLabel("undo"), "Undo (Ctrl+Z)");
  });

  it("toggles, unions, and reads multi-node selection", () => {
    assert.deepEqual(selectedNodeIds({ kind: "workflow" }), []);
    assert.deepEqual(selectedNodeIds({ kind: "node", id: "seed" }), ["seed"]);
    assert.deepEqual(
      selectedNodeIds({ kind: "node", id: "done", ids: ["seed", "done"] }),
      ["seed", "done"],
    );
    assert.equal(primarySelectedNodeId({ kind: "node", id: "seed" }), "seed");
    assert.equal(isNodeSelected({ kind: "node", id: "seed" }, "seed"), true);
    assert.equal(isNodeSelected({ kind: "node", id: "seed" }, "done"), false);

    const added = toggleNodeInSelection({ kind: "node", id: "seed" }, "done");
    assert.deepEqual(selectedNodeIds(added), ["seed", "done"]);
    assert.equal(added.kind, "node");
    if (added.kind === "node") {
      assert.equal(added.id, "done");
    }

    const cleared = toggleNodeInSelection(added, "done");
    assert.deepEqual(selectedNodeIds(cleared), ["seed"]);

    const emptied = toggleNodeInSelection({ kind: "node", id: "seed" }, "seed");
    assert.deepEqual(emptied, { kind: "workflow" });

    const unioned = unionNodeSelection({ kind: "node", id: "seed" }, ["done", "more"]);
    assert.deepEqual(selectedNodeIds(unioned), ["seed", "done", "more"]);
    assert.deepEqual(selectNodes(["a", "b"]), nodeSelection("b", ["a", "b"]));
    assert.deepEqual(selectNodes([]), { kind: "workflow" });
  });

  it("hits nodes that intersect a marquee rectangle", () => {
    const positions = new Map([
      ["seed", { x: 48, y: 48 }],
      ["done", { x: 288, y: 48 }],
      ["away", { x: 800, y: 400 }],
    ]);
    assert.deepEqual(
      nodesInMarquee(positions, { x: 40, y: 40 }, { x: 250, y: 160 }),
      ["seed"],
    );
    assert.deepEqual(
      nodesInMarquee(positions, { x: 40, y: 40 }, { x: 500, y: 160 }),
      ["seed", "done"],
    );
    assert.deepEqual(
      nodesInMarquee(positions, { x: 40, y: 40 }, { x: 42, y: 41 }),
      [],
    );
    assert.deepEqual(normalizeCanvasRect({ x: 10, y: 20 }, { x: 4, y: 8 }), {
      x: 4,
      y: 8,
      width: 6,
      height: 12,
    });
  });

  it("snaps points to the 16px grid and moves a selection together", () => {
    assert.equal(CANVAS_GRID_SIZE, 16);
    assert.equal(snapCoord(20), 16);
    assert.equal(snapCoord(28), 32);
    assert.deepEqual(snapPoint({ x: 20, y: 28 }, true), { x: 16, y: 32 });
    assert.deepEqual(snapPoint({ x: 20, y: 28 }, false), { x: 20, y: 28 });
    const moved = applyNodeMoves(
      { seed: { x: 48, y: 48 }, done: { x: 288, y: 48 } },
      ["seed", "done"],
      10,
      12,
      true,
    );
    assert.deepEqual(moved, {
      seed: { x: 64, y: 64 },
      done: { x: 304, y: 64 },
    });
    const unsnapped = applyNodeMoves(
      { seed: { x: 48, y: 48 } },
      ["seed"],
      10,
      12,
      false,
    );
    assert.deepEqual(unsnapped, { seed: { x: 58, y: 60 } });
  });

  it("fits selected or all nodes into the viewport", () => {
    const positions = new Map([
      ["seed", { x: 0, y: 0 }],
      ["done", { x: 200, y: 0 }],
    ]);
    const all = fitCanvasViewport({
      positions,
      viewport: { width: 800, height: 400 },
      nodeWidth: 100,
      nodeHeight: 100,
      padding: 50,
      minScale: 0.4,
      maxScale: 2.2,
    });
    assert.ok(all.scale > 0.4 && all.scale <= 2.2);
    assert.equal(typeof all.x, "number");
    assert.equal(typeof all.y, "number");

    const selected = fitCanvasViewport({
      positions,
      ids: ["seed"],
      viewport: { width: 200, height: 200 },
      nodeWidth: 100,
      nodeHeight: 100,
      padding: 0,
      minScale: 0.4,
      maxScale: 2.2,
    });
    assert.equal(selected.scale, 2);
    assert.equal(selected.x, 0);
    assert.equal(selected.y, 0);

    const empty = fitCanvasViewport({
      positions: new Map(),
      viewport: { width: 400, height: 300 },
    });
    assert.deepEqual(empty, { x: 0, y: 0, scale: 1 });
    assert.deepEqual(fitIdsForSelection({ kind: "workflow" }, ["a", "b"]), ["a", "b"]);
    assert.deepEqual(
      fitIdsForSelection({ kind: "node", id: "a", ids: ["a", "b"] }, ["a", "b", "c"]),
      ["a", "b"],
    );
  });

  it("recognizes labeled shortcuts without stealing text-field modifiers", () => {
    assert.equal(isAdditiveSelectModifier({ shiftKey: true }), true);
    assert.equal(isAdditiveSelectModifier({ ctrlKey: true }), true);
    assert.equal(isAdditiveSelectModifier({ metaKey: true }), true);
    assert.equal(isAdditiveSelectModifier({ altKey: true, shiftKey: true }), false);
    assert.equal(isAdditiveSelectModifier({}), false);
    assert.equal(isSelectAllShortcut(key({ key: "a", ctrlKey: true })), true);
    assert.equal(isSelectAllShortcut(key({ key: "a", metaKey: true })), true);
    assert.equal(isSelectAllShortcut(key({ key: "a" })), false);
    assert.equal(isFitShortcut(key({ key: "f" })), true);
    assert.equal(isFitShortcut(key({ key: "1" })), true);
    assert.equal(isFitShortcut(key({ key: "f", ctrlKey: true })), false);
    assert.equal(isSnapShortcut(key({ key: "g" })), true);
    assert.equal(isSnapShortcut(key({ key: "g", shiftKey: true })), false);
  });

  it("announces multi-select without inventing a graph from invalid YAML", () => {
    assert.match(
      multiSelectAnnouncement({
        count: 3,
        name: "Seed value",
        type: "data.set",
        id: "seed",
      }),
      /Selected 3 nodes/,
    );
    assert.match(
      multiSelectAnnouncement({
        count: 1,
        name: "Seed value",
        type: "data.set",
        id: "seed",
      }),
      /Inspector shows name/,
    );
    assert.equal(
      projectCanvasGraph({
        errors: [
          {
            path: "spec.nodes[0].id",
            code: "invalid-id",
            message: "Node IDs must be DNS labels.",
          },
        ],
        summary: {
          apiVersion: "flowforge/v1",
          name: "broken",
          description: "",
          triggers: [],
          nodes: [{ id: "Bad_ID", type: "workflow.call", name: "Next-phase call" }],
          edges: [],
          outputs: [],
        },
        yaml: INVALID_WORKFLOW_YAML,
      }),
      null,
    );
    assert.equal(mergeCanvasPositions(new Map(), { ghost: { x: 8, y: 8 } }).size, 0);
  });

  it("wires the editor chrome without draft execute or API changes", () => {
    const operator = source("components/workflows/WorkflowOperator.tsx");
    const canvas = source("components/workflows/WorkflowCanvas.tsx");
    const inspector = source("components/workflows/EditorInspector.tsx");
    assert.match(operator, /selectedNodeIds|toggleNodeInSelection|applyNodeMoves/);
    assert.match(operator, /removeGraphNode/);
    assert.match(operator, /saveCanonicalWorkflowDraft/);
    assert.match(canvas, /fitCanvasViewport/);
    assert.match(canvas, /nodesInMarquee/);
    assert.match(canvas, /isSelectAllShortcut/);
    assert.match(canvas, /isFitShortcut/);
    assert.match(canvas, /isSnapShortcut/);
    assert.match(canvas, /EDITOR_CANVAS_FIT_LABEL|canvasFitControlLabel/);
    assert.match(canvas, /snapPoint|applyNodeMoves/);
    assert.match(inspector, /selectedNodeIds/);
    assert.doesNotMatch(operator, /executeDraft|runDraft|draft execute/i);
    assert.doesNotMatch(operator, /apps\/api/);
    assert.doesNotMatch(canvas, /from ["']@xyflow|reactflow|react-flow/i);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs", "reference", "frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /keep #237 open/);
    assert.doesNotMatch(frontend, /Closes #237|Fixes #237|Close #237/);
  });
});
