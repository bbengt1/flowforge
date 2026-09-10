"use client";

import { useMemo, useRef, useState } from "react";
import { ACTION_DRAG_MIME } from "@/components/workflows/ActionLibrary";
import type { ActionLibraryEntry } from "@/lib/workflow-action-library";
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
import type { CatalogPort } from "@/lib/workflow-types";

export type EditorSelection =
  | { kind: "workflow" }
  | { kind: "node"; id: string }
  | { kind: "edge"; from: string; to: string };

type WorkflowCanvasProps = {
  graph: WorkflowGraph | null;
  invalid: boolean;
  pending: boolean;
  selection: EditorSelection;
  entries: ActionLibraryEntry[];
  onSelect: (selection: EditorSelection) => void;
  onInsertType?: (type: string) => void;
  onConnect?: (from: string, to: string) => string[];
  onOpenLibrary?: () => void;
  onAddAction?: () => void;
  readOnly?: boolean;
  currentNodeId?: string;
  heading?: string;
  fill?: boolean;
};

const NODE_W = 188;
const NODE_H = 96;

export function WorkflowCanvas({
  graph,
  invalid,
  pending,
  selection,
  entries,
  onSelect,
  onInsertType,
  onConnect,
  onOpenLibrary,
  onAddAction,
  readOnly = false,
  currentNodeId,
  heading,
  fill = false,
}: WorkflowCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const [linkFrom, setLinkFrom] = useState<{ nodeId: string; port: string } | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const positions = useMemo(
    () => (graph ? layoutGraphNodes(graph.nodes, graph.edges) : new Map()),
    [graph],
  );
  const addAffordance = canvasAddAffordance({
    invalid,
    readOnly,
    nodeCount: graph?.nodes.length ?? 0,
    selectedKind: selection.kind,
  });

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-canvas-node],[data-port]")) {
      return;
    }
    setDragging({ x: event.clientX - pan.x, y: event.clientY - pan.y });
    onSelect({ kind: "workflow" });
  }

  function movePan(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) {
      return;
    }
    setPan((current) => ({ ...current, x: event.clientX - dragging.x, y: event.clientY - dragging.y }));
  }

  function wheelZoom(event: React.WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    setPan((current) => ({
      ...current,
      scale: Math.min(2.2, Math.max(0.4, current.scale * delta)),
    }));
  }

  function portCenter(nodeId: string, port: string, direction: "in" | "out") {
    const pos = positions.get(nodeId) ?? { x: 0, y: 0 };
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
        className={`${frameClass} rounded-2xl border border-amber-200 bg-amber-50 p-5`}
      >
        <h2 id="canvas-heading" className="text-base font-semibold text-amber-950">
          Canvas
        </h2>
        <p className="mt-2 text-sm text-amber-950">
          Invalid YAML is not projected onto the canvas. Fix the errors in
          the validation panel — the editor will not guess a graph.
        </p>
      </section>
    );
  }
  if (!graph) {
    return (
      <section
        aria-labelledby="canvas-heading"
        className={`${frameClass} rounded-2xl border border-zinc-200 bg-white p-5`}
      >
        <h2 id="canvas-heading" className="text-base font-semibold">
          Canvas
        </h2>
        <p className="mt-2 text-sm text-zinc-600">
          {pending
            ? "Validating YAML before drawing the graph…"
            : "The canvas appears after a successful validate. Invalid YAML never becomes a guessed graph."}
        </p>
        {!readOnly && onOpenLibrary ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenLibrary}
              aria-label="Open action library"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-teal-800 bg-teal-800 text-lg font-semibold leading-none text-white hover:bg-teal-900"
            >
              +
            </button>
            {onAddAction ? (
              <button
                type="button"
                onClick={onAddAction}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                Add action
              </button>
            ) : null}
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
          ? "flex h-full min-h-0 flex-col overflow-hidden bg-white"
          : "overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm"
      }
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div>
          <h2 id="canvas-heading" className="text-base font-semibold">
            {heading ?? (readOnly ? "Graph replay" : "Canvas")}
          </h2>
          <p className="text-xs text-zinc-500">
            {readOnly
              ? "Read-only overlay of step status on the pinned published version. Pan, zoom, and select with the keyboard."
              : "Pan, zoom (Ctrl+wheel), select. Connect output → compatible input."}
            {pending ? " Validating…" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {addAffordance.addAction && onOpenLibrary ? (
            <button
              type="button"
              onClick={onOpenLibrary}
              aria-label="Open action library"
              title="Open action library"
              className="rounded-md border border-teal-800 bg-teal-800 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-900"
            >
              +
            </button>
          ) : null}
          {addAffordance.addAction && onAddAction ? (
            <button
              type="button"
              onClick={onAddAction}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50"
            >
              Add action
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPan((current) => ({ ...current, scale: Math.min(2.2, current.scale * 1.1) }))}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
          >
            Zoom in
          </button>
          <button
            type="button"
            onClick={() => setPan((current) => ({ ...current, scale: Math.max(0.4, current.scale * 0.9) }))}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
          >
            Zoom out
          </button>
          <button
            type="button"
            onClick={() => setPan({ x: 0, y: 0, scale: 1 })}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
          >
            Reset
          </button>
        </div>
      </div>
      {connectError ? (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-950">
          {connectError}
        </p>
      ) : null}
      <div
        ref={surfaceRef}
        role="application"
        aria-label="Workflow canvas"
        tabIndex={0}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
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
            onInsertType(type);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setLinkFrom(null);
            onSelect({ kind: "workflow" });
          }
          if (event.key === "+" || event.key === "=") {
            setPan((current) => ({ ...current, scale: Math.min(2.2, current.scale * 1.1) }));
          }
          if (event.key === "-" || event.key === "_") {
            setPan((current) => ({ ...current, scale: Math.max(0.4, current.scale * 0.9) }));
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
            ? "relative min-h-0 flex-1 cursor-grab overflow-hidden bg-[radial-gradient(circle_at_1px_1px,#e4e4e7_1px,transparent_0)] bg-size-[16px_16px] outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
            : "relative h-[28rem] cursor-grab overflow-hidden bg-[radial-gradient(circle_at_1px_1px,#e4e4e7_1px,transparent_0)] bg-size-[16px_16px] outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
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
                  stroke={selected ? "#115e59" : "#71717a"}
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
              x={positions.get(node.id)?.x ?? 0}
              y={positions.get(node.id)?.y ?? 0}
              selected={selection.kind === "node" && selection.id === node.id}
              current={currentNodeId === node.id}
              readOnly={readOnly}
              linkFrom={linkFrom}
              entries={entries}
              onSelect={() => onSelect({ kind: "node", id: node.id })}
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
                addAffordance.selectedPlus && onOpenLibrary
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
        </div>
        {addAffordance.emptyPlus && onOpenLibrary ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-2xl border border-zinc-200 bg-white/95 px-6 py-5 shadow-sm">
              <button
                type="button"
                onClick={onOpenLibrary}
                aria-label="Open action library"
                className="flex h-12 w-12 items-center justify-center rounded-full border border-teal-800 bg-teal-800 text-2xl font-semibold leading-none text-white hover:bg-teal-900"
              >
                +
              </button>
              {onAddAction ? (
                <button
                  type="button"
                  onClick={onAddAction}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
                >
                  Add action
                </button>
              ) : (
                <p className="text-sm text-zinc-600">Add an action to the canvas</p>
              )}
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
  linkFrom,
  entries,
  onSelect,
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
  linkFrom: { nodeId: string; port: string } | null;
  entries: ActionLibraryEntry[];
  onSelect: () => void;
  onOutput: (port: string) => void;
  onInput: (port: string) => void;
  onOpenLibrary?: () => void;
}) {
  return (
    <div
      id={readOnly ? `replay-node-${node.id}` : undefined}
      data-canvas-node={node.id}
      role="group"
      aria-current={current ? "true" : undefined}
      aria-label={`${node.name} ${node.type} ${canvasNodeStateLabel(node.state)}${
        current ? " current node" : ""
      }`}
      tabIndex={0}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`absolute rounded-xl border bg-white px-3 py-2 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-teal-700 ${
        selected || current
          ? "border-teal-800 ring-2 ring-teal-700/30"
          : node.state === "indeterminate"
            ? "border-2 border-amber-700"
            : "border-zinc-300"
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
          className="absolute -right-3 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-teal-800 bg-teal-800 text-sm font-semibold leading-none text-white hover:bg-teal-900"
        >
          +
        </button>
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-900">{node.name || node.id}</p>
          <p className="font-mono text-[11px] text-zinc-500">{node.type}</p>
        </div>
        <p
          className="flex items-center gap-1 text-[11px] font-medium text-zinc-800"
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
      className={`block font-mono text-[10px] ${
        available ? "text-zinc-700 hover:text-teal-800" : "cursor-not-allowed text-zinc-400 line-through"
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
    <ul className="flex flex-wrap gap-2 border-t border-zinc-200 px-4 py-2 text-xs">
      {edges.map((edge) => {
        const selected =
          selection.kind === "edge" && selection.from === edge.from && selection.to === edge.to;
        return (
          <li key={edge.id}>
            <button
              type="button"
              onClick={() => onSelect({ kind: "edge", from: edge.from, to: edge.to })}
              className={`rounded-md px-2 py-1 font-mono ${
                selected ? "bg-teal-50 text-teal-950" : "bg-zinc-50 text-zinc-700"
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
