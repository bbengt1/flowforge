/**
 * R2.4: multi-select, fit-to-view, and snap-to-grid on `/workflows/{id}`.
 *
 * Relates to #237 / Part of #228. Keep #237 open until merge.
 *
 * Chloe UI only. Migrate in place on the current canvas engine (D6).
 * Session layout is not D1 persist (#238). Invalid YAML still never
 * guesses a graph. Save stays normalize → PUT draft. No draft execute.
 * No apps/api changes. No greenfield canvas package.
 */

import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import type { CanvasLayout, CanvasPoint } from "./editor-canvas-history.ts";

export const R24_STORY = 237;
export const R24_EPIC = 228;
export const R24_KEEP_STORY_OPEN = true;

export const CANVAS_GRID_SIZE = 16;
export const CANVAS_FIT_PADDING = 48;
export const CANVAS_NODE_WIDTH = 188;
export const CANVAS_NODE_HEIGHT = 96;
export const CANVAS_MIN_SCALE = 0.4;
export const CANVAS_MAX_SCALE = 2.2;

export const EDITOR_CANVAS_FIT_SHORTCUT = "F";
export const EDITOR_CANVAS_SNAP_SHORTCUT = "G";
export const EDITOR_CANVAS_SELECT_ALL_SHORTCUT = "Ctrl+A";
export const EDITOR_CANVAS_FIT_LABEL = `Fit (${EDITOR_CANVAS_FIT_SHORTCUT})`;
export const EDITOR_CANVAS_SNAP_LABEL = `Snap (${EDITOR_CANVAS_SNAP_SHORTCUT})`;

export const EDITOR_CANVAS_PRIMITIVES_HELP =
  "Pan, zoom (Ctrl+wheel), select, drag nodes. Shift+click or Shift+drag to multi-select. Ctrl+A selects all. Fit (F) frames the selection (or the graph). Snap (G) locks drops to the 16px grid. Connect output → compatible input. Undo (Ctrl+Z) · Redo (Ctrl+Shift+Z). Delete removes the selection.";

export type EditorSelection =
  | { kind: "workflow" }
  | { kind: "node"; id: string; ids?: readonly string[] }
  | { kind: "edge"; from: string; to: string };

export type CanvasViewport = { width: number; height: number };
export type CanvasRect = { x: number; y: number; width: number; height: number };

export type CanvasShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
};

export const EDITOR_CANVAS_PRIMITIVES = {
  multiSelect: true,
  fitToView: true,
  snapToGrid: true,
  gridSize: CANVAS_GRID_SIZE,
  marqueeWithShift: true,
  keyboardLabeled: true,
  selectAllShortcut: EDITOR_CANVAS_SELECT_ALL_SHORTCUT,
  fitShortcut: EDITOR_CANVAS_FIT_SHORTCUT,
  snapShortcut: EDITOR_CANVAS_SNAP_SHORTCUT,
  sessionLayoutOnly: true,
  layoutNeverInventGraph: true,
  invalidYamlNeverGuessesGraph: true,
  saveNormalizesThenPutsDraft: true,
  noDraftExecute: true,
  noAppsApiChanges: true,
  migrateInPlace: true,
  noGreenfieldPackage: true,
  d1LayoutPersistOutOfScope: true,
  embedPathUnchanged: true,
} as const;

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

export function selectedNodeIds(selection: EditorSelection | null | undefined): string[] {
  if (selection?.kind !== "node") {
    return [];
  }
  const listed = selection.ids?.length ? [...selection.ids] : [selection.id];
  if (!listed.includes(selection.id)) {
    listed.unshift(selection.id);
  }
  return uniqueIds(listed);
}

export function primarySelectedNodeId(
  selection: EditorSelection | null | undefined,
): string | null {
  if (selection?.kind !== "node") {
    return null;
  }
  return selection.id;
}

export function isNodeSelected(
  selection: EditorSelection | null | undefined,
  id: string,
): boolean {
  return selectedNodeIds(selection).includes(id);
}

export function nodeSelection(id: string, ids: readonly string[] = [id]): EditorSelection {
  const unique = uniqueIds(ids.length > 0 ? ids : [id]);
  if (unique.length === 0) {
    return { kind: "workflow" };
  }
  const primary = unique.includes(id) ? id : unique[unique.length - 1]!;
  if (unique.length === 1) {
    return { kind: "node", id: primary };
  }
  return { kind: "node", id: primary, ids: unique };
}

export function selectNodes(
  ids: readonly string[],
  primary = ids[ids.length - 1],
): EditorSelection {
  return nodeSelection(primary ?? "", ids);
}

export function toggleNodeInSelection(
  selection: EditorSelection | null | undefined,
  id: string,
): EditorSelection {
  const current = selectedNodeIds(selection);
  const has = current.includes(id);
  const next = has ? current.filter((item) => item !== id) : [...current, id];
  if (next.length === 0) {
    return { kind: "workflow" };
  }
  const primary = has ? (next[next.length - 1] ?? next[0]!) : id;
  return nodeSelection(primary, next);
}

export function unionNodeSelection(
  selection: EditorSelection | null | undefined,
  ids: readonly string[],
): EditorSelection {
  const next = uniqueIds([...selectedNodeIds(selection), ...ids]);
  if (next.length === 0) {
    return { kind: "workflow" };
  }
  const primary = ids[ids.length - 1] ?? next[next.length - 1]!;
  return nodeSelection(primary, next);
}

export function normalizeCanvasRect(start: CanvasPoint, end: CanvasPoint): CanvasRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function rectsIntersect(a: CanvasRect, b: CanvasRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function nodesInMarquee(
  positions: Map<string, CanvasPoint> | CanvasLayout,
  start: CanvasPoint,
  end: CanvasPoint,
  nodeWidth = CANVAS_NODE_WIDTH,
  nodeHeight = CANVAS_NODE_HEIGHT,
): string[] {
  const rect = normalizeCanvasRect(start, end);
  if (rect.width < 2 && rect.height < 2) {
    return [];
  }
  const source =
    positions instanceof Map ? positions : new Map(Object.entries(positions));
  const hits: string[] = [];
  for (const [id, point] of source) {
    if (
      rectsIntersect(rect, {
        x: point.x,
        y: point.y,
        width: nodeWidth,
        height: nodeHeight,
      })
    ) {
      hits.push(id);
    }
  }
  return hits;
}

export function snapCoord(value: number, grid = CANVAS_GRID_SIZE): number {
  if (!Number.isFinite(value) || grid <= 0) {
    return value;
  }
  return Math.round(value / grid) * grid;
}

export function snapPoint(
  point: CanvasPoint,
  enabled = true,
  grid = CANVAS_GRID_SIZE,
): CanvasPoint {
  if (!enabled) {
    return { x: point.x, y: point.y };
  }
  return { x: snapCoord(point.x, grid), y: snapCoord(point.y, grid) };
}

export function applyNodeMoves(
  origins: CanvasLayout,
  ids: readonly string[],
  dx: number,
  dy: number,
  snap = false,
  grid = CANVAS_GRID_SIZE,
): CanvasLayout {
  const next: CanvasLayout = {};
  for (const id of ids) {
    const origin = origins[id];
    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
      continue;
    }
    next[id] = snapPoint({ x: origin.x + dx, y: origin.y + dy }, snap, grid);
  }
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fitCanvasViewport(input: {
  positions: Map<string, CanvasPoint> | CanvasLayout;
  ids?: readonly string[];
  viewport: CanvasViewport;
  nodeWidth?: number;
  nodeHeight?: number;
  padding?: number;
  minScale?: number;
  maxScale?: number;
}): { x: number; y: number; scale: number } {
  const nodeWidth = input.nodeWidth ?? CANVAS_NODE_WIDTH;
  const nodeHeight = input.nodeHeight ?? CANVAS_NODE_HEIGHT;
  const padding = input.padding ?? CANVAS_FIT_PADDING;
  const minScale = input.minScale ?? CANVAS_MIN_SCALE;
  const maxScale = input.maxScale ?? CANVAS_MAX_SCALE;
  if (input.viewport.width <= 0 || input.viewport.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const source =
    input.positions instanceof Map
      ? input.positions
      : new Map(Object.entries(input.positions));
  const wanted =
    input.ids && input.ids.length > 0 ? input.ids : [...source.keys()];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of wanted) {
    const point = source.get(id);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + nodeWidth);
    maxY = Math.max(maxY, point.y + nodeHeight);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, scale: 1 };
  }
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const availableW = Math.max(input.viewport.width - padding * 2, 1);
  const availableH = Math.max(input.viewport.height - padding * 2, 1);
  const scale = clamp(Math.min(availableW / width, availableH / height), minScale, maxScale);
  return {
    x: (input.viewport.width - width * scale) / 2 - minX * scale,
    y: (input.viewport.height - height * scale) / 2 - minY * scale,
    scale,
  };
}

export function fitIdsForSelection(
  selection: EditorSelection | null | undefined,
  allIds: readonly string[],
): string[] {
  const selected = selectedNodeIds(selection);
  return selected.length > 0 ? selected : [...allIds];
}

function canvasModifier(event: CanvasShortcutEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export function isAdditiveSelectModifier(event: {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (event.altKey) {
    return false;
  }
  return Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
}

export function isSelectAllShortcut(event: CanvasShortcutEvent): boolean {
  return (
    canvasModifier(event) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  );
}

export function isFitShortcut(event: CanvasShortcutEvent): boolean {
  if (canvasModifier(event) || event.altKey || event.shiftKey) {
    return false;
  }
  const key = event.key.toLowerCase();
  return key === "f" || key === "1";
}

export function isSnapShortcut(event: CanvasShortcutEvent): boolean {
  if (canvasModifier(event) || event.altKey || event.shiftKey) {
    return false;
  }
  return event.key.toLowerCase() === "g";
}

export function canvasFitControlLabel(): string {
  return EDITOR_CANVAS_FIT_LABEL;
}

export function canvasSnapControlLabel(on = true): string {
  return on ? EDITOR_CANVAS_SNAP_LABEL : `Snap off (${EDITOR_CANVAS_SNAP_SHORTCUT})`;
}

export function multiSelectAnnouncement(input: {
  count: number;
  name?: string | null;
  type?: string | null;
  id?: string | null;
}): string {
  const title = input.name?.trim() || input.id?.trim() || "node";
  const type = input.type?.trim();
  const focus = type ? `${title} (${type})` : title;
  if (input.count <= 1) {
    return type
      ? `Selected ${title} (${type}). Inspector shows name, with fields, pins, and credentials.`
      : `Selected ${title}. Inspector shows name, with fields, pins, and credentials.`;
  }
  return `Selected ${input.count} nodes. Inspector shows ${focus}. Shift+click or Shift+drag to adjust.`;
}

export function canvasPrimitivesEmbedUnchanged(): boolean {
  return EDITOR_CANVAS_PRIMITIVES.embedPathUnchanged && editorEmbedRouteUnchanged();
}
