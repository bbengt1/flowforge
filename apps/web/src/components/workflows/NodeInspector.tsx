"use client";

import { useState } from "react";
import {
  CONDITION_OPS,
  MAP_CONVERT_KINDS,
  STOP_STATUSES,
  formatBounds,
  formatPolicy,
  formatPort,
  formatRedaction,
  isCoreNeutralNodeType,
  type CoreNeutralPaletteEntry,
} from "@/lib/workflow-core-nodes";
import {
  configFromNode,
  type CoreNodeWith,
  type MapPath,
  type SetField,
  type SetFieldKind,
  type YamlWorkflowNode,
} from "@/lib/workflow-yaml-nodes";

type NodeInspectorProps = {
  nodes: YamlWorkflowNode[];
  selectedId: string | null;
  entries: CoreNeutralPaletteEntry[];
  pending: boolean;
  onSelect: (id: string) => void;
  onApply: (id: string, name: string, config: CoreNodeWith) => string[];
};

export function NodeInspector({
  nodes,
  selectedId,
  entries,
  pending,
  onSelect,
  onApply,
}: NodeInspectorProps) {
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const placeable = nodes.filter((node) => isCoreNeutralNodeType(node.type));
  const catalogEntry =
    selected && isCoreNeutralNodeType(selected.type)
      ? entries.find((entry) => entry.type === selected.type)
      : undefined;

  return (
    <section
      aria-labelledby="inspector-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="inspector-heading" className="text-base font-semibold">
        Node config
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Bounded <code className="font-mono text-xs">with</code> fields from
        catalog <code className="font-mono text-xs">allowedWith</code>. No
        expression language and no secrets in YAML.
      </p>

      {placeable.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600">
          Insert a core node from the palette to configure it.
        </p>
      ) : (
        <ul className="mt-4 space-y-1">
          {placeable.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => onSelect(node.id)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                  node.id === selectedId
                    ? "bg-teal-50 font-medium text-teal-950"
                    : "bg-zinc-50 text-zinc-800 hover:bg-zinc-100"
                }`}
              >
                <span className="font-mono text-xs">{node.id}</span>
                <span className="mx-1 text-zinc-400">·</span>
                {node.name || node.type}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && isCoreNeutralNodeType(selected.type) ? (
        <NodeConfigForm
          key={selected.id}
          node={selected}
          entry={catalogEntry}
          pending={pending}
          onApply={onApply}
        />
      ) : selected && !isCoreNeutralNodeType(selected.type) ? (
        <p className="mt-4 text-sm text-zinc-600">
          {selected.type} is not an E3.3 core neutral node. Edit it in YAML.
        </p>
      ) : null}
    </section>
  );
}

function NodeConfigForm({
  node,
  entry,
  pending,
  onApply,
}: {
  node: YamlWorkflowNode;
  entry?: CoreNeutralPaletteEntry;
  pending: boolean;
  onApply: (id: string, name: string, config: CoreNodeWith) => string[];
}) {
  const parsed = configFromNode(node);
  const [name, setName] = useState(node.name);
  const [config, setConfig] = useState<CoreNodeWith | null>(parsed);
  const [errors, setErrors] = useState<string[]>([]);

  if (!config) {
    return (
      <p className="mt-4 text-sm text-zinc-600">
        Could not read bounded <code className="font-mono text-xs">with</code>{" "}
        fields for this node.
      </p>
    );
  }

  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setErrors(onApply(node.id, name, config));
      }}
    >
      <p className="font-mono text-xs text-zinc-500">{node.type}</p>
      {entry ? <CatalogHints entry={entry} /> : null}
      <label className="block text-sm">
        <span className="text-zinc-600">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
        />
      </label>
      <ConfigFields config={config} onChange={setConfig} />
      {errors.length > 0 ? (
        <ul className="space-y-1 text-sm text-amber-900">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
      >
        Write YAML
      </button>
    </form>
  );
}

function CatalogHints({ entry }: { entry: CoreNeutralPaletteEntry }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
      <p className="font-mono">
        {[
          ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
          ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
        ].join(" · ") || "no ports"}
      </p>
      {entry.allowedWith.length > 0 ? (
        <p className="mt-1">
          allowedWith:{" "}
          {entry.allowedWith
            .map((field) => (field.required ? `${field.name}*` : field.name))
            .join(", ")}
        </p>
      ) : null}
      {formatPolicy(entry.policy) ? <p className="mt-1">policy: {formatPolicy(entry.policy)}</p> : null}
      {formatBounds(entry.bounds) ? <p>bounds: {formatBounds(entry.bounds)}</p> : null}
      {formatRedaction(entry.redaction) ? (
        <p>redaction: {formatRedaction(entry.redaction)}</p>
      ) : null}
    </div>
  );
}

function ConfigFields({
  config,
  onChange,
}: {
  config: CoreNodeWith;
  onChange: (next: CoreNodeWith) => void;
}) {
  switch (config.type) {
    case "flow.condition":
      return (
        <>
          <SelectField
            label="op"
            value={config.op}
            options={CONDITION_OPS}
            onChange={(op) =>
              onChange({
                ...config,
                op: op as typeof config.op,
                compare: op === "exists" ? "" : config.compare,
              })
            }
          />
          <TextField
            label="path"
            value={config.path}
            hint="Optional dotted identifier path — not an expression."
            onChange={(path) => onChange({ ...config, path })}
          />
          {config.op !== "exists" ? (
            <TextField
              label="compare"
              value={config.compare}
              hint="Required literal compare value unless op is exists."
              onChange={(compare) => onChange({ ...config, compare })}
            />
          ) : (
            <p className="text-xs text-zinc-500">exists must not include compare.</p>
          )}
        </>
      );
    case "flow.delay":
      return (
        <TextField
          label="duration"
          value={config.duration}
          hint="ISO-8601 weeks/days/time only. Max P7D. Years and months are rejected."
          onChange={(duration) => onChange({ ...config, duration })}
        />
      );
    case "data.set":
      return (
        <>
          <SetFieldsEditor
            fields={config.fields}
            onChange={(fields) => onChange({ ...config, fields })}
          />
          <SelectField
            label="classification"
            value={config.classification || ""}
            options={["", "public", "internal"]}
            onChange={(classification) => onChange({ ...config, classification })}
          />
        </>
      );
    case "data.map":
      return (
        <MapFieldsEditor
          mapping={config.mapping}
          onChange={(mapping) => onChange({ ...config, mapping })}
        />
      );
    case "data.validate":
      return (
        <>
          <SelectField
            label="schema.type"
            value={config.schemaType}
            options={["object", "array", "string", "integer", "boolean"]}
            onChange={(schemaType) => onChange({ ...config, schemaType })}
          />
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={config.additionalProperties}
              onChange={(event) =>
                onChange({ ...config, additionalProperties: event.target.checked })
              }
            />
            additionalProperties
          </label>
        </>
      );
    case "flow.stop":
      return (
        <>
          <SelectField
            label="status"
            value={config.status}
            options={STOP_STATUSES}
            onChange={(status) =>
              onChange({ ...config, status: status as typeof config.status })
            }
          />
          <TextField
            label="message"
            value={config.message}
            hint="Operator-facing; no internals or secrets. allowedWith is status + message only."
            onChange={(message) => onChange({ ...config, message })}
          />
        </>
      );
    case "flow.fail":
      return (
        <>
          <TextField
            label="code"
            value={config.code}
            hint="Required. DNS label or 2–4 dotted labels (for example tenant.denied)."
            onChange={(code) => onChange({ ...config, code })}
          />
          <TextField
            label="message"
            value={config.message}
            hint="Optional operator-facing message. Do not emit status — unknown-field."
            onChange={(message) => onChange({ ...config, message })}
          />
        </>
      );
  }
}

function SetFieldsEditor({
  fields,
  onChange,
}: {
  fields: SetField[];
  onChange: (fields: SetField[]) => void;
}) {
  const kinds: SetFieldKind[] = ["string", "number", "boolean", "null"];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-zinc-600">value fields</legend>
      {fields.map((field, index) => (
        <div key={`${field.key}-${index}`} className="space-y-1 rounded-lg border border-zinc-100 p-2">
          <input
            aria-label={`Field ${index + 1} key`}
            value={field.key}
            placeholder="key"
            onChange={(event) =>
              onChange(replaceAt(fields, index, { ...field, key: event.target.value }))
            }
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs"
          />
          <div className="flex gap-2">
            <select
              aria-label={`Field ${index + 1} type`}
              value={field.kind}
              onChange={(event) =>
                onChange(
                  replaceAt(fields, index, {
                    ...field,
                    kind: event.target.value as SetFieldKind,
                  }),
                )
              }
              className="w-28 rounded-lg border border-zinc-300 px-2 py-1.5 text-xs"
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <input
              aria-label={`Field ${index + 1} value`}
              value={field.value}
              disabled={field.kind === "null"}
              onChange={(event) =>
                onChange(replaceAt(fields, index, { ...field, value: event.target.value }))
              }
              className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs disabled:bg-zinc-50"
            />
          </div>
          <button
            type="button"
            onClick={() => onChange(fields.filter((_, item) => item !== index))}
            className="text-xs text-zinc-600 underline"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...fields, { key: "", kind: "string", value: "" }])}
        className="text-sm text-teal-800 underline decoration-teal-200 underline-offset-2"
      >
        Add field
      </button>
    </fieldset>
  );
}

function MapFieldsEditor({
  mapping,
  onChange,
}: {
  mapping: MapPath[];
  onChange: (mapping: MapPath[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-zinc-600">mapping dest → from</legend>
      {mapping.map((row, index) => (
        <div key={`${row.dest}-${index}`} className="space-y-1 rounded-lg border border-zinc-100 p-2">
          <input
            aria-label={`Mapping ${index + 1} dest`}
            value={row.dest}
            placeholder="dest.path"
            onChange={(event) =>
              onChange(replaceAt(mapping, index, { ...row, dest: event.target.value }))
            }
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs"
          />
          <input
            aria-label={`Mapping ${index + 1} from`}
            value={row.from}
            placeholder="source.path"
            onChange={(event) =>
              onChange(replaceAt(mapping, index, { ...row, from: event.target.value }))
            }
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs"
          />
          <select
            aria-label={`Mapping ${index + 1} convert`}
            value={row.convert ?? ""}
            onChange={(event) =>
              onChange(
                replaceAt(mapping, index, {
                  ...row,
                  convert: event.target.value || undefined,
                }),
              )
            }
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 text-xs"
          >
            <option value="">no convert</option>
            {MAP_CONVERT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onChange(mapping.filter((_, item) => item !== index))}
            className="text-xs text-zinc-600 underline"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...mapping, { dest: "", from: "" }])}
        className="text-sm text-teal-800 underline decoration-teal-200 underline-offset-2"
      >
        Add mapping
      </button>
    </fieldset>
  );
}

function TextField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm"
      />
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option || "unset"} value={option}>
            {option || "(unset)"}
          </option>
        ))}
      </select>
    </label>
  );
}

function replaceAt<T>(items: T[], index: number, next: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}
