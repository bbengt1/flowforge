"use client";

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
  const shared =
    "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20";

  return (
    <label htmlFor={id} className="block text-sm">
      <span className="font-medium text-zinc-800">{label}</span>
      {multiline ? (
        <textarea
          id={id}
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
          className={`${shared} min-h-32`}
        />
      ) : (
        <input
          id={id}
          type="password"
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
      <span className="mt-1 block text-xs text-zinc-500">
        {hint ??
          "Masked. Paste is allowed. Cleared from this page after a successful submit."}
      </span>
    </label>
  );
}
