"use client";

import { SshSafetyNotes } from "@/components/config/SshSafetyNotes";
import { parseJsonObject, specJson } from "@/lib/ops-config";
import type { OpsConfigSpec } from "@/lib/ops-config-types";
import {
  SSH_IMMUTABLE_PIN_HELP,
  SSH_RETRY_SAFE_STUB_HELP,
  SSH_REVIEWED_RENDER_HELP,
} from "@/lib/ssh-contract";
import {
  applyParameterSchemaToSpec,
  parameterSchemaGaps,
  parseParameterSchema,
  templateForbiddenHits,
} from "@/lib/ssh";
import {
  SSH_PARAMETER_TYPES,
  type SshEngineCatalog,
  type SshParameterConstraint,
  type SshParameterType,
} from "@/lib/ssh-types";

type CommandProfileFormProps = {
  spec: OpsConfigSpec;
  readOnly: boolean;
  catalog?: SshEngineCatalog | null;
  extraNotes?: readonly string[];
  onChange: (spec: OpsConfigSpec) => void;
};

export function CommandProfileForm({
  spec,
  readOnly,
  catalog,
  extraNotes,
  onChange,
}: CommandProfileFormProps) {
  const inputClass =
    "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:bg-zinc-50";
  const rows = parseParameterSchema(spec.parameterSchema ?? {});
  const interpolation = templateForbiddenHits(spec.template ?? "");
  const schemaGaps = parameterSchemaGaps(rows);
  const retrySafeExposed = catalog?.retrySafeExposed === true;

  function patch(partial: Partial<OpsConfigSpec>) {
    onChange({ ...spec, ...partial });
  }

  function updateRows(next: SshParameterConstraint[]) {
    onChange(applyParameterSchemaToSpec(spec, next));
  }

  return (
    <div className="grid gap-4">
      <SshSafetyNotes catalog={catalog} extraNotes={extraNotes} />
      <p className="text-xs text-zinc-500">{SSH_IMMUTABLE_PIN_HELP}</p>
      <p className="text-xs text-zinc-500">{SSH_REVIEWED_RENDER_HELP}</p>

      <label className="text-sm">
        <span className="font-medium">Reviewed command template</span>
        <textarea
          value={spec.template ?? ""}
          disabled={readOnly}
          rows={5}
          spellCheck={false}
          onChange={(event) => patch({ template: event.target.value })}
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Fixed argv/template owned by an administrator. No free-form shell.
          Forbidden tokens: $(), backticks, dollar-brace, and double-brace.
        </span>
      </label>
      {interpolation.length > 0 ? (
        <p role="status" className="text-sm text-amber-900">
          Template contains forbidden interpolation: {interpolation.join(", ")}.
        </p>
      ) : null}

      <fieldset className="grid gap-3 rounded-xl border border-zinc-200 px-4 py-3">
        <legend className="px-1 text-sm font-medium">Typed parameters</legend>
        <p className="text-xs text-zinc-500">
          Constraints only — values are supplied later by the workflow node.
          Names become the parameter schema; there is no raw shell field.
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-600">No parameters yet.</p>
        ) : null}
        {rows.map((row, index) => (
          <ParameterRow
            key={`${row.name}-${index}`}
            row={row}
            disabled={readOnly}
            className={inputClass}
            onChange={(next) => {
              const copy = [...rows];
              copy[index] = next;
              updateRows(copy);
            }}
            onRemove={() => updateRows(rows.filter((_, i) => i !== index))}
          />
        ))}
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            updateRows([
              ...rows,
              { name: "", type: "string", required: true },
            ])
          }
          className="w-fit rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
        >
          Add typed parameter
        </button>
        {schemaGaps.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-amber-900">
            {schemaGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      <details className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800">
          Schema JSON and retry note
        </summary>
        <div className="mt-3 grid gap-3">
          <label className="text-sm">
            <span className="font-medium">Parameter schema (JSON)</span>
            <textarea
              defaultValue={specJson(spec.parameterSchema ?? {})}
              disabled={readOnly}
              rows={6}
              onBlur={(event) => {
                const parsed = parseJsonObject(event.target.value);
                if (parsed) {
                  patch({ parameterSchema: parsed });
                }
              }}
              className={`${inputClass} font-mono`}
            />
          </label>
          {retrySafeExposed ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(spec.retrySafe)}
                disabled={readOnly}
                onChange={(event) => patch({ retrySafe: event.target.checked })}
              />
              Retry-safe (verification required)
            </label>
          ) : (
            <p className="text-xs text-zinc-500">{SSH_RETRY_SAFE_STUB_HELP}</p>
          )}
          <label className="text-sm">
            <span className="font-medium">Optional policy pin (UUID)</span>
            <input
              value={spec.policyId ?? ""}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) => patch({ policyId: event.target.value })}
              className={inputClass}
            />
          </label>
        </div>
      </details>
    </div>
  );
}

function ParameterRow({
  row,
  disabled,
  className,
  onChange,
  onRemove,
}: {
  row: SshParameterConstraint;
  disabled: boolean;
  className: string;
  onChange: (row: SshParameterConstraint) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-zinc-200 bg-white p-3 sm:grid-cols-2">
      <label className="text-sm">
        <span className="font-medium">Name</span>
        <input
          value={row.name}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => onChange({ ...row, name: event.target.value })}
          className={className}
        />
      </label>
      <label className="text-sm">
        <span className="font-medium">Type</span>
        <select
          value={row.type}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...row, type: event.target.value as SshParameterType })
          }
          className={className}
        >
          {SSH_PARAMETER_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={row.required}
          disabled={disabled}
          onChange={(event) => onChange({ ...row, required: event.target.checked })}
        />
        Required
      </label>
      {row.type === "string" ? (
        <>
          <label className="text-sm">
            <span className="font-medium">Pattern</span>
            <input
              value={row.pattern ?? ""}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) => onChange({ ...row, pattern: event.target.value })}
              className={`${className} font-mono`}
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Max length</span>
            <input
              value={row.maxLength == null ? "" : String(row.maxLength)}
              disabled={disabled}
              inputMode="numeric"
              onChange={(event) =>
                onChange({
                  ...row,
                  maxLength: event.target.value ? Number(event.target.value) : undefined,
                })
              }
              className={className}
            />
          </label>
        </>
      ) : null}
      {row.type === "integer" ? (
        <>
          <label className="text-sm">
            <span className="font-medium">Minimum</span>
            <input
              value={row.minimum == null ? "" : String(row.minimum)}
              disabled={disabled}
              inputMode="numeric"
              onChange={(event) =>
                onChange({
                  ...row,
                  minimum: event.target.value ? Number(event.target.value) : undefined,
                })
              }
              className={className}
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Maximum</span>
            <input
              value={row.maximum == null ? "" : String(row.maximum)}
              disabled={disabled}
              inputMode="numeric"
              onChange={(event) =>
                onChange({
                  ...row,
                  maximum: event.target.value ? Number(event.target.value) : undefined,
                })
              }
              className={className}
            />
          </label>
        </>
      ) : null}
      {row.type === "enum" ? (
        <label className="text-sm sm:col-span-2">
          <span className="font-medium">Allowed values</span>
          <input
            value={(row.enum ?? []).join(", ")}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) =>
              onChange({
                ...row,
                enum: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            className={className}
          />
        </label>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="w-fit rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
      >
        Remove
      </button>
    </div>
  );
}
