"use client";

import { Field } from "@/components/a11y/Field";
import {
  ndvParameterPatchValue,
  ndvSafeDisplayObjectLines,
  ndvSafeDisplayScalar,
  sanitizeNdvParameterPatch,
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
          onChange={(value) => onPatch(sanitizeNdvParameterPatch(editor.name, value))}
        />
      ))}
      {advanced.length > 0 ? (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-fg">
            Advanced
          </summary>
          <div className="mt-3 space-y-3">
            {advanced.map((editor) => (
              <NdvParameterField
                key={editor.name}
                editor={editor}
                value={values[editor.name]}
                disabled={disabled}
                onChange={(value) => onPatch(sanitizeNdvParameterPatch(editor.name, value))}
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
      <Field
        id={`ndv-param-${editor.name}`}
        label={label}
        className="flex items-center gap-2 text-sm text-fg"
        labelClassName=""
        controlPlacement="before-label"
        data-ndv-field={editor.name}
      >
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(event.target.checked)}
        />
      </Field>
    );
  }
  if (editor.control === "retry-policy") {
    const policy = ndvParameterPatchValue(editor, value) as { maxAttempts: number };
    return (
      <Field
        id={`ndv-param-${editor.name}`}
        label={label}
        labelClassName="text-fg"
        data-ndv-parameter-control="retry-policy"
        data-ndv-field={editor.name}
        hint={
          editor.description ||
          "maxAttempts only. Default 0. This is not a JSON blob and not a blind retry toggle."
        }
      >
        <input
          type="number"
          min={0}
          max={5}
          value={policy.maxAttempts}
          disabled={disabled || editor.readOnly}
          onChange={(event) =>
            onChange({ maxAttempts: Number(event.target.value) || 0 })
          }
          className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm disabled:bg-bg"
        />
      </Field>
    );
  }
  if (editor.control === "resource-identity") {
    const identity = ndvParameterPatchValue(editor, value) as {
      kind: string;
      name: string;
    };
    return (
      <fieldset
        className="space-y-2 rounded-lg border border-border p-2"
        data-ndv-parameter-control="resource-identity"
        data-ndv-field={editor.name}
      >
        <legend className="text-sm text-fg">{label}</legend>
        <Field
          id={`ndv-param-${editor.name}-kind`}
          label="kind"
          labelClassName="text-fg"
        >
          <input
            value={identity.kind}
            disabled={disabled || editor.readOnly}
            onChange={(event) =>
              onChange({ kind: event.target.value, name: identity.name })
            }
            className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 font-mono text-sm disabled:bg-bg"
          />
        </Field>
        <Field
          id={`ndv-param-${editor.name}-name`}
          label="name"
          labelClassName="text-fg"
        >
          <input
            value={identity.name}
            disabled={disabled || editor.readOnly}
            onChange={(event) =>
              onChange({ kind: identity.kind, name: event.target.value })
            }
            className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 font-mono text-sm disabled:bg-bg"
          />
        </Field>
        {editor.description ? (
          <p className="text-xs text-fg">{editor.description}</p>
        ) : null}
      </fieldset>
    );
  }
  if (editor.control === "enum") {
    const text = ndvSafeDisplayScalar(value) || ndvSafeDisplayScalar(editor.defaultValue);
    return (
      <Field
        id={`ndv-param-${editor.name}`}
        label={label}
        labelClassName="text-fg"
        data-ndv-field={editor.name}
        hint={editor.description}
      >
        <select
          value={text}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm disabled:bg-bg"
        >
          {(editor.enumValues ?? []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (editor.control === "object-lines") {
    return (
      <Field
        id={`ndv-param-${editor.name}`}
        label={label}
        labelClassName="text-fg"
        data-ndv-parameter-control="object-lines"
        data-ndv-field={editor.name}
        hint={
          editor.description ||
          "Typed key=value lines. Not a JSON blob, secret field, or expression."
        }
      >
        <textarea
          value={ndvSafeDisplayObjectLines(value)}
          disabled={disabled || editor.readOnly}
          onChange={(event) =>
            onChange(ndvParameterPatchValue(editor, event.target.value))
          }
          rows={4}
          className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 font-mono text-sm disabled:bg-bg"
        />
      </Field>
    );
  }
  if (editor.control === "textarea") {
    return (
      <Field
        id={`ndv-param-${editor.name}`}
        label={label}
        labelClassName="text-fg"
        data-ndv-field={editor.name}
        hint={editor.description}
      >
        <textarea
          value={ndvSafeDisplayScalar(value)}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(event.target.value)}
          rows={editor.name === "manifests" || editor.name === "source" ? 8 : 4}
          className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 font-mono text-sm disabled:bg-bg"
        />
      </Field>
    );
  }
  if (editor.control === "number") {
    return (
      <Field
        id={`ndv-param-${editor.name}`}
        label={label}
        labelClassName="text-fg"
        data-ndv-field={editor.name}
        hint={editor.description}
      >
        <input
          type="number"
          value={ndvSafeDisplayScalar(value === undefined ? editor.defaultValue : value)}
          disabled={disabled || editor.readOnly}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 text-sm disabled:bg-bg"
        />
      </Field>
    );
  }
  return (
    <Field
      id={`ndv-param-${editor.name}`}
      label={label}
      labelClassName="text-fg"
      data-ndv-field={editor.name}
      hint={editor.description}
    >
      <input
        value={ndvSafeDisplayScalar(value === undefined ? editor.defaultValue : value)}
        readOnly={editor.readOnly}
        disabled={disabled || editor.readOnly}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-border px-3 py-1.5 font-mono text-sm disabled:bg-bg"
      />
    </Field>
  );
}
