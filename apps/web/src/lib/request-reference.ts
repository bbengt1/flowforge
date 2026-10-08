/**
 * Support reference for the last API call. The API calls this a request
 * id; people see it as "Reference: <id>" in small muted text, never the
 * field name. Ids FlowForge made up in the browser (the `local-` prefix)
 * never reached the API, so they are not shown.
 */
export const REQUEST_REFERENCE_LABEL = "Reference";

export function requestReference(id: string | null | undefined): string | null {
  const value = (id ?? "").trim();
  if (!value || value.startsWith("local-")) {
    return null;
  }
  return value;
}
