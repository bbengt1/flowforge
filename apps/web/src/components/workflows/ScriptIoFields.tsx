"use client";

import { useState } from "react";
import { isInventedCatalogSource } from "@/lib/catalog-fail-closed";
import {
  SCRIPT_IO_CONTRACT_FALLBACK_HELP,
  SCRIPT_IO_ENV_HELP,
  SCRIPT_IO_HANDLE_HELP,
  SCRIPT_IO_ROUTE_MAP_SOURCE,
  SCRIPT_IO_SCHEMA_HELP,
  SCRIPT_IO_SIZE_HELP,
  looksLikeScriptIoNameTypeStub,
  parseScriptIoSchemaText,
  patchScriptIoSchemaBounds,
  scriptIoBounds,
  scriptIoCatalog,
  scriptIoSizeBoundsFromSchema,
  stringifyScriptIoSchema,
  validateScriptIoSchema,
  type ScriptIoCatalog,
} from "@/lib/script-io-contract";

type ScriptIoFieldsProps = {
  inputSchema?: unknown;
  outputSchema?: unknown;
  catalog?: ScriptIoCatalog | null;
  disabled?: boolean;
  onChange: (patch: { inputSchema?: unknown; outputSchema?: unknown }) => void;
};

export function ScriptIoFields({
  inputSchema,
  outputSchema,
  catalog,
  disabled,
  onChange,
}: ScriptIoFieldsProps) {
  const bounds = scriptIoBounds(catalog);
  return (
    <fieldset className="space-y-4 rounded-xl border border-zinc-200 px-4 py-3">
      <legend className="px-1 text-sm font-medium">Typed I/O schema</legend>
      <p className="text-xs text-zinc-500">
        {SCRIPT_IO_SCHEMA_HELP} {SCRIPT_IO_SIZE_HELP} Inputs are validated
        against the schema and the catalog 16 KiB bound before inject. Outputs
        are schema/size checked and redacted before persist.{" "}
        {SCRIPT_IO_HANDLE_HELP} {SCRIPT_IO_ENV_HELP} Map source{" "}
        <code className="font-mono">{SCRIPT_IO_ROUTE_MAP_SOURCE}</code>
        {catalog?.source ? ` · ${catalog.source}` : ""}.
      </p>
      {isInventedCatalogSource(catalog?.source) ? (
        <p className="text-xs text-amber-950">{SCRIPT_IO_CONTRACT_FALLBACK_HELP}</p>
      ) : null}
      <SchemaEditor
        name="inputSchema"
        label="Input schema"
        value={inputSchema}
        disabled={disabled}
        onChange={(next) => onChange({ inputSchema: next })}
      />
      <SizeBoundFields
        label="Input size bounds"
        schema={inputSchema}
        maxBytes={bounds.maxInputBytes}
        disabled={disabled}
        onChange={(next) => onChange({ inputSchema: next })}
      />
      <SchemaEditor
        name="outputSchema"
        label="Output schema"
        value={outputSchema}
        disabled={disabled}
        onChange={(next) => onChange({ outputSchema: next })}
      />
      <SizeBoundFields
        label="Output size bounds"
        schema={outputSchema}
        maxBytes={bounds.maxOutputBytes}
        disabled={disabled}
        onChange={(next) => onChange({ outputSchema: next })}
      />
      <p className="text-xs text-zinc-600">
        Catalog cap is {bounds.maxInputBytes} input bytes and{" "}
        {bounds.maxOutputBytes} output bytes. Secrets fail closed. Handles TTL{" "}
        {scriptIoCatalog(catalog).io.handleTTLSeconds}s (max{" "}
        {scriptIoCatalog(catalog).io.handleMaxTTLSeconds}s).
      </p>
    </fieldset>
  );
}

function SchemaEditor({
  name,
  label,
  value,
  disabled,
  onChange,
}: {
  name: string;
  label: string;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<{ text: string; error?: string } | null>(
    null,
  );
  const text = draft?.text ?? stringifyScriptIoSchema(value);
  const parseError = draft?.error;
  const stub =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    looksLikeScriptIoNameTypeStub(value as Record<string, unknown>);
  const errors = validateScriptIoSchema(name, value);
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        value={text}
        disabled={disabled}
        rows={8}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          const parsed = parseScriptIoSchemaText(next);
          if (parsed.error) {
            setDraft({ text: next, error: parsed.error });
            return;
          }
          setDraft(null);
          onChange(parsed.value);
        }}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm disabled:bg-zinc-50"
      />
      {stub ? (
        <span className="mt-1 block text-xs text-amber-950">
          Name=type stubs are coerced to the documented JSON Schema subset on
          display. Save writes the object form the API validates.
        </span>
      ) : null}
      {parseError ? (
        <span className="mt-1 block text-xs text-rose-900">{parseError}</span>
      ) : errors.length > 0 ? (
        <ul className="mt-1 space-y-1 text-xs text-rose-900">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : (
        <span className="mt-1 block text-xs text-zinc-500">
          Optional. Empty means no declared schema. Secrets and handles are
          rejected.
        </span>
      )}
    </label>
  );
}

function SizeBoundFields({
  label,
  schema,
  maxBytes,
  disabled,
  onChange,
}: {
  label: string;
  schema: unknown;
  maxBytes: number;
  disabled?: boolean;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const bounds = scriptIoSizeBoundsFromSchema(schema);
  const current =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : undefined;
  return (
    <div>
      <p className="text-xs font-medium text-zinc-700">{label}</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <NumberBound
          label="maxProperties"
          value={bounds.maxProperties}
          max={32}
          disabled={disabled}
          onChange={(maxProperties) =>
            onChange(patchScriptIoSchemaBounds(current, { maxProperties }))
          }
        />
        <NumberBound
          label="maxItems"
          value={bounds.maxItems}
          max={32}
          disabled={disabled}
          onChange={(maxItems) =>
            onChange(patchScriptIoSchemaBounds(current, { maxItems }))
          }
        />
        <NumberBound
          label="maxLength"
          value={bounds.maxLength}
          max={maxBytes}
          disabled={disabled}
          onChange={(maxLength) =>
            onChange(patchScriptIoSchemaBounds(current, { maxLength }))
          }
        />
      </div>
    </div>
  );
}

function NumberBound({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value?: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="font-medium text-zinc-700">{label}</span>
      <input
        type="number"
        min={0}
        max={max}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next)) {
            onChange(next);
          }
        }}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
      />
    </label>
  );
}
