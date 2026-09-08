"use client";

import { useState } from "react";
import {
  CONDITION_OPS,
  STOP_STATUSES,
  isCoreNeutralNodeType,
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
  pending: boolean;
  onSelect: (id: string) => void;
  onApply: (id: string, name: string, config: CoreNodeWith) => string[];
};

export function NodeInspector({
  nodes,
  selectedId,
  pending,
  onSelect,
  onApply,
}: NodeInspectorProps) {
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const placeable = nodes.filter((node) => isCoreNeutralNodeType(node.type));

  return (
    <section
      aria-labelledby="inspector-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="inspector-heading" className="text-base font-semibold">
        Node config
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Bounded <code className="font-mono text-xs">with</code> fields only. No
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
  pending,
  onApply,
}: {
  node: YamlWorkflowNode;
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
            onChange={(op) => onChange({ ...config, op: op as typeof config.op })}
          />
          <TextField
            label="path"
            value={config.path}
            hint="Field path only — not an expression."
            onChange={(path) => onChange({ ...config, path })}
          />
          {config.op !== "exists" ? (
            <TextField
              label="compare"
              value={config.compare}
              hint="Literal compare value."
              onChange={(compare) => onChange({ ...config, compare })}
            />
          ) : null}
        </>
      );
    case "flow.delay":
      return (
        <TextField
          label="duration"
          value={config.duration}
          hint="ISO-8601 duration, for example PT5M."
          onChange={(duration) => onChange({ ...config, duration })}
        />
      );
    case "data.set":
      return (
        <SetFieldsEditor
          fields={config.fields}
          onChange={(fields) => onChange({ ...config, fields })}
        />
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
        <TextField
          label="schema"
          value={config.schema}
          hint="Declared schema reference (UUID when the workspace has one)."
          onChange={(schema) => onChange({ ...config, schema })}
        />
      );
    case "flow.stop":
    case "flow.fail":
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
            label="code"
            value={config.code}
            onChange={(code) => onChange({ ...config, code })}
          />
          <TextField
            label="message"
            value={config.message}
            hint="Operator-facing; no internals or secrets."
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
      <legend className="text-sm text-zinc-600">mapping paths</legend>
      {mapping.map((row, index) => (
        <div key={`${row.from}-${index}`} className="space-y-1 rounded-lg border border-zinc-100 p-2">
          <input
            aria-label={`Mapping ${index + 1} from`}
            value={row.from}
            placeholder="from path"
            onChange={(event) =>
              onChange(replaceAt(mapping, index, { ...row, from: event.target.value }))
            }
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs"
          />
          <input
            aria-label={`Mapping ${index + 1} to`}
            value={row.to}
            placeholder="to path"
            onChange={(event) =>
              onChange(replaceAt(mapping, index, { ...row, to: event.target.value }))
            }
            className="w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-xs"
          />
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
        onClick={() => onChange([...mapping, { from: "", to: "" }])}
        className="text-sm text-teal-800 underline decoration-teal-200 underline-offset-2"
      >
        Add path
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
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function replaceAt<T>(items: T[], index: number, next: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}
