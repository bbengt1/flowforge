"use client";

import {
  FF_VAULT_CONTROL_CLASS,
  FF_VAULT_MUTED_CLASS,
} from "@/lib/vault-executions-visual";

type SecretFieldProps = {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  required?: boolean;
};

/**
 * Masked, paste-safe secret input. Values live only in React state for
 * the current compose. Callers must clear `value` after a successful
 * create/rotate — this control never writes Web Storage.
 */
export function SecretField({
  id,
  label,
  hint,
  value,
  onChange,
  multiline = false,
  required = false,
}: SecretFieldProps) {
  const hintId = `${id}-hint`;
  const hintText =
    hint ??
    "Masked. Paste is allowed. Cleared from this page after a successful submit.";
  const shared = `mt-1 font-mono ${FF_VAULT_CONTROL_CLASS}`;

  return (
    <label htmlFor={id} className="block text-sm">
      <span className="font-medium">{label}</span>
      {multiline ? (
        <textarea
          id={id}
          aria-describedby={hintId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            event.stopPropagation();
          }}
          required={required}
          name=""
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          rows={6}
          className={`${shared} min-h-32 [-webkit-text-security:disc]`}
        />
      ) : (
        <input
          id={id}
          type="password"
          aria-describedby={hintId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            event.stopPropagation();
          }}
          required={required}
          name=""
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          className={shared}
        />
      )}
      <span id={hintId} className={`mt-1 block text-xs ${FF_VAULT_MUTED_CLASS}`}>
        {hintText}
      </span>
    </label>
  );
}
