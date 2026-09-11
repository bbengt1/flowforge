"use client";

import { useState } from "react";
import {
  JONNY_PORT_TYPING_INCOMPLETE,
  NDV_MAPPING_CONVERT_KINDS,
  NDV_MAPPING_EDGE_PORT_ONLY_HELP,
  NDV_MAPPING_NO_EXPRESSION_HELP,
  compatibleUpstreamPortOptions,
  ndvDestAcceptsFieldPathMapping,
  ndvFieldPathError,
  ndvLooksLikeExpression,
  ndvPortTypingIncomplete,
  ndvPortWiresForNode,
  rowsFromMappingValue,
  validateNdvTypedMapping,
  type NdvPortWire,
  type NdvTypedPortMapping,
} from "@/lib/editor-ndv-mapping";
import { formatPort } from "@/lib/workflow-core-nodes";
import type { ActionLibraryEntry } from "@/lib/workflow-action-library";
import type { WorkflowCatalog } from "@/lib/workflow-types";
import type { YamlWorkflowEdge, YamlWorkflowNode } from "@/lib/workflow-yaml-nodes";

export type NdvMappingPanelProps = {
  node: YamlWorkflowNode;
  nodes: readonly YamlWorkflowNode[];
  edges: readonly YamlWorkflowEdge[] | { from: string; to: string }[];
  entries: readonly ActionLibraryEntry[];
  catalog?: WorkflowCatalog | null;
  canEdit?: boolean;
  pending?: boolean;
  suggestedFromPaths?: readonly string[];
  onRewireInput?: (nodeId: string, toPort: string, from: string | null) => string[];
  onPatchMapping?: (nodeId: string, mapping: Record<string, unknown>) => void;
  onPatchPath?: (nodeId: string, path: string) => void;
};

export function NdvMappingPanel({
  node,
  nodes,
  edges,
  entries,
  catalog,
  canEdit = true,
  pending = false,
  suggestedFromPaths = [],
  onRewireInput,
  onPatchMapping,
  onPatchPath,
}: NdvMappingPanelProps) {
  const entry = entries.find((item) => item.type === node.type);
  const typing = ndvPortTypingIncomplete(entry, node.type);
  const wires = ndvPortWiresForNode({
    node,
    nodes,
    edges,
    catalog,
    entries,
  });
  const acceptsPaths = ndvDestAcceptsFieldPathMapping(
    node.type,
    undefined,
    entry?.allowedWith,
  );

  return (
    <section
      data-ndv-panel="mapping"
      aria-labelledby="ndv-mapping-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="ndv-mapping-heading" className="text-base font-semibold">
        Mapping
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Typed field paths between catalog ports. {NDV_MAPPING_NO_EXPRESSION_HELP}{" "}
        {NDV_MAPPING_EDGE_PORT_ONLY_HELP}
      </p>
      {typing.incomplete ? (
        <p role="status" className="mt-2 text-sm text-amber-950" data-ndv-port-typing="incomplete">
          {typing.reason ?? JONNY_PORT_TYPING_INCOMPLETE}
        </p>
      ) : null}

      {wires.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-600">
          This step has no catalog input ports to map.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {wires.map((wire) => (
            <PortWireRow
              key={wire.input.name}
              wire={wire}
              node={node}
              nodes={nodes}
              catalog={catalog}
              entries={entries}
              disabled={!canEdit || pending || !onRewireInput}
              onRewire={onRewireInput}
            />
          ))}
        </ul>
      )}

      {node.type === "data.map" && acceptsPaths ? (
        <div className="mt-4">
          <FieldPathMappingEditor
            key={node.id}
            mappingValue={node.with.mapping}
            suggestedFromPaths={suggestedFromPaths}
            disabled={!canEdit || pending || !onPatchMapping}
            onChange={(mapping) => onPatchMapping?.(node.id, mapping)}
          />
        </div>
      ) : null}

      {node.type === "flow.condition" && acceptsPaths ? (
        <ConditionPathField
          value={typeof node.with.path === "string" ? node.with.path : ""}
          suggestedFromPaths={suggestedFromPaths}
          disabled={!canEdit || pending || !onPatchPath}
          onChange={(path) => onPatchPath?.(node.id, path)}
        />
      ) : null}
    </section>
  );
}

export function FieldPathMappingEditor({
  rows,
  mappingValue,
  suggestedFromPaths = [],
  disabled = false,
  onChange,
}: {
  rows?: NdvTypedPortMapping[];
  mappingValue?: unknown;
  suggestedFromPaths?: readonly string[];
  disabled?: boolean;
  onChange: (mapping: Record<string, unknown>) => void;
}) {
  const initial =
    rows ??
    (mappingValue !== undefined
      ? rowsFromMappingValue(mappingValue)
      : [{ dest: "", from: "" }]);
  const [list, setList] = useState<NdvTypedPortMapping[]>(initial);
  const validation = validateNdvTypedMapping(
    list.filter(
      (row) =>
        (row.dest.trim() && row.from.trim()) ||
        ndvLooksLikeExpression(row.dest) ||
        ndvLooksLikeExpression(row.from),
    ),
    {
      fromKind: "object",
      destKind: "object",
    },
  );

  function commit(next: NdvTypedPortMapping[]) {
    setList(next);
    const mapping: Record<string, unknown> = {};
    for (const row of next) {
      const dest = row.dest.trim();
      const from = row.from.trim();
      if (!dest || !from) {
        continue;
      }
      if (ndvFieldPathError(dest) || ndvFieldPathError(from)) {
        continue;
      }
      mapping[dest] = row.convert
        ? { from, convert: row.convert }
        : from;
    }
    onChange(mapping);
  }

  return (
    <fieldset className="space-y-2" data-ndv-field-path-editor="mapping" data-ndv-field="mapping">
      <legend className="text-sm text-zinc-600">dest.path ← source.path</legend>
      <p className="text-xs text-zinc-500">{NDV_MAPPING_NO_EXPRESSION_HELP}</p>
      {list.map((row, index) => (
        <div
          key={`${row.dest}-${index}`}
          className="space-y-1 rounded-lg border border-zinc-100 p-2"
        >
          <label className="block text-xs text-zinc-600">
            Destination
            <input
              aria-label={`Mapping ${index + 1} dest`}
              value={row.dest}
              disabled={disabled}
              placeholder="result.state"
              onChange={(event) =>
                commit(replaceRow(list, index, { ...row, dest: event.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs disabled:bg-zinc-50"
            />
          </label>
          <label className="block text-xs text-zinc-600">
            Source
            <input
              aria-label={`Mapping ${index + 1} from`}
              value={row.from}
              disabled={disabled}
              placeholder="input.status"
              list={suggestedFromPaths.length > 0 ? "ndv-mapping-from-paths" : undefined}
              onChange={(event) =>
                commit(replaceRow(list, index, { ...row, from: event.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs disabled:bg-zinc-50"
            />
          </label>
          <label className="block text-xs text-zinc-600">
            Convert
            <select
              aria-label={`Mapping ${index + 1} convert`}
              value={row.convert ?? ""}
              disabled={disabled}
              onChange={(event) =>
                commit(
                  replaceRow(list, index, {
                    ...row,
                    convert: event.target.value || undefined,
                  }),
                )
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-xs disabled:bg-zinc-50"
            >
              <option value="">no convert</option>
              {NDV_MAPPING_CONVERT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => commit(list.filter((_, item) => item !== index))}
            className="text-xs text-zinc-600 underline disabled:no-underline"
          >
            Remove
          </button>
        </div>
      ))}
      {suggestedFromPaths.length > 0 ? (
        <datalist id="ndv-mapping-from-paths">
          {suggestedFromPaths.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={() => commit([...list, { dest: "", from: "" }])}
        className="text-sm text-teal-800 underline decoration-teal-200 underline-offset-2 disabled:text-zinc-400 disabled:no-underline"
      >
        Add mapping
      </button>
      {validation.errors.length > 0 ? (
        <ul className="space-y-1 text-sm text-amber-900" data-ndv-mapping-errors>
          {validation.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

function ConditionPathField({
  value,
  suggestedFromPaths,
  disabled,
  onChange,
}: {
  value: string;
  suggestedFromPaths: readonly string[];
  disabled: boolean;
  onChange: (path: string) => void;
}) {
  const error = value ? ndvFieldPathError(value, "path") : null;
  return (
    <label className="mt-4 block text-sm" data-ndv-field-path-editor="path" data-ndv-field="path">
      <span className="text-zinc-600">path into value</span>
      <input
        value={value}
        disabled={disabled}
        placeholder="status"
        list={suggestedFromPaths.length > 0 ? "ndv-condition-paths" : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs disabled:bg-zinc-50"
      />
      {suggestedFromPaths.length > 0 ? (
        <datalist id="ndv-condition-paths">
          {suggestedFromPaths.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      ) : null}
      <span className="mt-1 block text-xs text-zinc-500">
        Optional dotted identifier into the inbound value port.
      </span>
      {error ? (
        <span className="mt-1 block text-xs text-amber-900">{error}</span>
      ) : null}
    </label>
  );
}

function PortWireRow({
  wire,
  node,
  nodes,
  catalog,
  entries,
  disabled,
  onRewire,
}: {
  wire: NdvPortWire;
  node: YamlWorkflowNode;
  nodes: readonly YamlWorkflowNode[];
  catalog?: WorkflowCatalog | null;
  entries: readonly ActionLibraryEntry[];
  disabled: boolean;
  onRewire?: (nodeId: string, toPort: string, from: string | null) => string[];
}) {
  const options = compatibleUpstreamPortOptions(
    nodes,
    node,
    wire.input,
    catalog,
    entries,
  );
  return (
    <li className="rounded-lg border border-zinc-100 px-3 py-2">
      <p className="font-mono text-xs text-zinc-600">
        {formatPort(wire.input, "in")}
        {wire.input.required ? " · required" : ""}
      </p>
      <label className="mt-2 block text-xs text-zinc-600">
        Upstream output
        <select
          aria-label={`Map ${wire.input.name} from`}
          value={wire.from ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onRewire?.(node.id, wire.input.name, event.target.value || null)
          }
          className="mt-1 w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-xs disabled:bg-zinc-50"
        >
          <option value="">No mapping</option>
          {wire.from && !options.some((item) => item.from === wire.from) ? (
            <option value={wire.from}>{wire.from} (incompatible)</option>
          ) : null}
          {options.map((item) => (
            <option key={item.from} value={item.from}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {wire.fromPort ? (
        <p className="mt-1 font-mono text-xs text-zinc-500">
          from {formatPort(wire.fromPort, "out")}
        </p>
      ) : null}
      {wire.reason ? (
        <p
          role="status"
          className="mt-1 text-xs text-amber-900"
          data-ndv-mapping-incompatible={wire.compatible ? undefined : "true"}
        >
          {wire.reason}
        </p>
      ) : wire.from ? (
        <p className="mt-1 text-xs text-zinc-600">Ports are compatible.</p>
      ) : null}
    </li>
  );
}

function replaceRow(
  rows: NdvTypedPortMapping[],
  index: number,
  next: NdvTypedPortMapping,
): NdvTypedPortMapping[] {
  return rows.map((row, item) => (item === index ? next : row));
}

