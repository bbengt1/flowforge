"use client";

import {
  MANUAL_START_INPUT_HELP,
  type ManualStartInputSchema,
} from "@/lib/manual-start-contract";

type ManualStartFieldsProps = {
  schema: ManualStartInputSchema;
  fieldValues: Record<string, string>;
  jsonText: string;
  onFieldValues: (value: Record<string, string>) => void;
  onJsonText: (value: string) => void;
};

export function ManualStartFields({
  schema,
  fieldValues,
  jsonText,
  onFieldValues,
  onJsonText,
}: ManualStartFieldsProps) {
  if (schema.fields.length === 0) {
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">
          Trigger input
          {schema.source === "contract-fallback" ? " (optional JSON)" : ""}
        </span>
        <textarea
          value={jsonText}
          onChange={(event) => onJsonText(event.target.value)}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder='{"dryRun":true}'
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          {MANUAL_START_INPUT_HELP}
        </span>
      </label>
    );
  }

  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm text-zinc-600">Typed start input</legend>
      {schema.fields.map((field) => (
        <label key={field.name} className="block text-sm">
          <span className="text-zinc-600">
            {field.name}
            {field.required ? " (required)" : ""}
          </span>
          {field.type === "boolean" ? (
            <select
              value={fieldValues[field.name] ?? ""}
              onChange={(event) =>
                onFieldValues({ ...fieldValues, [field.name]: event.target.value })
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">{field.required ? "Select…" : "Unset"}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : field.enum ? (
            <select
              value={fieldValues[field.name] ?? ""}
              onChange={(event) =>
                onFieldValues({ ...fieldValues, [field.name]: event.target.value })
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">{field.required ? "Select…" : "Unset"}</option>
              {field.enum.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === "string" ? "text" : "number"}
              value={fieldValues[field.name] ?? ""}
              maxLength={field.maxLength}
              min={field.minimum}
              max={field.maximum}
              step={field.type === "integer" ? 1 : undefined}
              onChange={(event) =>
                onFieldValues({ ...fieldValues, [field.name]: event.target.value })
              }
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-mono text-sm"
            />
          )}
          {field.description ? (
            <span className="mt-1 block text-xs text-zinc-500">
              {field.description}
            </span>
          ) : null}
        </label>
      ))}
    </fieldset>
  );
}
