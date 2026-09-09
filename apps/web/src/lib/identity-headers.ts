/**
 * FlowForge identity headers (E2.1 / E2.2) and E2.3 session alignment.
 *
 * Cookie sessions establish the subject. Tenant + workbench remain the
 * only workspace lookup. X-FlowForge-Issuer/Subject are a temporary
 * local-dev fallback when no session cookie is active.
 *
 * X-FlowForge-Workspace-ID is untrusted host context and is never
 * the lookup key. The membership proxy never forwards it. The isolation
 * proxy may attach it only alongside tenant + workbench as a deliberate
 * mismatch fail demo — never as the sole workspace identity.
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

/** Cookie session, or the temporary header fallback with issuer+subject. */
export function hasOperatorCaller(
  sessionActive: boolean,
  identity: DevIdentity,
  headerFallback: boolean,
): boolean {
  return sessionActive || (headerFallback && hasCallerIdentity(identity));
}

/** Tenant + workbench_key — the only accepted workspace lookup. */
export function hasWorkspaceLookup(identity: DevIdentity): boolean {
  return Boolean(
    identity.workbenchKey.trim() &&
      (identity.tenantId.trim() || identity.tenantSlug.trim()),
  );
}

/** Stable key for dropping stale UI state when the workspace changes. */
export function workspaceLookupKey(identity: DevIdentity): string {
  return [
    identity.tenantId.trim(),
    identity.tenantSlug.trim(),
    identity.workbenchKey.trim(),
  ].join("|");
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

/**
 * Isolation hook forwarding: same as E2.1, plus Workspace-ID only when
 * tenant + workbench are also present. Workspace-ID-only is never forwarded.
 */
export function pickIsolationForwardedHeaders(source: Headers): Headers {
  const out = pickForwardedIdentityHeaders(source);
  const workspaceId = source.get(FLOWFORGE_WORKSPACE_ID_HEADER)?.trim();
  if (!workspaceId) {
    return out;
  }
  const tenantId = source.get(FLOWFORGE_TENANT_ID_HEADER)?.trim();
  const tenantSlug = source.get(FLOWFORGE_TENANT_SLUG_HEADER)?.trim();
  const workbench = source.get(FLOWFORGE_WORKBENCH_KEY_HEADER)?.trim();
  if (workbench && (tenantId || tenantSlug)) {
    out.set(FLOWFORGE_WORKSPACE_ID_HEADER, workspaceId);
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

/** Browser → Next workspace lookup only (no subject headers). */
export function clientWorkspaceHeaders(
  identity: DevIdentity,
): Record<string, string> {
  return clientIdentityHeaders({
    ...identity,
    issuer: "",
    subject: "",
    displayName: "",
  });
}

/**
 * Browser → Next headers for isolation exercises. Workspace-ID is attached
 * only as a mismatch fail demo when tenant + workbench lookup is already set.
 */
export function clientIsolationHeaders(
  identity: DevIdentity,
  mismatchWorkspaceId?: string,
): Record<string, string> {
  const headers = clientIdentityHeaders(identity);
  const workspaceId = mismatchWorkspaceId?.trim();
  if (workspaceId && hasWorkspaceLookup(identity)) {
    headers[FLOWFORGE_WORKSPACE_ID_HEADER] = workspaceId;
  }
  return headers;
}

/**
 * Prefer cookie session (no issuer/subject headers). Header identity is
 * attached only when the temporary local-dev fallback is enabled and no
 * session is active.
 */
export function clientOperatorHeaders(
  identity: DevIdentity,
  options: {
    sessionActive: boolean;
    headerFallback: boolean;
    mismatchWorkspaceId?: string;
  },
): Record<string, string> {
  const workspaceOnly = options.sessionActive || !options.headerFallback;
  const source = workspaceOnly
    ? { ...identity, issuer: "", subject: "", displayName: "" }
    : identity;
  return clientIsolationHeaders(source, options.mismatchWorkspaceId);
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
