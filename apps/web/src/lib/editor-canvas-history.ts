/**
 * R2.3: canvas undo/redo for graph edits on `/workflows/{id}`.
 *
 * Relates to #236 / Part of #228. Keep #236 open until merge.
 *
 * Chloe UI only. Migrate in place on the current canvas engine (D6).
 * Undo/redo covers node move / add / remove / connect before save.
 * Session layout is not D1 persist (#238). Invalid YAML still never
 * guesses a graph — history stores YAML + optional position hints;
 * projection still goes through validate summary only. Save stays
 * normalize → PUT draft. No draft execute. No apps/api changes.
 */

import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";

export const R23_STORY = 236;
export const R23_EPIC = 228;
export const R23_KEEP_STORY_OPEN = true;

export const EDITOR_CANVAS_HISTORY_LIMIT = 50;
export const EDITOR_CANVAS_MOVE_THRESHOLD_PX = 3;

export const EDITOR_CANVAS_UNDO_SHORTCUT = "Ctrl+Z";
export const EDITOR_CANVAS_REDO_SHORTCUT = "Ctrl+Shift+Z";
export const EDITOR_CANVAS_DELETE_SHORTCUT = "Delete";
export const EDITOR_CANVAS_UNDO_LABEL = `Undo (${EDITOR_CANVAS_UNDO_SHORTCUT})`;
export const EDITOR_CANVAS_REDO_LABEL = `Redo (${EDITOR_CANVAS_REDO_SHORTCUT})`;

export const EDITOR_CANVAS_HISTORY_HELP =
  "Pan, zoom (Ctrl+wheel), select, drag nodes. Connect output → compatible input. Undo (Ctrl+Z) · Redo (Ctrl+Shift+Z). Delete removes the selected node or edge.";

export type CanvasHistoryKind =
  | "move"
  | "add"
  | "remove"
  | "connect"
  | "disconnect";

export type CanvasPoint = { x: number; y: number };
export type CanvasLayout = Record<string, CanvasPoint>;

export type CanvasHistorySnapshot = {
  yaml: string;
  layout: CanvasLayout;
};

export type CanvasHistoryState = {
  past: CanvasHistorySnapshot[];
  present: CanvasHistorySnapshot;
  future: CanvasHistorySnapshot[];
};

export type CanvasShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
};

export const EDITOR_CANVAS_HISTORY = {
  kinds: ["move", "add", "remove", "connect", "disconnect"] as const,
  keyboardLabeled: true,
  undoShortcut: EDITOR_CANVAS_UNDO_SHORTCUT,
  redoShortcut: EDITOR_CANVAS_REDO_SHORTCUT,
  deleteShortcut: EDITOR_CANVAS_DELETE_SHORTCUT,
  sessionLayoutOnly: true,
  layoutNeverInventGraph: true,
  invalidYamlNeverGuessesGraph: true,
  saveNormalizesThenPutsDraft: true,
  noDraftExecute: true,
  noAppsApiChanges: true,
  migrateInPlace: true,
  noGreenfieldPackage: true,
  d1LayoutPersistOutOfScope: true,
  multiSelectFitSnapOutOfScope: true,
  embedPathUnchanged: true,
  limit: EDITOR_CANVAS_HISTORY_LIMIT,
} as const;

export function cloneCanvasLayout(layout: CanvasLayout = {}): CanvasLayout {
  const next: CanvasLayout = {};
  for (const id of Object.keys(layout).sort()) {
    const point = layout[id];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    next[id] = { x: point.x, y: point.y };
  }
  return next;
}

export function cloneCanvasSnapshot(
  snapshot: CanvasHistorySnapshot,
): CanvasHistorySnapshot {
  return {
    yaml: snapshot.yaml,
    layout: cloneCanvasLayout(snapshot.layout),
  };
}

export function canvasLayoutsEqual(
  left: CanvasLayout = {},
  right: CanvasLayout = {},
): boolean {
  const a = cloneCanvasLayout(left);
  const b = cloneCanvasLayout(right);
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((id) => {
    const first = a[id];
    const second = b[id];
    return Boolean(first && second && first.x === second.x && first.y === second.y);
  });
}

export function canvasSnapshotsEqual(
  left: CanvasHistorySnapshot,
  right: CanvasHistorySnapshot,
): boolean {
  return left.yaml === right.yaml && canvasLayoutsEqual(left.layout, right.layout);
}

/**
 * Apply session position hints onto auto-layout. Unknown ids are
 * ignored — layout never invents nodes or edges.
 */
export function mergeCanvasPositions(
  auto: Map<string, CanvasPoint>,
  overrides: CanvasLayout = {},
): Map<string, CanvasPoint> {
  const next = new Map(auto);
  for (const [id, point] of Object.entries(overrides)) {
    if (!next.has(id)) {
      continue;
    }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    next.set(id, { x: point.x, y: point.y });
  }
  return next;
}

export function pruneCanvasLayout(
  layout: CanvasLayout,
  nodeIds: readonly string[],
): CanvasLayout {
  const allowed = new Set(nodeIds);
  const next: CanvasLayout = {};
  for (const [id, point] of Object.entries(cloneCanvasLayout(layout))) {
    if (allowed.has(id)) {
      next[id] = point;
    }
  }
  return next;
}

export function emptyCanvasHistory(
  yaml: string,
  layout: CanvasLayout = {},
): CanvasHistoryState {
  return {
    past: [],
    present: { yaml, layout: cloneCanvasLayout(layout) },
    future: [],
  };
}

export function pushCanvasHistory(
  state: CanvasHistoryState,
  next: CanvasHistorySnapshot,
  limit = EDITOR_CANVAS_HISTORY_LIMIT,
): CanvasHistoryState {
  const present = cloneCanvasSnapshot(next);
  if (canvasSnapshotsEqual(state.present, present)) {
    return state;
  }
  const past = [...state.past, cloneCanvasSnapshot(state.present)];
  while (past.length > limit) {
    past.shift();
  }
  return { past, present, future: [] };
}

export function replaceCanvasHistoryPresent(
  state: CanvasHistoryState,
  present: CanvasHistorySnapshot,
): CanvasHistoryState {
  return {
    ...state,
    present: cloneCanvasSnapshot(present),
  };
}

export function canUndoCanvasHistory(state: CanvasHistoryState): boolean {
  return state.past.length > 0;
}

export function canRedoCanvasHistory(state: CanvasHistoryState): boolean {
  return state.future.length > 0;
}

export function undoCanvasHistory(state: CanvasHistoryState): {
  state: CanvasHistoryState;
  applied: CanvasHistorySnapshot;
} | null {
  if (state.past.length === 0) {
    return null;
  }
  const past = state.past.slice(0, -1);
  const present = cloneCanvasSnapshot(state.past[state.past.length - 1]!);
  return {
    state: {
      past,
      present,
      future: [cloneCanvasSnapshot(state.present), ...state.future],
    },
    applied: present,
  };
}

export function redoCanvasHistory(state: CanvasHistoryState): {
  state: CanvasHistoryState;
  applied: CanvasHistorySnapshot;
} | null {
  if (state.future.length === 0) {
    return null;
  }
  const [next, ...future] = state.future;
  if (!next) {
    return null;
  }
  const present = cloneCanvasSnapshot(next);
  return {
    state: {
      past: [...state.past, cloneCanvasSnapshot(state.present)],
      present,
      future,
    },
    applied: present,
  };
}

export function canvasMovedEnough(
  dx: number,
  dy: number,
  threshold = EDITOR_CANVAS_MOVE_THRESHOLD_PX,
): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

function canvasModifier(event: CanvasShortcutEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export function isCanvasUndoShortcut(event: CanvasShortcutEvent): boolean {
  return (
    canvasModifier(event) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "z"
  );
}

export function isCanvasRedoShortcut(event: CanvasShortcutEvent): boolean {
  if (!canvasModifier(event) || event.altKey) {
    return false;
  }
  if (event.key.toLowerCase() === "y" && !event.shiftKey) {
    return true;
  }
  return event.key.toLowerCase() === "z" && event.shiftKey;
}

export function isCanvasDeleteShortcut(event: CanvasShortcutEvent): boolean {
  return (
    !canvasModifier(event) &&
    !event.altKey &&
    (event.key === "Delete" || event.key === "Backspace")
  );
}

export function shortcutTargetIsEditable(
  target:
    | {
        tagName?: string;
        isContentEditable?: boolean;
        closest?: (selector: string) => unknown;
      }
    | null
    | undefined,
): boolean {
  if (!target) {
    return false;
  }
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (typeof target.closest === "function") {
    return Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
  }
  return false;
}

export function canvasUndoControlLabel(): string {
  return EDITOR_CANVAS_UNDO_LABEL;
}

export function canvasRedoControlLabel(): string {
  return EDITOR_CANVAS_REDO_LABEL;
}

export function canvasHistoryEmbedUnchanged(): boolean {
  return EDITOR_CANVAS_HISTORY.embedPathUnchanged && editorEmbedRouteUnchanged();
}
