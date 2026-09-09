/**
 * E11.2 embed tenancy / workbench adapter (Chloe UI).
 *
 * Honors FlowForge-verified `(tenant_id, workbench_key)` after exchange.
 * Host query / postMessage / route values are display context only and
 * never authorize. Jonny owns durable jti consume, key rotation, and
 * tenancy APIs — this file is the thin UI retarget map.
 *
 * Relates to #122 / Part of #120. Keep #122 open. Do not change apps/api.
 */

import {
  EMBED_AUDIENCE,
  EMBED_MOUNT_PREFIX,
  EMBED_SDK,
  embedMountPath,
  isEmbedMountPath,
  parseEmbedHostDisplay,
  standalonePathFromEmbed,
  stripAssertionParams,
  type EmbedHostDisplay,
  type EmbedVerifiedContext,
} from "./embed-contract.ts";
import type { CurrentWorkspace, Workspace } from "./identity-types.ts";
import type { DevIdentity } from "./identity-headers.ts";

export const EMBED_TENANCY_STORY = 122;
export const EMBED_TENANCY_EPIC = 120;
/** E11.1 lock-in until jonny publishes an E11.2 API PR. */
export const EMBED_TENANCY_API_PR = 125;
export const EMBED_TENANCY_ROUTE_MAP_SOURCE = "e111-#125" as const;

export const EMBED_VERIFIED_STORAGE_KEY = "flowforge.embed-verified.v1";

export const EMBED_TENANCY_HOOK_IDS = [
  "jti.consume",
  "key.rotation",
  "tenancy.propagation",
] as const;

export type EmbedTenancyHookId = (typeof EMBED_TENANCY_HOOK_IDS)[number];

export type EmbedTenancyHook = {
  id: string;
  status: string;
  failClosed: string;
  note: string;
  owner: "jonny" | "chloe";
};

export const EMBED_TENANCY_HOOK_OWNERS: Record<
  EmbedTenancyHookId,
  EmbedTenancyHook["owner"]
> = {
  "jti.consume": "jonny",
  "key.rotation": "jonny",
  "tenancy.propagation": "chloe",
};

/** Existing control-plane hops. Do not invent E11.2 API routes. */
export const EMBED_TENANCY_EXISTING_PATHS = [
  "/workspace",
  "/workspaces",
  "/workspace/jobs",
  "/workspace/cache/{key}",
  "/workspace/realtime/channels/{id}/subscribe",
  "/workspace/audit-events",
  "/embed/catalog",
  "/embed/jwks",
  "/embed/exchange",
] as const;

/**
 * Retarget hook for jonny's E11.2 tenancy APIs. Identity until a new
 * map lands — never invent `/embed/session` or `/embed/tenancy`.
 */
export function retargetEmbedTenancyApiPath(uiApiPath: string): string {
  return uiApiPath;
}

type EmbedTenancyProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

/** Additive allowlist. Empty until jonny publishes new embed tenancy routes. */
export const EMBED_TENANCY_PROXY_ROUTES: readonly EmbedTenancyProxyRoute[] = [];

export function isEmbedTenancyProxySegments(segments: string[]): boolean {
  return EMBED_TENANCY_PROXY_ROUTES.some((route) => route.match(segments));
}

export const EMBED_TENANCY_RETARGET = {
  catalogHooks:
    "GET /embed/catalog hooks[] — prefer live jti.consume / key.rotation / tenancy.propagation status over E11.1 stubs",
  jtiConsume:
    "Durable atomic jti consume + TTL is jonny. UI already maps HTTP 409 / code=replay and never resends the compact JWS.",
  keyRotation:
    "Active + overlap kids is jonny. GET /embed/jwks already strips d / PEM / seed. Unknown kid stays fail-closed copy.",
  tenancyApis:
    "If jonny adds embed/session or tenancy-propagation routes, add them to EMBED_TENANCY_PROXY_ROUTES and retargetEmbedTenancyApiPath. Until then hop GET /workspace + GET /workspaces.",
  exchangeShape:
    "workspace.tenant_id + workspace.workbench_key + tenant.id/slug. workspace.id is binding/display only — never the lookup key.",
  workspaceGet:
    "GET /workspace remains the authorization source after exchange. Host tenant/workbench/workspace_id never become lookup headers.",
  routeMap: "e111-#125 until jonny publishes e112-#NNN",
} as const;

export const EMBED_VERIFIED_HELP =
  "Chrome and deep links use the FlowForge-verified (tenant_id, workbench_key) from exchange and GET /workspace. Host query, route, and postMessage values never authorize.";

export const EMBED_LOCKED_MESSAGE =
  "This embed is locked to the FlowForge-verified tenant/workbench. Workspace switching is disabled.";

export const EMBED_HOST_MISMATCH_MESSAGE =
  "Host-supplied tenant/workbench do not match the FlowForge-verified workspace. Host values are display-only and were not used for lookup.";

export const EMBED_TENANCY_MISMATCH_MESSAGE =
  "GET /workspace did not match the FlowForge-verified (tenant_id, workbench_key). The embed surface is closed. Host values are not authorization. Exchange a fresh assertion.";

export const EMBED_MISSING_VERIFIED_MESSAGE =
  "No FlowForge-verified workspace is bound. Host identity is not authorization. Exchange a host assertion.";

export const EMBED_HOST_NOT_AUTH_MESSAGE =
  "Do not trust host-supplied tenant, workbench, or workspace_id for auth. Workspace lookup is tenant_id or tenant slug + workbench_key from FlowForge.";

export type EmbedVerifiedWorkspace = {
  audience: string;
  sdk: string;
  tenantId: string;
  tenantSlug: string;
  workbenchKey: string;
  workspaceId: string;
  workspaceName: string;
  source: "flowforge";
};

export type EmbedTenancyDecision =
  | { ok: true; verified: EmbedVerifiedWorkspace }
  | { ok: false; reason: "missing" | "mismatch"; message: string };

export function hasVerifiedWorkspaceLookup(
  value: Pick<
    EmbedVerifiedWorkspace,
    "tenantId" | "tenantSlug" | "workbenchKey"
  > | null,
): boolean {
  if (!value) {
    return false;
  }
  return Boolean(
    value.workbenchKey.trim() &&
      (value.tenantId.trim() || value.tenantSlug.trim()),
  );
}

export function verifiedWorkspaceFromExchange(
  context: EmbedVerifiedContext | null | undefined,
): EmbedVerifiedWorkspace | null {
  if (!context) {
    return null;
  }
  const verified: EmbedVerifiedWorkspace = {
    audience: context.audience.trim() || EMBED_AUDIENCE,
    sdk: context.sdk.trim() || EMBED_SDK,
    tenantId: context.tenantId.trim(),
    tenantSlug: context.tenantSlug.trim(),
    workbenchKey: context.workbenchKey.trim(),
    workspaceId: context.workspaceId.trim(),
    workspaceName: context.workspaceName.trim(),
    source: "flowforge",
  };
  return hasVerifiedWorkspaceLookup(verified) ? verified : null;
}

export function verifiedWorkspaceFromCurrent(
  current: CurrentWorkspace | null | undefined,
): EmbedVerifiedWorkspace | null {
  if (!current?.workspace) {
    return null;
  }
  const verified: EmbedVerifiedWorkspace = {
    audience: EMBED_AUDIENCE,
    sdk: EMBED_SDK,
    tenantId: current.workspace.tenant_id.trim(),
    tenantSlug: current.tenant?.slug?.trim() ?? "",
    workbenchKey: current.workspace.workbench_key.trim(),
    workspaceId: current.workspace.id.trim(),
    workspaceName: current.workspace.name.trim(),
    source: "flowforge",
  };
  return hasVerifiedWorkspaceLookup(verified) ? verified : null;
}

export function parseEmbedVerifiedWorkspace(
  value: unknown,
): EmbedVerifiedWorkspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.source !== "flowforge") {
    return null;
  }
  const verified: EmbedVerifiedWorkspace = {
    audience: readString(raw.audience) || EMBED_AUDIENCE,
    sdk: readString(raw.sdk) || EMBED_SDK,
    tenantId: readString(raw.tenantId, raw.tenant_id),
    tenantSlug: readString(raw.tenantSlug, raw.tenant_slug),
    workbenchKey: readString(raw.workbenchKey, raw.workbench_key),
    workspaceId: readString(raw.workspaceId, raw.workspace_id),
    workspaceName: readString(raw.workspaceName, raw.workspace_name),
    source: "flowforge",
  };
  return hasVerifiedWorkspaceLookup(verified) ? verified : null;
}

export function identityFromVerified(
  identity: DevIdentity,
  verified: EmbedVerifiedWorkspace,
): DevIdentity {
  return {
    ...identity,
    tenantId: verified.tenantId,
    tenantSlug: verified.tenantSlug,
    workbenchKey: verified.workbenchKey,
  };
}

export function identityMatchesVerified(
  identity: DevIdentity,
  verified: EmbedVerifiedWorkspace,
): boolean {
  if (identity.workbenchKey.trim() !== verified.workbenchKey) {
    return false;
  }
  if (verified.tenantId && identity.tenantId.trim()) {
    return identity.tenantId.trim() === verified.tenantId;
  }
  if (verified.tenantSlug && identity.tenantSlug.trim()) {
    return identity.tenantSlug.trim() === verified.tenantSlug;
  }
  return Boolean(
    identity.tenantId.trim() === verified.tenantId ||
      identity.tenantSlug.trim() === verified.tenantSlug,
  );
}

export function workspaceMatchesVerified(
  workspace: Pick<Workspace, "tenant_id" | "workbench_key"> | null | undefined,
  verified: EmbedVerifiedWorkspace,
): boolean {
  if (!workspace) {
    return false;
  }
  return (
    workspace.tenant_id.trim() === verified.tenantId &&
    workspace.workbench_key.trim() === verified.workbenchKey
  );
}

export function decideEmbedTenancy(input: {
  verified: EmbedVerifiedWorkspace | null;
  current: CurrentWorkspace | null;
}): EmbedTenancyDecision {
  if (!input.verified) {
    return {
      ok: false,
      reason: "missing",
      message: EMBED_MISSING_VERIFIED_MESSAGE,
    };
  }
  if (
    input.current &&
    !workspaceMatchesVerified(input.current.workspace, input.verified)
  ) {
    return {
      ok: false,
      reason: "mismatch",
      message: EMBED_TENANCY_MISMATCH_MESSAGE,
    };
  }
  return { ok: true, verified: input.verified };
}

export function hostDisplayConflictsWithVerified(
  host: EmbedHostDisplay,
  verified: EmbedVerifiedWorkspace,
): boolean {
  const hostTenant = (host.tenantId || host.tenant).trim();
  const hostWorkbench = host.workbench.trim();
  if (hostTenant) {
    const matchesTenant =
      hostTenant === verified.tenantId || hostTenant === verified.tenantSlug;
    if (!matchesTenant) {
      return true;
    }
  }
  if (hostWorkbench && hostWorkbench !== verified.workbenchKey) {
    return true;
  }
  return false;
}

/** Host query identity is never a workspace lookup. */
export function rejectHostSuppliedLookup(
  host: EmbedHostDisplay,
): { used: false; display: EmbedHostDisplay } {
  return { used: false, display: { ...host, unverified: true } };
}

export function hostDisplayFromSearch(search: string): EmbedHostDisplay {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return parseEmbedHostDisplay(params);
}

/**
 * Deep link under /embed/v1. Never attaches tenant/workbench/workspace_id
 * as auth query. Strips leaked assertion tokens. Query/hash fragments
 * that are not secrets stay (tab=, #schedules).
 */
export function embedDeepLink(href: string): string {
  if (!href || href.startsWith("#")) {
    return href;
  }
  const parsed = parseInAppHref(href);
  if (!parsed) {
    return href;
  }
  const cleaned = stripAssertionParams(parsed.search);
  const path = isEmbedMountPath(parsed.pathname)
    ? parsed.pathname
    : embedMountPath(parsed.pathname);
  return `${path}${cleaned.clean}${parsed.hash}`;
}

export function maybeEmbedDeepLink(href: string, embed: boolean): string {
  return embed ? embedDeepLink(href) : href;
}

export function embedDeepLinkIsActive(href: string, pathname: string): boolean {
  const hrefPath = standalonePathFromEmbed(pathOnly(href));
  const current = standalonePathFromEmbed(pathname);
  if (hrefPath === "/workflows") {
    return current === "/workflows" || current.startsWith("/workflows/");
  }
  if (hrefPath === "/config" || hrefPath.startsWith("/config")) {
    return current === "/config" || current.startsWith("/config/");
  }
  if (hrefPath === "/executions") {
    return current === "/executions" || current.startsWith("/executions/");
  }
  if (hrefPath === "/credentials") {
    return current === "/credentials" || current.startsWith("/credentials/");
  }
  if (hrefPath === "/approvals") {
    return current === "/approvals" || current.startsWith("/approvals/");
  }
  if (hrefPath === "/alerts") {
    return current === "/alerts" || current.startsWith("/alerts/");
  }
  return current === hrefPath || current.startsWith(`${hrefPath}/`);
}

/**
 * Rewrite an in-app href onto the embed mount. Returns null when the
 * href is not same-origin UI navigation (api, static, external, empty).
 */
export function rewriteEmbedNavigationHref(
  href: string,
  origin: string,
): string | null {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("javascript:")
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed, origin || "https://flowforge.local");
  } catch {
    return null;
  }
  if (origin && url.origin !== origin) {
    return null;
  }
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/_next") ||
    url.pathname === "/favicon.ico"
  ) {
    return null;
  }
  if (isEmbedMountPath(url.pathname)) {
    return null;
  }
  return embedDeepLink(`${url.pathname}${url.search}${url.hash}`);
}

export function parseEmbedCatalogHooks(payload: unknown): EmbedTenancyHook[] {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const raw = Array.isArray(source.hooks) ? source.hooks : [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      const id = readString(row.id);
      if (!id) {
        return null;
      }
      const owner: EmbedTenancyHook["owner"] =
        id === "tenancy.propagation"
          ? "chloe"
          : id === "jti.consume" || id === "key.rotation"
            ? "jonny"
            : "jonny";
      return {
        id,
        status: readString(row.status) || "stub",
        failClosed: readString(row.failClosed, row.fail),
        note: readString(row.note),
        owner,
      };
    })
    .filter((item): item is EmbedTenancyHook => item !== null);
}

export function embedVerifiedLabel(verified: EmbedVerifiedWorkspace): string {
  const tenant = verified.tenantSlug || verified.tenantId;
  return `${tenant} / ${verified.workbenchKey}`;
}

export function embedMountHome(): string {
  return EMBED_MOUNT_PREFIX;
}

function pathOnly(href: string): string {
  const q = href.indexOf("?");
  const h = href.indexOf("#");
  const end = q === -1 ? h : h === -1 ? q : Math.min(q, h);
  return end === -1 ? href : href.slice(0, end);
}

function parseInAppHref(
  href: string,
): { pathname: string; search: string; hash: string } | null {
  try {
    const url = href.startsWith("http://") || href.startsWith("https://")
      ? new URL(href)
      : new URL(href, "https://flowforge.local");
    return {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    };
  } catch {
    return null;
  }
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}
