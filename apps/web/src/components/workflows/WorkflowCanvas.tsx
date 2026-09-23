"use client";

import { useMemo, useRef, useState } from "react";
import { ACTION_DRAG_MIME } from "@/components/workflows/ActionLibrary";
import type { ActionLibraryEntry } from "@/lib/workflow-action-library";
import {
  EDITOR_CANVAS_REDO_LABEL,
  EDITOR_CANVAS_UNDO_LABEL,
  canvasMovedEnough,
  isCanvasDeleteShortcut,
  isCanvasRedoShortcut,
  isCanvasUndoShortcut,
  mergeCanvasPositions,
  type CanvasLayout,
  type CanvasPoint,
} from "@/lib/editor-canvas-history";
import {
  CANVAS_GRID_SIZE,
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  EDITOR_CANVAS_FIT_LABEL,
  EDITOR_CANVAS_PRIMITIVES_HELP,
  applyNodeMoves,
  canvasSnapControlLabel,
  fitCanvasViewport,
  fitIdsForSelection,
  isAdditiveSelectModifier,
  isFitShortcut,
  isNodeSelected,
  isSelectAllShortcut,
  isSnapShortcut,
  nodeSelection,
  nodesInMarquee,
  normalizeCanvasRect,
  selectNodes,
  selectedNodeIds,
  snapPoint,
  toggleNodeInSelection,
  unionNodeSelection,
  type EditorSelection,
} from "@/lib/editor-canvas-primitives";

export type { EditorSelection };
import {
  canConnectPorts,
  canvasNodeStateIcon,
  canvasNodeStateLabel,
  formatPortRef,
  layoutGraphNodes,
  type GraphEdge,
  type GraphNode,
  type WorkflowGraph,
} from "@/lib/workflow-graph";
import { canvasAddAffordance } from "@/lib/editor-library";
import { CANVAS_EMPTY_HELP } from "@/lib/empty-states-teach-model";
import type { CatalogPort } from "@/lib/workflow-types";
import { actionFamilyForType } from "@/lib/workflow-action-library";
import {
  FF_EDITOR_CANVAS_CLASS,
  FF_EDITOR_GHOST_CLASS,
  FF_EDITOR_GRID_CLASS,
  FF_EDITOR_INVALID_CLASS,
  FF_EDITOR_MUTED_CLASS,
  FF_EDITOR_NODE_CLASS,
  FF_EDITOR_NODE_SELECTED_CLASS,
  FF_EDITOR_PANEL_CLASS,
  FF_EDITOR_PLUS_CLASS,
  FF_EDITOR_PORT_CLASS,
  FF_EDITOR_TITLE_CLASS,
  editorNodeFamilyMark,
  editorNodeFamilyShapeClass,
} from "@/lib/editor-visual";

type WorkflowCanvasProps = {
  graph: WorkflowGraph | null;
  invalid: boolean;
  pending: boolean;
  selection: EditorSelection;
  entries: ActionLibraryEntry[];
  onSelect: (selection: EditorSelection) => void;
  onInsertType?: (type: string, position?: CanvasPoint) => void;
  onConnect?: (from: string, to: string) => string[];
  onMove?: (positions: CanvasLayout) => void;
  onRemove?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  layout?: CanvasLayout;
  onOpenLibrary?: () => void;
  onAddAction?: () => void;
  readOnly?: boolean;
  currentNodeId?: string;
  heading?: string;
  help?: string;
  fill?: boolean;
};

const NODE_W = CANVAS_NODE_WIDTH;
const NODE_H = CANVAS_NODE_HEIGHT;

export function WorkflowCanvas({
  graph,
  invalid,
  pending,
  selection,
  entries,
  onSelect,
  onInsertType,
  onConnect,
  onMove,
  onRemove,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  layout = {},
  onOpenLibrary,
  onAddAction,
  readOnly = false,
  currentNodeId,
  heading,
  help,
  fill = false,
}: WorkflowCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const [linkFrom, setLinkFrom] = useState<{ nodeId: string; port: string } | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [marquee, setMarquee] = useState<{ start: CanvasPoint; current: CanvasPoint } | null>(
    null,
  );
  const [nodeDrag, setNodeDrag] = useState<{
    id: string;
    ids: string[];
    startClientX: number;
    startClientY: number;
    origins: CanvasLayout;
    dx: number;
    dy: number;
  } | null>(null);

  const positions = useMemo(() => {
    if (!graph) {
      return new Map<string, CanvasPoint>();
    }
    return mergeCanvasPositions(layoutGraphNodes(graph.nodes, graph.edges), layout);
  }, [graph, layout]);
  const addAffordance = canvasAddAffordance({
    invalid,
    readOnly,
    nodeCount: graph?.nodes.length ?? 0,
    selectedKind: selection.kind,
  });

  function canvasPoint(event: { clientX: number; clientY: number }): CanvasPoint {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return {
      x: (event.clientX - rect.left - pan.x) / pan.scale,
      y: (event.clientY - rect.top - pan.y) / pan.scale,
    };
  }

  function nodePosition(id: string): CanvasPoint {
    const base = positions.get(id) ?? { x: 0, y: 0 };
    if (nodeDrag?.ids.includes(id)) {
      const origin = nodeDrag.origins[id] ?? base;
      return snapPoint(
        { x: origin.x + nodeDrag.dx, y: origin.y + nodeDrag.dy },
        snapEnabled,
      );
    }
    return base;
  }

  function startNodeDrag(id: string, event: React.PointerEvent) {
    if (readOnly || !onMove || event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement).closest("[data-port],button")) {
      return;
    }
    if (isAdditiveSelectModifier(event)) {
      return;
    }
    const ids = isNodeSelected(selection, id) ? selectedNodeIds(selection) : [id];
    const origins: CanvasLayout = {};
    for (const nodeId of ids) {
      origins[nodeId] = positions.get(nodeId) ?? { x: 0, y: 0 };
    }
    setNodeDrag({
      id,
      ids,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origins,
      dx: 0,
      dy: 0,
    });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function moveNodeDrag(event: React.PointerEvent) {
    if (!nodeDrag) {
      return;
    }
    setNodeDrag({
      ...nodeDrag,
      dx: (event.clientX - nodeDrag.startClientX) / pan.scale,
      dy: (event.clientY - nodeDrag.startClientY) / pan.scale,
    });
  }

  function endNodeDrag() {
    if (!nodeDrag) {
      return;
    }
    if (onMove && canvasMovedEnough(nodeDrag.dx, nodeDrag.dy)) {
      onMove(applyNodeMoves(nodeDrag.origins, nodeDrag.ids, nodeDrag.dx, nodeDrag.dy, snapEnabled));
    }
    setNodeDrag(null);
  }

  function selectCanvasNode(id: string, event: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) {
    if (isAdditiveSelectModifier(event)) {
      onSelect(toggleNodeInSelection(selection, id));
      return;
    }
    if (!isNodeSelected(selection, id)) {
      onSelect(nodeSelection(id));
    }
  }

  function fitToView() {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || !graph || graph.nodes.length === 0) {
      return;
    }
    setPan(
      fitCanvasViewport({
        positions,
        ids: fitIdsForSelection(
          selection,
          graph.nodes.map((node) => node.id),
        ),
        viewport: { width: rect.width, height: rect.height },
        nodeWidth: NODE_W,
        nodeHeight: NODE_H,
        minScale: CANVAS_MIN_SCALE,
        maxScale: CANVAS_MAX_SCALE,
      }),
    );
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (nodeDrag) {
      return;
    }
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-canvas-node],[data-port]")) {
      return;
    }
    if (isAdditiveSelectModifier(event)) {
      const point = canvasPoint(event);
      setMarquee({ start: point, current: point });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    setDragging({ x: event.clientX - pan.x, y: event.clientY - pan.y });
    onSelect({ kind: "workflow" });
  }

  function movePan(event: React.PointerEvent<HTMLDivElement>) {
    if (marquee) {
      setMarquee({ ...marquee, current: canvasPoint(event) });
      return;
    }
    if (!dragging) {
      return;
    }
    setPan((current) => ({ ...current, x: event.clientX - dragging.x, y: event.clientY - dragging.y }));
  }

  function endSurfacePointer() {
    if (marquee && graph) {
      const ids = nodesInMarquee(positions, marquee.start, marquee.current, NODE_W, NODE_H);
      if (ids.length > 0) {
        onSelect(unionNodeSelection(selection, ids));
      }
      setMarquee(null);
      return;
    }
    setMarquee(null);
    setDragging(null);
  }

  function wheelZoom(event: React.WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    setPan((current) => ({
      ...current,
      scale: Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, current.scale * delta)),
    }));
  }

  function portCenter(nodeId: string, port: string, direction: "in" | "out") {
    const pos = nodePosition(nodeId);
    const node = graph?.nodes.find((item) => item.id === nodeId);
    const list = direction === "in" ? node?.inputs ?? [] : node?.outputs ?? [];
    const index = Math.max(0, list.findIndex((item) => item.name === port));
    return {
      x: pos.x + (direction === "in" ? 0 : NODE_W),
      y: pos.y + 36 + index * 16,
    };
  }

  function tryConnect(toNode: string, toPort: string) {
    if (!linkFrom) {
      return;
    }
    const from = formatPortRef({ nodeId: linkFrom.nodeId, port: linkFrom.port });
    const to = formatPortRef({ nodeId: toNode, port: toPort });
    if (!onConnect) {
      setLinkFrom(null);
      return;
    }
    const errors = onConnect(from, to);
    setConnectError(errors[0] ?? null);
    setLinkFrom(null);
  }

  const frameClass = fill
    ? "flex h-full min-h-0 flex-col"
    : "flex min-h-[28rem] flex-col";

  if (invalid) {
    return (
      <section
        aria-labelledby="canvas-heading"
        className={`${frameClass} rounded-2xl border p-5 ${FF_EDITOR_INVALID_CLASS}`}
      >
        <h2 id="canvas-heading" className="text-base font-semibold">
          Canvas
        </h2>
        <p className="mt-2 text-sm">
          Invalid YAML is not projected onto the canvas. Fix the errors in
          the validation panel — the editor will not guess a graph.
        </p>
        {!readOnly && canUndo && onUndo ? (
          <button
            type="button"
            data-editor-history="undo"
            title={EDITOR_CANVAS_UNDO_LABEL}
            aria-keyshortcuts="Control+Z Meta+Z"
            onClick={onUndo}
            className={`mt-4 px-3 py-1.5 text-sm ${FF_EDITOR_GHOST_CLASS}`}
          >
            {EDITOR_CANVAS_UNDO_LABEL}
          </button>
        ) : null}
      </section>
    );
  }
  if (!graph) {
    return (
      <section
        aria-labelledby="canvas-heading"
        className={`${frameClass} rounded-2xl border p-5 ${FF_EDITOR_PANEL_CLASS}`}
      >
        <h2 id="canvas-heading" className={`text-base font-semibold ${FF_EDITOR_TITLE_CLASS}`}>
          Canvas
        </h2>
        <p className={`mt-2 text-sm ${FF_EDITOR_MUTED_CLASS}`}>
          {pending
            ? "Validating YAML before drawing the graph…"
            : "The canvas appears after a successful validate. Invalid YAML never becomes a guessed graph."}
        </p>
        {!readOnly && onOpenLibrary ? (
          <div className="mt-4 space-y-3" data-uxl6="canvas-empty">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onOpenLibrary}
                aria-label="Open action library"
                className={`flex h-9 w-9 items-center justify-center text-lg font-semibold leading-none ${FF_EDITOR_PLUS_CLASS}`}
              >
                +
              </button>
              {onAddAction ? (
                <button
                  type="button"
                  onClick={onAddAction}
                  className={`px-3 py-1.5 text-sm ${FF_EDITOR_GHOST_CLASS}`}
                >
                  Add action
                </button>
              ) : null}
            </div>
            <p className={`text-sm ${FF_EDITOR_MUTED_CLASS}`}>{CANVAS_EMPTY_HELP}</p>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="canvas-heading"
      className={
        fill
          ? `flex h-full min-h-0 flex-col overflow-hidden ${FF_EDITOR_CANVAS_CLASS}`
          : `overflow-hidden rounded-2xl border ${FF_EDITOR_CANVAS_CLASS}`
      }
    >
      <div className="ff-editor-satellite-header flex items-center justify-between px-4 py-3">
        <div>
          <h2 id="canvas-heading" className={`text-base font-semibold ${FF_EDITOR_TITLE_CLASS}`}>
            {heading ?? (readOnly ? "Graph replay" : "Canvas")}
          </h2>
          <p className={`text-xs ${FF_EDITOR_MUTED_CLASS}`}>
            {help
              ?? (readOnly
                ? "Read-only overlay of step status on the pinned published version. Pan, zoom, Shift+click or Shift+drag to multi-select, Fit (F)."
                : EDITOR_CANVAS_PRIMITIVES_HELP)}
            {pending ? " Validating…" : ""}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {!readOnly && onUndo ? (
            <button
              type="button"
              data-editor-history="undo"
              title={EDITOR_CANVAS_UNDO_LABEL}
              aria-keyshortcuts="Control+Z Meta+Z"
              onClick={onUndo}
              disabled={!canUndo}
              className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs disabled:opacity-60`}
            >
              {EDITOR_CANVAS_UNDO_LABEL}
            </button>
          ) : null}
          {!readOnly && onRedo ? (
            <button
              type="button"
              data-editor-history="redo"
              title={EDITOR_CANVAS_REDO_LABEL}
              aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
              onClick={onRedo}
              disabled={!canRedo}
              className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs disabled:opacity-60`}
            >
              {EDITOR_CANVAS_REDO_LABEL}
            </button>
          ) : null}
          {addAffordance.addAction && onOpenLibrary ? (
            <button
              type="button"
              onClick={onOpenLibrary}
              aria-label="Open action library"
              title="Open action library"
              className={`${FF_EDITOR_PLUS_CLASS} px-2 py-1 text-xs font-semibold`}
            >
              +
            </button>
          ) : null}
          {addAffordance.addAction && onAddAction ? (
            <button
              type="button"
              onClick={onAddAction}
              className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs`}
            >
              Add action
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPan((current) => ({ ...current, scale: Math.min(CANVAS_MAX_SCALE, current.scale * 1.1) }))}
            className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs`}
          >
            Zoom in
          </button>
          <button
            type="button"
            onClick={() => setPan((current) => ({ ...current, scale: Math.max(CANVAS_MIN_SCALE, current.scale * 0.9) }))}
            className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs`}
          >
            Zoom out
          </button>
          <button
            type="button"
            data-editor-canvas="fit"
            title={EDITOR_CANVAS_FIT_LABEL}
            aria-keyshortcuts="f 1"
            onClick={fitToView}
            className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs`}
          >
            {EDITOR_CANVAS_FIT_LABEL}
          </button>
          {!readOnly ? (
            <button
              type="button"
              data-editor-canvas="snap"
              title={canvasSnapControlLabel(snapEnabled)}
              aria-pressed={snapEnabled}
              aria-keyshortcuts="g"
              onClick={() => setSnapEnabled((current) => !current)}
              className={`${snapEnabled ? FF_EDITOR_PLUS_CLASS : FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs`}
            >
              {canvasSnapControlLabel(snapEnabled)}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPan({ x: 0, y: 0, scale: 1 })}
            className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-xs`}
          >
            Reset
          </button>
        </div>
      </div>
      {connectError ? (
        <p className={`border-b px-4 py-2 text-xs ${FF_EDITOR_INVALID_CLASS}`}>
          {connectError}
        </p>
      ) : null}
      <div
        ref={surfaceRef}
        role="application"
        aria-label="Workflow canvas"
        data-canvas-grid={CANVAS_GRID_SIZE}
        tabIndex={0}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endSurfacePointer}
        onPointerCancel={endSurfacePointer}
        onWheel={wheelZoom}
        onDragOver={(event) => {
          if (readOnly || !onInsertType) {
            return;
          }
          if ([...event.dataTransfer.types].includes(ACTION_DRAG_MIME)) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if (readOnly || !onInsertType) {
            return;
          }
          const type = event.dataTransfer.getData(ACTION_DRAG_MIME);
          if (type) {
            event.preventDefault();
            onInsertType(type, snapPoint(canvasPoint(event), snapEnabled));
          }
        }}
        onKeyDown={(event) => {
          if (isCanvasUndoShortcut(event)) {
            event.preventDefault();
            onUndo?.();
            return;
          }
          if (isCanvasRedoShortcut(event)) {
            event.preventDefault();
            onRedo?.();
            return;
          }
          if (isCanvasDeleteShortcut(event) && !readOnly) {
            event.preventDefault();
            onRemove?.();
            return;
          }
          if (isSelectAllShortcut(event) && graph.nodes.length > 0) {
            event.preventDefault();
            onSelect(selectNodes(graph.nodes.map((node) => node.id)));
            return;
          }
          if (isFitShortcut(event)) {
            event.preventDefault();
            fitToView();
            return;
          }
          if (isSnapShortcut(event)) {
            event.preventDefault();
            setSnapEnabled((current) => !current);
            return;
          }
          if (event.key === "Escape") {
            setLinkFrom(null);
            setMarquee(null);
            onSelect({ kind: "workflow" });
          }
          if (event.key === "+" || event.key === "=") {
            setPan((current) => ({ ...current, scale: Math.min(CANVAS_MAX_SCALE, current.scale * 1.1) }));
          }
          if (event.key === "-" || event.key === "_") {
            setPan((current) => ({ ...current, scale: Math.max(CANVAS_MIN_SCALE, current.scale * 0.9) }));
          }
          if (event.key === "ArrowLeft") {
            setPan((current) => ({ ...current, x: current.x + 24 }));
          }
          if (event.key === "ArrowRight") {
            setPan((current) => ({ ...current, x: current.x - 24 }));
          }
          if (event.key === "ArrowUp") {
            setPan((current) => ({ ...current, y: current.y + 24 }));
          }
          if (event.key === "ArrowDown") {
            setPan((current) => ({ ...current, y: current.y - 24 }));
          }
        }}
        className={
          fill
            ? `relative min-h-0 flex-1 cursor-grab overflow-hidden outline-none ${FF_EDITOR_GRID_CLASS}`
            : `relative h-[28rem] cursor-grab overflow-hidden outline-none ${FF_EDITOR_GRID_CLASS}`
        }
      >
        <div
          className="absolute inset-0 origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.scale})` }}
        >
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={1200}
            height={800}
          >
            {graph.edges.map((edge) => {
              const start = portCenter(edge.fromRef.nodeId, edge.fromRef.port, "out");
              const end = portCenter(edge.toRef.nodeId, edge.toRef.port, "in");
              const selected =
                selection.kind === "edge" &&
                selection.from === edge.from &&
                selection.to === edge.to;
              return (
                <path
                  key={edge.id}
                  d={`M ${start.x} ${start.y} C ${start.x + 48} ${start.y}, ${end.x - 48} ${end.y}, ${end.x} ${end.y}`}
                  fill="none"
                  stroke={
                    selected
                      ? "var(--ff-accent)"
                      : "color-mix(in srgb, var(--ff-text) 28%, transparent)"
                  }
                  strokeWidth={selected ? 2.5 : 1.5}
                />
              );
            })}
          </svg>
          {graph.nodes.map((node) => (
            <CanvasNode
              key={node.id}
              node={node}
              nodes={graph.nodes}
              x={nodePosition(node.id).x}
              y={nodePosition(node.id).y}
              selected={isNodeSelected(selection, node.id)}
              current={currentNodeId === node.id}
              readOnly={readOnly}
              dragging={Boolean(nodeDrag?.ids.includes(node.id))}
              linkFrom={linkFrom}
              entries={entries}
              onSelect={(event) => selectCanvasNode(node.id, event)}
              onDragStart={(event) => startNodeDrag(node.id, event)}
              onDragMove={moveNodeDrag}
              onDragEnd={endNodeDrag}
              onOutput={(port) => {
                if (readOnly) {
                  return;
                }
                setConnectError(null);
                setLinkFrom({ nodeId: node.id, port });
              }}
              onInput={(port) => {
                if (readOnly) {
                  return;
                }
                tryConnect(node.id, port);
              }}
              onOpenLibrary={
                addAffordance.selectedPlus &&
                onOpenLibrary &&
                selection.kind === "node" &&
                selection.id === node.id
                  ? onOpenLibrary
                  : undefined
              }
            />
          ))}
          {graph.edges.map((edge) => (
            <button
              key={`${edge.id}-hit`}
              type="button"
              aria-label={`Edge ${edge.from} to ${edge.to}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect({ kind: "edge", from: edge.from, to: edge.to });
              }}
              className="sr-only"
            >
              {edge.from} → {edge.to}
            </button>
          ))}
          {marquee ? (
            <div
              data-canvas-marquee
              aria-hidden
              className="pointer-events-none absolute border border-[var(--ff-accent)] bg-[color-mix(in_srgb,var(--ff-accent)_16%,transparent)]"
              style={(() => {
                const box = normalizeCanvasRect(marquee.start, marquee.current);
                return {
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                };
              })()}
            />
          ) : null}
        </div>
        {addAffordance.emptyPlus && onOpenLibrary ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              data-uxl6="canvas-empty"
              className={`pointer-events-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border px-6 py-5 ${FF_EDITOR_PANEL_CLASS}`}
            >
              <button
                type="button"
                onClick={onOpenLibrary}
                aria-label="Open action library"
                className={`flex h-12 w-12 items-center justify-center rounded-full text-2xl font-semibold leading-none ${FF_EDITOR_PLUS_CLASS}`}
              >
                +
              </button>
              {onAddAction ? (
                <button
                  type="button"
                  onClick={onAddAction}
                  className={`px-3 py-1.5 text-sm ${FF_EDITOR_GHOST_CLASS}`}
                >
                  Add action
                </button>
              ) : (
                <p className={`text-sm ${FF_EDITOR_MUTED_CLASS}`}>Add an action to the canvas</p>
              )}
              <p className={`text-center text-sm ${FF_EDITOR_MUTED_CLASS}`}>{CANVAS_EMPTY_HELP}</p>
            </div>
          </div>
        ) : null}
      </div>
      <EdgeList edges={graph.edges} selection={selection} onSelect={onSelect} />
    </section>
  );
}

function CanvasNode({
  node,
  nodes,
  x,
  y,
  selected,
  current,
  readOnly,
  dragging,
  linkFrom,
  entries,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onOutput,
  onInput,
  onOpenLibrary,
}: {
  node: GraphNode;
  nodes: GraphNode[];
  x: number;
  y: number;
  selected: boolean;
  current?: boolean;
  readOnly?: boolean;
  dragging?: boolean;
  linkFrom: { nodeId: string; port: string } | null;
  entries: ActionLibraryEntry[];
  onSelect: (event: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) => void;
  onDragStart?: (event: React.PointerEvent) => void;
  onDragMove?: (event: React.PointerEvent) => void;
  onDragEnd?: () => void;
  onOutput: (port: string) => void;
  onInput: (port: string) => void;
  onOpenLibrary?: () => void;
}) {
  const family = actionFamilyForType(node.type);
  const familyMark = editorNodeFamilyMark(family);
  const familyShape = editorNodeFamilyShapeClass(family);
  return (
    <div
      id={readOnly ? `replay-node-${node.id}` : undefined}
      data-canvas-node={node.id}
      data-editor-node-family={family}
      role="group"
      aria-current={current ? "true" : undefined}
      aria-label={`${node.name} ${node.type} ${canvasNodeStateLabel(node.state)}${
        current ? " current node" : ""
      }${selected ? " selected" : ""}`}
      tabIndex={0}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(event);
        onDragStart?.(event);
      }}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(event);
        }
      }}
      className={`absolute px-3 py-2 outline-none ${FF_EDITOR_NODE_CLASS} ${familyShape} ${
        dragging ? "cursor-grabbing" : "cursor-grab"
      } ${
        selected || current
          ? FF_EDITOR_NODE_SELECTED_CLASS
          : node.state === "indeterminate"
            ? "border-2 border-amber-700"
            : ""
      }`}
      style={{ left: x, top: y, width: NODE_W, minHeight: NODE_H }}
    >
      {selected && onOpenLibrary ? (
        <button
          type="button"
          aria-label="Open action library"
          title="Add action"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onOpenLibrary();
          }}
          className={`absolute -right-3 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 rounded-full text-sm font-semibold leading-none ${FF_EDITOR_PLUS_CLASS}`}
        >
          +
        </button>
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <span
              aria-hidden
              className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--ff-border)] px-1 font-mono text-[10px] font-semibold"
              title={family}
            >
              {familyMark}
            </span>
            <span>{node.name || node.id}</span>
          </p>
          <p className={`font-mono text-[11px] ${FF_EDITOR_MUTED_CLASS}`}>{node.type}</p>
        </div>
        <p
          className="flex items-center gap-1 text-[11px] font-medium"
          aria-label={`State ${canvasNodeStateLabel(node.state)}`}
        >
          <span aria-hidden>{canvasNodeStateIcon(node.state)}</span>
          <span>{canvasNodeStateLabel(node.state)}</span>
        </p>
      </div>
      <div className="mt-2 flex justify-between gap-2">
        <div className="space-y-1">
          {node.inputs.map((port) => (
            <PortButton
              key={`in-${port.name}`}
              port={port}
              direction="in"
              available={!readOnly && inputAvailable(node, nodes, port, linkFrom, entries)}
              onClick={() => onInput(port.name)}
            />
          ))}
        </div>
        <div className="space-y-1 text-right">
          {node.outputs.map((port) => (
            <PortButton
              key={`out-${port.name}`}
              port={port}
              direction="out"
              available={!readOnly}
              onClick={() => onOutput(port.name)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function inputAvailable(
  node: GraphNode,
  nodes: GraphNode[],
  port: CatalogPort,
  linkFrom: { nodeId: string; port: string } | null,
  entries: ActionLibraryEntry[],
): boolean {
  if (!linkFrom) {
    return true;
  }
  if (linkFrom.nodeId === node.id) {
    return false;
  }
  const source = nodes.find((item) => item.id === linkFrom.nodeId);
  if (!source) {
    return false;
  }
  return canConnectPorts(
    null,
    source.type,
    linkFrom.port,
    node.type,
    port.name,
    entries,
  ).ok;
}

function PortButton({
  port,
  direction,
  available,
  onClick,
}: {
  port: CatalogPort;
  direction: "in" | "out";
  available: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-port={`${direction}:${port.name}`}
      disabled={!available}
      title={
        available
          ? `${direction} ${port.name} (${port.kind})`
          : `${port.name} unavailable: incompatible type or same node`
      }
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`block font-mono text-[10px] ${FF_EDITOR_PORT_CLASS} ${
        available ? "" : "cursor-not-allowed line-through opacity-50"
      }`}
    >
      {direction === "in" ? `● ${port.name}` : `${port.name} ●`}
      <span className="sr-only">
        {available ? "" : " unavailable"} {port.kind}
      </span>
    </button>
  );
}

function EdgeList({
  edges,
  selection,
  onSelect,
}: {
  edges: GraphEdge[];
  selection: EditorSelection;
  onSelect: (selection: EditorSelection) => void;
}) {
  if (edges.length === 0) {
    return null;
  }
  return (
    <ul className="ff-editor-satellite-header flex flex-wrap gap-2 px-4 py-2 text-xs">
      {edges.map((edge) => {
        const selected =
          selection.kind === "edge" && selection.from === edge.from && selection.to === edge.to;
        return (
          <li key={edge.id}>
            <button
              type="button"
              onClick={() => onSelect({ kind: "edge", from: edge.from, to: edge.to })}
              className={`rounded-md px-2 py-1 font-mono ${
                selected ? FF_EDITOR_PLUS_CLASS : FF_EDITOR_GHOST_CLASS
              }`}
            >
              {edge.from} → {edge.to}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
