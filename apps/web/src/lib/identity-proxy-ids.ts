const RESOURCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workflow/version/execution/approval path ids are UUIDs. */
export function isResourceId(value: string | undefined): boolean {
  return Boolean(value && RESOURCE_ID.test(value));
}
