/**
 * G.3.1 Field wiring. Screens pass label, hint, and error text; this
 * module owns htmlFor, aria-invalid, and aria-describedby.
 */

export type FieldDescription = {
  hintId?: string;
  errorId?: string;
  describedBy?: string;
};

export function fieldDescriptionIds(input: {
  id: string;
  hasHint: boolean;
  hasError: boolean;
  errorId?: string;
}): FieldDescription {
  const hintId = input.hasHint ? `${input.id}-hint` : undefined;
  const errorId = input.hasError
    ? input.errorId?.trim() || `${input.id}-error`
    : undefined;
  const parts = [hintId, errorId].filter((part): part is string => Boolean(part));
  return {
    hintId,
    errorId,
    describedBy: parts.length > 0 ? parts.join(" ") : undefined,
  };
}

export function fieldMarksInvalid(input: {
  invalid?: boolean;
  hasError: boolean;
}): boolean {
  return input.invalid === true || input.hasError;
}

export type FieldControlAria = {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  "aria-required"?: true;
  required?: true;
};

export function fieldControlAria(input: {
  id: string;
  invalid: boolean;
  describedBy?: string;
  required?: boolean;
}): FieldControlAria {
  return {
    id: input.id,
    ...(input.invalid ? { "aria-invalid": true as const } : {}),
    ...(input.describedBy ? { "aria-describedby": input.describedBy } : {}),
    ...(input.required ? { "aria-required": true as const, required: true as const } : {}),
  };
}
