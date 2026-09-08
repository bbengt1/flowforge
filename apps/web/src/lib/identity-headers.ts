/**
 * FlowForge identity headers (E2.1) until E2.3 browser sessions.
 *
 * Workspace lookup is tenant id *or* tenant slug plus workbench_key.
 * X-FlowForge-Workspace-ID is untrusted host context and is never
 * forwarded by the UI proxy — it is never the lookup key.
 */

export const FLOWFORGE_ISSUER_HEADER = "X-FlowForge-Issuer";
export const FLOWFORGE_SUBJECT_HEADER = "X-FlowForge-Subject";
export const FLOWFORGE_DISPLAY_NAME_HEADER = "X-FlowForge-Display-Name";
export const FLOWFORGE_TENANT_ID_HEADER = "X-FlowForge-Tenant-ID";
export const FLOWFORGE_TENANT_SLUG_HEADER = "X-FlowForge-Tenant-Slug";
export const FLOWFORGE_WORKBENCH_KEY_HEADER = "X-FlowForge-Workbench-Key";
export const FLOWFORGE_WORKSPACE_ID_HEADER = "X-FlowForge-Workspace-ID";

/** Headers the UI proxy may copy onto the Go API request. */
export const FORWARDED_IDENTITY_HEADERS = [
  FLOWFORGE_ISSUER_HEADER,
  FLOWFORGE_SUBJECT_HEADER,
  FLOWFORGE_DISPLAY_NAME_HEADER,
  FLOWFORGE_TENANT_ID_HEADER,
  FLOWFORGE_TENANT_SLUG_HEADER,
  FLOWFORGE_WORKBENCH_KEY_HEADER,
] as const;

export type DevIdentity = {
  issuer: string;
  subject: string;
  displayName: string;
  tenantId: string;
  tenantSlug: string;
  workbenchKey: string;
};

export function emptyDevIdentity(): DevIdentity {
  return {
    issuer: "",
    subject: "",
    displayName: "",
    tenantId: "",
    tenantSlug: "",
    workbenchKey: "",
  };
}

export function hasCallerIdentity(identity: DevIdentity): boolean {
  return Boolean(identity.issuer.trim() && identity.subject.trim());
}

/** Tenant + workbench_key — the only accepted workspace lookup. */
export function hasWorkspaceLookup(identity: DevIdentity): boolean {
  return Boolean(
    identity.workbenchKey.trim() &&
      (identity.tenantId.trim() || identity.tenantSlug.trim()),
  );
}

export function pickForwardedIdentityHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_IDENTITY_HEADERS) {
    const value = source.get(name)?.trim();
    if (value) {
      out.set(name, value);
    }
  }
  return out;
}

/** Browser → Next proxy headers. Never includes workspace-id. */
export function clientIdentityHeaders(
  identity: DevIdentity,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const pairs: Array<[string, string]> = [
    [FLOWFORGE_ISSUER_HEADER, identity.issuer],
    [FLOWFORGE_SUBJECT_HEADER, identity.subject],
    [FLOWFORGE_DISPLAY_NAME_HEADER, identity.displayName],
    [FLOWFORGE_TENANT_ID_HEADER, identity.tenantId],
    [FLOWFORGE_TENANT_SLUG_HEADER, identity.tenantSlug],
    [FLOWFORGE_WORKBENCH_KEY_HEADER, identity.workbenchKey],
  ];
  for (const [name, raw] of pairs) {
    const value = raw.trim();
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

export function isWorkspaceIdOnlyIdentity(source: Headers): boolean {
  const workspaceId = source.get(FLOWFORGE_WORKSPACE_ID_HEADER)?.trim();
  if (!workspaceId) {
    return false;
  }
  const tenantId = source.get(FLOWFORGE_TENANT_ID_HEADER)?.trim();
  const tenantSlug = source.get(FLOWFORGE_TENANT_SLUG_HEADER)?.trim();
  const workbench = source.get(FLOWFORGE_WORKBENCH_KEY_HEADER)?.trim();
  return !workbench || (!tenantId && !tenantSlug);
}
