import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_CANVAS_HISTORY,
  EDITOR_CANVAS_HISTORY_HELP,
  EDITOR_CANVAS_HISTORY_LIMIT,
  EDITOR_CANVAS_REDO_LABEL,
  EDITOR_CANVAS_REDO_SHORTCUT,
  EDITOR_CANVAS_UNDO_LABEL,
  EDITOR_CANVAS_UNDO_SHORTCUT,
  R23_EPIC,
  R23_KEEP_STORY_OPEN,
  R23_STORY,
  canRedoCanvasHistory,
  canUndoCanvasHistory,
  canvasHistoryEmbedUnchanged,
  canvasLayoutsEqual,
  canvasMovedEnough,
  canvasRedoControlLabel,
  canvasSnapshotsEqual,
  canvasUndoControlLabel,
  cloneCanvasLayout,
  emptyCanvasHistory,
  isCanvasDeleteShortcut,
  isCanvasRedoShortcut,
  isCanvasUndoShortcut,
  mergeCanvasPositions,
  pruneCanvasLayout,
  pushCanvasHistory,
  redoCanvasHistory,
  replaceCanvasHistoryPresent,
  shortcutTargetIsEditable,
  undoCanvasHistory,
} from "./editor-canvas-history.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { editorTopBarControlLabel } from "./e12-accessibility-contract.ts";
import {
  disconnectGraphEdge,
  projectCanvasGraph,
  removeGraphNode,
} from "./workflow-graph.ts";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML } from "./workflow.ts";
import {
  insertCoreNode,
  insertYamlEdge,
  listYamlEdges,
  listYamlNodes,
} from "./workflow-yaml-nodes.ts";

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
    key: "z",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("R2.3 canvas undo/redo", () => {
  it("keeps #236 open and cites epic #228", () => {
    assert.equal(R23_STORY, 236);
    assert.equal(R23_EPIC, 228);
    assert.equal(R23_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_CANVAS_HISTORY.noAppsApiChanges, true);
    assert.equal(EDITOR_CANVAS_HISTORY.migrateInPlace, true);
    assert.equal(EDITOR_CANVAS_HISTORY.noGreenfieldPackage, true);
    assert.equal(EDITOR_CANVAS_HISTORY.d1LayoutPersistOutOfScope, true);
    assert.equal(EDITOR_CANVAS_HISTORY.multiSelectFitSnapOutOfScope, true);
    assert.equal(EDITOR_CANVAS_HISTORY.noDraftExecute, true);
    assert.equal(EDITOR_CANVAS_HISTORY.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CANVAS_HISTORY.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_CANVAS_HISTORY.sessionLayoutOnly, true);
    assert.equal(EDITOR_CANVAS_HISTORY.layoutNeverInventGraph, true);
    assert.equal(canvasHistoryEmbedUnchanged(), true);
    assert.equal(EDITOR_CHROME.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
    assert.equal(EDITOR_CHROME.keyboard.undoRedo, true);
  });

  it("labels undo/redo keyboard shortcuts", () => {
    assert.equal(EDITOR_CANVAS_HISTORY.keyboardLabeled, true);
    assert.equal(EDITOR_CANVAS_UNDO_SHORTCUT, "Ctrl+Z");
    assert.equal(EDITOR_CANVAS_REDO_SHORTCUT, "Ctrl+Shift+Z");
    assert.equal(canvasUndoControlLabel(), "Undo (Ctrl+Z)");
    assert.equal(canvasRedoControlLabel(), "Redo (Ctrl+Shift+Z)");
    assert.equal(editorTopBarControlLabel("undo"), EDITOR_CANVAS_UNDO_LABEL);
    assert.equal(editorTopBarControlLabel("redo"), EDITOR_CANVAS_REDO_LABEL);
    assert.match(EDITOR_CANVAS_HISTORY_HELP, /Ctrl\+Z/);
    assert.match(EDITOR_CANVAS_HISTORY_HELP, /Ctrl\+Shift\+Z/);
    assert.deepEqual([...EDITOR_CANVAS_HISTORY.kinds], [
      "move",
      "add",
      "remove",
      "connect",
      "disconnect",
    ]);
  });

  it("undoes and redoes move, add, remove, and connect", () => {
    let history = emptyCanvasHistory(STARTER_WORKFLOW_YAML);
    assert.equal(canUndoCanvasHistory(history), false);
    assert.equal(canRedoCanvasHistory(history), false);

    const added = insertCoreNode(STARTER_WORKFLOW_YAML, "flow.condition");
    history = pushCanvasHistory(history, { yaml: added.yaml, layout: {} });
    const connectedYaml = insertYamlEdge(
      added.yaml,
      "seed.result",
      "condition.value",
    );
    history = pushCanvasHistory(history, { yaml: connectedYaml, layout: {} });
    history = pushCanvasHistory(history, {
      yaml: connectedYaml,
      layout: { seed: { x: 120, y: 80 } },
    });
    const removed = removeGraphNode(connectedYaml, added.node.id);
    history = pushCanvasHistory(history, { yaml: removed, layout: {} });

    assert.equal(canUndoCanvasHistory(history), true);
    assert.equal(listYamlNodes(history.present.yaml).some((node) => node.id === added.node.id), false);

    const afterRemove = undoCanvasHistory(history);
    assert.ok(afterRemove);
    history = afterRemove.state;
    assert.equal(history.present.layout.seed?.x, 120);
    assert.ok(listYamlEdges(history.present.yaml).some((edge) => edge.to === "condition.value"));

    const afterMove = undoCanvasHistory(history);
    assert.ok(afterMove);
    history = afterMove.state;
    assert.equal(history.present.layout.seed, undefined);
    assert.ok(listYamlEdges(history.present.yaml).some((edge) => edge.to === "condition.value"));

    const afterConnect = undoCanvasHistory(history);
    assert.ok(afterConnect);
    history = afterConnect.state;
    assert.equal(
      listYamlEdges(history.present.yaml).some((edge) => edge.to === "condition.value"),
      false,
    );
    assert.ok(listYamlNodes(history.present.yaml).some((node) => node.id === added.node.id));

    const afterAdd = undoCanvasHistory(history);
    assert.ok(afterAdd);
    history = afterAdd.state;
    assert.equal(history.present.yaml, STARTER_WORKFLOW_YAML);
    assert.equal(canUndoCanvasHistory(history), false);

    const redone = redoCanvasHistory(history);
    assert.ok(redone);
    assert.ok(listYamlNodes(redone.applied.yaml).some((node) => node.id === added.node.id));
  });

  it("disconnects an edge as a graph edit and no-ops identical snapshots", () => {
    const added = insertCoreNode(STARTER_WORKFLOW_YAML, "flow.condition");
    const connectedYaml = insertYamlEdge(
      added.yaml,
      "seed.result",
      "condition.value",
    );
    let history = emptyCanvasHistory(connectedYaml);
    const disconnected = disconnectGraphEdge(
      connectedYaml,
      "seed.result",
      "condition.value",
    );
    history = pushCanvasHistory(history, { yaml: disconnected, layout: {} });
    assert.equal(
      listYamlEdges(history.present.yaml).some((edge) => edge.to === "condition.value"),
      false,
    );
    const same = pushCanvasHistory(history, { yaml: disconnected, layout: {} });
    assert.equal(same.past.length, history.past.length);
    const undone = undoCanvasHistory(history);
    assert.ok(undone);
    assert.ok(
      listYamlEdges(undone.applied.yaml).some((edge) => edge.to === "condition.value"),
    );
  });

  it("replaces present YAML without creating an undo entry", () => {
    const history = pushCanvasHistory(emptyCanvasHistory("a"), {
      yaml: "b",
      layout: {},
    });
    const synced = replaceCanvasHistoryPresent(history, {
      yaml: "b-edited",
      layout: history.present.layout,
    });
    assert.equal(synced.past.length, 1);
    assert.equal(synced.present.yaml, "b-edited");
    const undone = undoCanvasHistory(synced);
    assert.ok(undone);
    assert.equal(undone.applied.yaml, "a");
  });

  it("caps the stack and treats session layout as hints only", () => {
    let history = emptyCanvasHistory("0");
    for (let index = 1; index <= EDITOR_CANVAS_HISTORY_LIMIT + 5; index += 1) {
      history = pushCanvasHistory(history, {
        yaml: String(index),
        layout: {},
      });
    }
    assert.equal(history.past.length, EDITOR_CANVAS_HISTORY_LIMIT);
    assert.equal(history.present.yaml, String(EDITOR_CANVAS_HISTORY_LIMIT + 5));

    const auto = new Map([
      ["seed", { x: 48, y: 48 }],
      ["done", { x: 288, y: 48 }],
    ]);
    const merged = mergeCanvasPositions(auto, {
      seed: { x: 10, y: 20 },
      ghost: { x: 99, y: 99 },
    });
    assert.deepEqual(merged.get("seed"), { x: 10, y: 20 });
    assert.deepEqual(merged.get("done"), { x: 288, y: 48 });
    assert.equal(merged.has("ghost"), false);
    assert.deepEqual(pruneCanvasLayout({ seed: { x: 1, y: 2 }, gone: { x: 3, y: 4 } }, ["seed"]), {
      seed: { x: 1, y: 2 },
    });
    assert.equal(canvasMovedEnough(2, 2), true);
    assert.equal(canvasMovedEnough(1, 1), false);
    assert.equal(canvasLayoutsEqual({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 2 } }), true);
    assert.equal(
      canvasSnapshotsEqual(
        { yaml: "x", layout: cloneCanvasLayout({ a: { x: 1, y: 2 } }) },
        { yaml: "x", layout: { a: { x: 1, y: 2 } } },
      ),
      true,
    );
  });

  it("stores invalid YAML without projecting a guessed graph", () => {
    const history = pushCanvasHistory(emptyCanvasHistory(STARTER_WORKFLOW_YAML), {
      yaml: INVALID_WORKFLOW_YAML,
      layout: { Bad_ID: { x: 8, y: 8 } },
    });
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
        yaml: history.present.yaml,
      }),
      null,
    );
    assert.equal(mergeCanvasPositions(new Map(), history.present.layout).size, 0);
  });

  it("recognizes labeled shortcuts and leaves text fields to native undo", () => {
    assert.equal(isCanvasUndoShortcut(key({ ctrlKey: true })), true);
    assert.equal(isCanvasUndoShortcut(key({ metaKey: true })), true);
    assert.equal(isCanvasUndoShortcut(key({ ctrlKey: true, shiftKey: true })), false);
    assert.equal(isCanvasRedoShortcut(key({ ctrlKey: true, shiftKey: true })), true);
    assert.equal(isCanvasRedoShortcut(key({ key: "y", ctrlKey: true })), true);
    assert.equal(isCanvasRedoShortcut(key({ ctrlKey: true })), false);
    assert.equal(isCanvasDeleteShortcut(key({ key: "Delete" })), true);
    assert.equal(isCanvasDeleteShortcut(key({ key: "Backspace" })), true);
    assert.equal(isCanvasDeleteShortcut(key({ key: "Backspace", ctrlKey: true })), false);
    assert.equal(shortcutTargetIsEditable({ tagName: "TEXTAREA" }), true);
    assert.equal(shortcutTargetIsEditable({ tagName: "INPUT" }), true);
    assert.equal(shortcutTargetIsEditable({ tagName: "DIV" }), false);
    assert.equal(shortcutTargetIsEditable({ tagName: "DIV", isContentEditable: true }), true);
  });

  it("wires the editor chrome without draft execute or API changes", () => {
    const operator = source("components/workflows/WorkflowOperator.tsx");
    const topBar = source("components/workflows/EditorTopBar.tsx");
    const canvas = source("components/workflows/WorkflowCanvas.tsx");
    assert.match(operator, /pushCanvasHistory/);
    assert.match(operator, /undoCanvasHistory/);
    assert.match(operator, /redoCanvasHistory/);
    assert.match(operator, /removeGraphNode|disconnectGraphEdge/);
    assert.match(operator, /saveCanonicalWorkflowDraft/);
    assert.doesNotMatch(operator, /drafts?Can(?:not)?Start.*false/);
    assert.match(topBar, /"undo"/);
    assert.match(topBar, /"redo"/);
    assert.match(topBar, /EDITOR_CANVAS_UNDO_LABEL|canvasUndoControlLabel|"undo"/);
    assert.match(canvas, /onMove/);
    assert.match(canvas, /onRemove/);
    assert.match(canvas, /isCanvasUndoShortcut/);
    assert.match(canvas, /isCanvasDeleteShortcut/);
    assert.match(canvas, /mergeCanvasPositions/);
    assert.doesNotMatch(operator, /executeDraft|runDraft|draft execute/i);
    assert.doesNotMatch(operator, /apps\/api/);
  });
});
