/**
 * Preview of the slug #548 derives on create. The server owns the
 * stored slug. This module only mirrors slugifyWorkflowName so the
 * form can show the same label before the request.
 *
 * Rules (apps/api/internal/wfstore/slug.go): lowercase, each run of
 * characters that are not ASCII letters or digits becomes one hyphen,
 * trim hyphens, prefix a leading digit with w-, cap at 63 bytes and
 * drop a trailing hyphen after the cap, then fall back to workflow.
 * Reserved words stay in the preview. The server may add -2, -3, …
 */

export const WORKFLOW_SLUG_PREVIEW_MAX_LEN = 63;

export const WORKFLOW_SLUG_PREVIEW_FALLBACK = "workflow";

export const WORKFLOW_SLUG_PREVIEW_HINT =
  "Preview from the name. The server chooses the final slug and may add a suffix.";

export const WORKFLOW_SLUG_EXPLICIT_HINT =
  "This slug will be sent as typed. The server will not add a suffix.";

export function previewWorkflowSlug(name: string): string {
  const source = name.trim().toLowerCase();
  let out = "";
  let lastHyphen = true;
  for (const char of source) {
    const isAsciiLetter = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";
    if (isAsciiLetter || isDigit) {
      out += char;
      lastHyphen = false;
      continue;
    }
    if (!lastHyphen) {
      out += "-";
      lastHyphen = true;
    }
  }
  out = trimHyphens(out);
  if (out === "") {
    return WORKFLOW_SLUG_PREVIEW_FALLBACK;
  }
  if (out[0]! >= "0" && out[0]! <= "9") {
    out = `w-${out}`;
  }
  if (out.length > WORKFLOW_SLUG_PREVIEW_MAX_LEN) {
    out = trimRightHyphens(out.slice(0, WORKFLOW_SLUG_PREVIEW_MAX_LEN));
  }
  if (!validDerivedWorkflowSlug(out)) {
    return WORKFLOW_SLUG_PREVIEW_FALLBACK;
  }
  return out;
}

/**
 * Preview for the workflow-home create form. A typed name is the
 * derivation source. An empty name uses the blank template title,
 * which is the name that create sends and the YAML still carries.
 */
export function previewCreateFormSlug(typedName: string, fallbackName: string): string {
  const typed = typedName.trim();
  return previewWorkflowSlug(typed || fallbackName);
}

/**
 * JSON fields for POST /workflows. An unedited slug preview is omitted.
 * slugEdited is true when the operator changed the Slug field, or when
 * a caller passes an explicit slug (duplicate).
 */
export function workflowCreateRequestFields(input: {
  name: string;
  slug: string;
  slugEdited: boolean;
}): { name?: string; slug?: string } {
  const fields: { name?: string; slug?: string } = {};
  const name = input.name.trim();
  if (name) {
    fields.name = name;
  }
  if (input.slugEdited) {
    const slug = input.slug.trim();
    if (slug) {
      fields.slug = slug;
    }
  }
  return fields;
}

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start += 1;
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1;
  }
  return value.slice(start, end);
}

function trimRightHyphens(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "-") {
    end -= 1;
  }
  return value.slice(0, end);
}

function validDerivedWorkflowSlug(value: string): boolean {
  if (value.length < 1 || value.length > WORKFLOW_SLUG_PREVIEW_MAX_LEN) {
    return false;
  }
  const first = value[0];
  if (first === undefined || first < "a" || first > "z") {
    return false;
  }
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === undefined) {
      return false;
    }
    const ok =
      (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-";
    if (!ok) {
      return false;
    }
  }
  return value[value.length - 1] !== "-";
}
