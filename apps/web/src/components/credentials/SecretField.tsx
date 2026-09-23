"use client";

import { Field } from "@/components/a11y/Field";
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
  error?: string;
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
  error,
}: SecretFieldProps) {
  const hintText =
    hint ??
    "Masked. Paste is allowed. Cleared from this page after a successful submit.";
  const shared = `mt-1 font-mono ${FF_VAULT_CONTROL_CLASS}`;

  return (
    <Field
      id={id}
      label={label}
      hint={hintText}
      error={error}
      required={required}
      className="block text-sm"
      labelClassName="font-medium"
      hintClassName={`mt-1 block text-xs ${FF_VAULT_MUTED_CLASS}`}
      errorClassName={`mt-1 block text-xs ${FF_VAULT_MUTED_CLASS}`}
    >
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            event.stopPropagation();
          }}
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
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            event.stopPropagation();
          }}
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
    </Field>
  );
}
