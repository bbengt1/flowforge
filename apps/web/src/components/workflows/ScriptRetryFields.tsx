"use client";

import {
  SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
  SCRIPT_IO_ENV_HELP,
  SCRIPT_IO_HANDLE_HELP,
  SCRIPT_IO_INDETERMINATE_HELP,
  SCRIPT_IO_MAX_RETRY_ATTEMPTS,
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  SCRIPT_IO_RETRY_DENIED_MESSAGE,
  SCRIPT_IO_RETRY_ZERO_MESSAGE,
  SCRIPT_IO_ROUTE_MAP_SOURCE,
  SCRIPT_IO_VERIFICATION_BEHAVIOR,
  SCRIPT_IO_VERIFICATION_HELP,
  SCRIPT_IO_VERIFY_ALREADY_APPLIED,
  SCRIPT_IO_VERIFY_INDETERMINATE,
  SCRIPT_IO_VERIFY_SAFE_TO_RETRY,
  defaultScriptIoVerification,
  scriptIoCatalog,
  validateScriptIoRetryDeclaration,
  type ScriptIoCatalog,
  type ScriptIoVerificationSpec,
} from "@/lib/script-io-contract";

type ScriptRetryFieldsProps = {
  retrySafe?: unknown;
  idempotencyKey?: unknown;
  verification?: unknown;
  retryPolicy?: unknown;
  catalog?: ScriptIoCatalog | null;
  disabled?: boolean;
  onChange: (patch: {
    retrySafe?: boolean;
    idempotencyKey?: string;
    verification?: ScriptIoVerificationSpec | undefined;
    retryPolicy?: { maxAttempts: number };
  }) => void;
};

export function ScriptRetryFields({
  retrySafe,
  idempotencyKey,
  verification,
  retryPolicy,
  catalog,
  disabled,
  onChange,
}: ScriptRetryFieldsProps) {
  const io = scriptIoCatalog(catalog);
  const safe = retrySafe === true;
  const key = typeof idempotencyKey === "string" ? idempotencyKey : "";
  const parsedVerification = verification && typeof verification === "object" && !Array.isArray(verification)
    ? (verification as ScriptIoVerificationSpec)
    : undefined;
  const maxAttempts =
    retryPolicy && typeof retryPolicy === "object" && !Array.isArray(retryPolicy)
      ? Number((retryPolicy as { maxAttempts?: unknown }).maxAttempts)
      : SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS;
  const attempts = Number.isInteger(maxAttempts)
    ? maxAttempts
    : SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS;
  const validation = validateScriptIoRetryDeclaration({
    retrySafe: safe,
    idempotencyKey: key,
    verification: parsedVerification,
    retryPolicy: { maxAttempts: attempts },
  });
  return (
    <fieldset className="space-y-4 rounded-xl border border-zinc-200 px-4 py-3">
      <legend className="px-1 text-sm font-medium">Retry and verification</legend>
      <p className="text-xs text-zinc-500">
        {SCRIPT_IO_RETRY_ZERO_MESSAGE} {SCRIPT_IO_NO_BLIND_RETRY_HELP} Map
        source <code className="font-mono">{SCRIPT_IO_ROUTE_MAP_SOURCE}</code>
        {catalog?.source ? ` · ${catalog.source}` : ""}.
      </p>
      <p className="text-xs text-zinc-600">
        {SCRIPT_IO_HANDLE_HELP} Handles TTL {io.io.handleTTLSeconds}s (max{" "}
        {io.io.handleMaxTTLSeconds}s). {SCRIPT_IO_ENV_HELP}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={safe}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.checked;
            onChange({
              retrySafe: next,
              idempotencyKey: next ? key : "",
              verification: next
                ? parsedVerification ?? defaultScriptIoVerification()
                : undefined,
              retryPolicy: { maxAttempts: attempts },
            });
          }}
          className="mt-1"
        />
        <span>
          <span className="font-medium">retrySafe</span>
          <span className="mt-1 block text-xs text-zinc-500">
            Default false. Enabling requires an idempotency key and a
            declared-hook. This never implies a blind re-run.
          </span>
        </span>
      </label>
      <label className="block text-sm">
        <span className="font-medium">idempotencyKey</span>
        <input
          type="text"
          value={key}
          disabled={disabled || !safe}
          maxLength={128}
          onChange={(event) =>
            onChange({
              retrySafe: safe,
              idempotencyKey: event.target.value,
              verification: parsedVerification,
              retryPolicy: { maxAttempts: attempts },
            })
          }
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm disabled:bg-zinc-50"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          1–128, letter-prefixed. Required with retrySafe.
        </span>
      </label>
      <label className="block text-sm">
        <span className="font-medium">verification.behavior</span>
        <input
          value={SCRIPT_IO_VERIFICATION_BEHAVIOR}
          readOnly
          disabled
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-sm"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          {SCRIPT_IO_VERIFICATION_HELP} Only allowed value is{" "}
          <code className="font-mono">{io.probe.behavior}</code>.
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <OutcomeField
          label="onMatch"
          value={parsedVerification?.onMatch || SCRIPT_IO_VERIFY_ALREADY_APPLIED}
          options={[SCRIPT_IO_VERIFY_ALREADY_APPLIED, SCRIPT_IO_VERIFY_SAFE_TO_RETRY]}
          disabled={disabled || !safe}
          onChange={(onMatch) =>
            onChange({
              retrySafe: safe,
              idempotencyKey: key,
              verification: {
                ...(parsedVerification ?? defaultScriptIoVerification()),
                behavior: SCRIPT_IO_VERIFICATION_BEHAVIOR,
                onMatch,
              },
              retryPolicy: { maxAttempts: attempts },
            })
          }
        />
        <OutcomeField
          label="onMismatch"
          value={parsedVerification?.onMismatch || SCRIPT_IO_VERIFY_SAFE_TO_RETRY}
          options={[
            SCRIPT_IO_VERIFY_ALREADY_APPLIED,
            SCRIPT_IO_VERIFY_SAFE_TO_RETRY,
            SCRIPT_IO_VERIFY_INDETERMINATE,
          ]}
          disabled={disabled || !safe}
          onChange={(onMismatch) =>
            onChange({
              retrySafe: safe,
              idempotencyKey: key,
              verification: {
                ...(parsedVerification ?? defaultScriptIoVerification()),
                behavior: SCRIPT_IO_VERIFICATION_BEHAVIOR,
                onMismatch,
              },
              retryPolicy: { maxAttempts: attempts },
            })
          }
        />
        <OutcomeField
          label="onError"
          value={SCRIPT_IO_VERIFY_INDETERMINATE}
          options={[SCRIPT_IO_VERIFY_INDETERMINATE]}
          disabled
          onChange={() => undefined}
        />
      </div>
      <label className="block text-sm">
        <span className="font-medium">retryPolicy.maxAttempts</span>
        <input
          type="number"
          min={SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS}
          max={SCRIPT_IO_MAX_RETRY_ATTEMPTS}
          value={attempts}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              retrySafe: safe,
              idempotencyKey: key,
              verification: parsedVerification,
              retryPolicy: {
                maxAttempts:
                  Number(event.target.value) || SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
              },
            })
          }
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Default {SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS}. Range{" "}
          {SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS}–{SCRIPT_IO_MAX_RETRY_ATTEMPTS}.
          Values above 0 require retrySafe + idempotencyKey + declared-hook.
        </span>
      </label>
      <p className="text-xs text-zinc-600">{SCRIPT_IO_INDETERMINATE_HELP}</p>
      {validation.errors.length > 0 ? (
        <p role="status" className="text-sm text-amber-950">
          {validation.errors[0] || SCRIPT_IO_RETRY_DENIED_MESSAGE}
        </p>
      ) : validation.warnings.length > 0 ? (
        <p className="text-sm text-zinc-700">{validation.warnings[0]}</p>
      ) : (
        <p className="text-sm text-zinc-700">
          retrySafe={String(safe)}; idempotencyKey{" "}
          {validation.idempotencyKey ? "declared" : "omitted"};
          verification {validation.verificationDeclared ? "declared-hook" : "omitted"}.
        </p>
      )}
    </fieldset>
  );
}

function OutcomeField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="font-medium text-zinc-700">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
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
