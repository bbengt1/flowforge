"use client";

import {
  formatNdvObjectLines,
  ndvParameterPatchValue,
  stringifyNdvScalar,
  type NdvParameterEditor,
  type NdvParameterFamily,
} from "@/lib/editor-ndv-parameters";

type NdvParameterEditorsProps = {
  family: NdvParameterFamily;
  editors: NdvParameterEditor[];
  values: Record<string, unknown>;
  disabled?: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
};

export function NdvParameterEditors({
  family,
  editors,
  values,
  disabled = false,
  onPatch,
}: NdvParameterEditorsProps) {
  if (editors.length === 0 || family === "unknown" || family === "core") {
    return null;
  }
  const primary = editors.filter((editor) => !editor.advanced);
  const advanced = editors.filter((editor) => editor.advanced);
  return (
    <div
      data-ndv-parameter-family={family}
      className="space-y-3"
    >
      {primary.map((editor) => (
        <NdvParameterField
          key={editor.name}
          editor={editor}
          value={values[editor.name]}
          disabled={disabled}
          onChange={(value) => onPatch({ [editor.name]: value })}
        />
      ))}
      {advanced.length > 0 ? (
        <details className="rounded-lg border border-zinc-200 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700">
            Advanced
          </summary>
          <div className="mt-3 space-y-3">
            {advanced.map((editor) => (
              <NdvParameterField
                key={editor.name}
                editor={editor}
                value={values[editor.name]}
                disabled={disabled}
                onChange={(value) => onPatch({ [editor.name]: value })}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function NdvParameterField({
  editor,
  value,
  disabled,
  onChange,
}: {
  editor: NdvParameterEditor;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = editor.required ? editor.label + " *" : editor.label;
  if (editor.control === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  }
  if (editor.control === "retry-policy") {
    const policy = ndvParameterPatchValue(editor, value) as { maxAttempts: number };
    return (
      <label className="block text-sm" data-ndv-parameter-control="retry-policy">
        <span className="text-zinc-600">{label}</span>
        <input
          type="number"
          min={0}
          max={5}
          value={policy.maxAttempts}
          disabled={disabled || editor.readOnly}
          onChange={(event) =>
            onChange({ maxAttempts: Number(event.target.value) || 0 })
          }
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:bg-zinc-50"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          {editor.description ||
            "maxAttempts only. Default 0. This is not a JSON blob and not a blind retry toggle."}
        </span>
      </label>
    );
  }
  if (editor.control === "resource-identity") {
    const identity = ndvParameterPatchValue(editor, value) as {
      kind: string;
      name: string;
    };
    return (
      <fieldset
        className="space-y-2 rounded-lg border border-zinc-100 p-2"
        data-ndv-parameter-control="resource-identity"
      >
        <legend className="text-sm text-zinc-600">{label}</legend>
        <label className="block text-sm">
          <span className="text-zinc-600">kind</span>
          <input
            value={identity.kind}
            disabled={disabled || editor.readOnly}
            onChange={(event) =>
              onChange({ kind: event.target.value, name: identity.name })
            }
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
          />
        </label>
        <label className="block text-sm">
          <span className="text-zinc-600">name</span>
          <input
            value={identity.name}
            disabled={disabled || editor.readOnly}
            onChange={(event) =>
              onChange({ kind: identity.kind, name: event.target.value })
            }
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
          />
        </label>
        {editor.description ? (
          <p className="text-xs text-zinc-500">{editor.description}</p>
        ) : null}
      </fieldset>
    );
  }
  if (editor.control === "enum") {
    const text = stringifyNdvScalar(value) || stringifyNdvScalar(editor.defaultValue);
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">{label}</span>
        <select
          value={text}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:bg-zinc-50"
        >
          {(editor.enumValues ?? []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        {editor.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{editor.description}</span>
        ) : null}
      </label>
    );
  }
  if (editor.control === "object-lines") {
    return (
      <label className="block text-sm" data-ndv-parameter-control="object-lines">
        <span className="text-zinc-600">{label}</span>
        <textarea
          value={formatNdvObjectLines(value)}
          disabled={disabled || editor.readOnly}
          onChange={(event) =>
            onChange(ndvParameterPatchValue(editor, event.target.value))
          }
          rows={4}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          {editor.description ||
            "Typed key=value lines. Not a JSON blob, secret field, or expression."}
        </span>
      </label>
    );
  }
  if (editor.control === "textarea") {
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">{label}</span>
        <textarea
          value={stringifyNdvScalar(value)}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(event.target.value)}
          rows={editor.name === "manifests" || editor.name === "source" ? 8 : 4}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
        />
        {editor.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{editor.description}</span>
        ) : null}
      </label>
    );
  }
  if (editor.control === "number") {
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">{label}</span>
        <input
          type="number"
          value={stringifyNdvScalar(value === undefined ? editor.defaultValue : value)}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:bg-zinc-50"
        />
        {editor.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{editor.description}</span>
        ) : null}
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <input
        value={stringifyNdvScalar(value === undefined ? editor.defaultValue : value)}
        readOnly={editor.readOnly}
        disabled={disabled || editor.readOnly}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
      />
      {editor.description ? (
        <span className="mt-1 block text-xs text-zinc-500">{editor.description}</span>
      ) : null}
    </label>
  );
}
