/**
 * E11.1 versioned embed SDK/contract adapter (Chloe embed shell).
 *
 * Aligned to jonny's API on this PR. Paths, claim names, mount prefix,
 * and mint/exchange live here so the embed shell stays in one place.
 *
 * Relates to #121 / Part of #120. Do not close #121 — this is the
 * contract + mint map; Chloe owns the embed shell UI.
 */

export const EMBED_SDK = "embed.v1" as const;
export const EMBED_AUDIENCE = "flowforge" as const;
export const EMBED_ALGORITHM = "EdDSA" as const;
export const EMBED_MOUNT_PREFIX = "/embed/v1";

export const EMBED_API_PREFIX = "/api/v1";
export const EMBED_CATALOG_PATH = "/embed/catalog";
export const EMBED_JWKS_PATH = "/embed/jwks";
export const EMBED_MINT_PATH = "/embed/assertions";
export const EMBED_EXCHANGE_PATH = "/embed/exchange";

export const EMBED_DEFAULT_TTL_SECONDS = 60;
export const EMBED_MIN_TTL_SECONDS = 15;
export const EMBED_MAX_TTL_SECONDS = 300;

/** JWT / assertion claim names (payload). workspace_id is binding only. */
export const EMBED_CLAIM_NAMES = [
  "iss",
  "aud",
  "sub",
  "nbf",
  "exp",
  "jti",
  "tenant_id",
  "workbench_key",
  "workspace_id",
  "capabilities",
  "sdk",
  "display_name",
  "host",
] as const;

export const EMBED_REQUIRED_CLAIMS = [
  "iss",
  "aud",
  "sub",
  "nbf",
  "exp",
  "jti",
  "tenant_id",
  "workbench_key",
  "capabilities",
  "sdk",
] as const;

export type EmbedRouteId =
  | "home"
  | "workflows"
  | "workflow"
  | "actions"
  | "templates"
  | "credentials"
  | "credentialNew"
  | "credential"
  | "executions"
  | "execution"
  | "approvals"
  | "approval"
  | "config"
  | "configKind"
  | "configNew"
  | "configResource"
  | "configVersion"
  | "alerts"
  | "alert"
  | "audit"
  | "settings"
  | "membership"
  | "isolation";

export type EmbedRoute = {
  id: EmbedRouteId;
  standalone: string;
  embed: string;
  description: string;
};

/** Stable mounts. Deep links are the same hrefs standalone and under /embed/v1. */
export const EMBED_ROUTES: readonly EmbedRoute[] = [
  { id: "home", standalone: "/", embed: "/embed/v1", description: "Workspace home" },
  { id: "workflows", standalone: "/workflows", embed: "/embed/v1/workflows", description: "Workflow list" },
  { id: "workflow", standalone: "/workflows/{id}", embed: "/embed/v1/workflows/{id}", description: "Workflow editor" },
  { id: "actions", standalone: "/actions", embed: "/embed/v1/actions", description: "Action library" },
  { id: "templates", standalone: "/templates", embed: "/embed/v1/templates", description: "Templates" },
  { id: "credentials", standalone: "/credentials", embed: "/embed/v1/credentials", description: "Credential vault" },
  { id: "credentialNew", standalone: "/credentials/new", embed: "/embed/v1/credentials/new", description: "Create credential" },
  { id: "credential", standalone: "/credentials/{id}", embed: "/embed/v1/credentials/{id}", description: "Credential detail" },
  { id: "executions", standalone: "/executions", embed: "/embed/v1/executions", description: "Execution history" },
  { id: "execution", standalone: "/executions/{id}", embed: "/embed/v1/executions/{id}", description: "Execution replay" },
  { id: "approvals", standalone: "/approvals", embed: "/embed/v1/approvals", description: "Approval inbox" },
  { id: "approval", standalone: "/approvals/{id}", embed: "/embed/v1/approvals/{id}", description: "Approval detail" },
  { id: "config", standalone: "/config", embed: "/embed/v1/config", description: "Ops config" },
  { id: "configKind", standalone: "/config/{kind}", embed: "/embed/v1/config/{kind}", description: "Ops config collection" },
  { id: "configNew", standalone: "/config/{kind}/new", embed: "/embed/v1/config/{kind}/new", description: "Create ops-config resource" },
  { id: "configResource", standalone: "/config/{kind}/{id}", embed: "/embed/v1/config/{kind}/{id}", description: "Ops-config resource" },
  { id: "configVersion", standalone: "/config/{kind}/{id}/versions/{versionId}", embed: "/embed/v1/config/{kind}/{id}/versions/{versionId}", description: "Ops-config version" },
  { id: "alerts", standalone: "/alerts", embed: "/embed/v1/alerts", description: "Operational alerts" },
  { id: "alert", standalone: "/alerts/{id}", embed: "/embed/v1/alerts/{id}", description: "Alert detail" },
  { id: "audit", standalone: "/audit", embed: "/embed/v1/audit", description: "Audit browse" },
  { id: "settings", standalone: "/settings", embed: "/embed/v1/settings", description: "Settings" },
  { id: "membership", standalone: "/membership", embed: "/embed/v1/membership", description: "Membership operator" },
  { id: "isolation", standalone: "/isolation", embed: "/embed/v1/isolation", description: "Isolation exercise" },
];

export type MintEmbedAssertionBody = {
  subject?: string;
  displayName?: string;
  issuer?: string;
  tenantId?: string;
  workbenchKey?: string;
  workspaceId?: string;
  capabilities: string[];
  ttlSeconds?: number;
};

export type EmbedAssertionPublic = {
  sdk: string;
  tokenId: string;
  issuer: string;
  audience: string;
  subject: string;
  tenantId: string;
  workbenchKey: string;
  workspaceId?: string;
  capabilities: string[];
  notBefore?: string;
  expiresAt?: string;
  keyId?: string;
  algorithm?: string;
  displayName?: string;
  /** Compact JWS is mint-only. Exchange never echoes it. */
  assertion?: string;
};

export function embedApiPath(suffix: string): string {
  return `${EMBED_API_PREFIX}${suffix}`;
}

export function embedMountPath(standalone: string): string {
  if (!standalone || standalone === "/") {
    return EMBED_MOUNT_PREFIX;
  }
  const path = standalone.startsWith("/") ? standalone : `/${standalone}`;
  return `${EMBED_MOUNT_PREFIX}${path}`;
}

export function isEmbedMountPath(pathname: string): boolean {
  return pathname === EMBED_MOUNT_PREFIX || pathname.startsWith(`${EMBED_MOUNT_PREFIX}/`);
}

export function standalonePathFromEmbed(pathname: string): string {
  if (pathname === EMBED_MOUNT_PREFIX) {
    return "/";
  }
  if (pathname.startsWith(`${EMBED_MOUNT_PREFIX}/`)) {
    const rest = pathname.slice(EMBED_MOUNT_PREFIX.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

/** Bearer assertions are never accepted from a URL (query, hash, or path). */
export function assertionFromURL(url: string): null {
  void url;
  return null;
}

export function stripAssertionParams(
  search: string,
): { clean: string; rejected: boolean } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  let rejected = false;
  for (const key of ["assertion", "token", "embedAssertion", "jws"]) {
    if (params.has(key)) {
      params.delete(key);
      rejected = true;
    }
  }
  const clean = params.toString();
  return { clean: clean ? `?${clean}` : "", rejected };
}

export function parseEmbedFrameAncestors(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const origin = part.trim();
    if (!origin || origin === "*" || origin.toLowerCase() === "null") {
      continue;
    }
    try {
      const u = new URL(origin);
      if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username) {
        continue;
      }
      const normalized = `${u.protocol}//${u.host}`;
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      out.push(normalized);
    } catch {
      // ignore
    }
  }
  return out;
}

type EmbedProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function eqSegments(segments: string[], expected: string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

/** Next `/api/control-plane` allowlist. Catalog/JWKS are GET; mint/exchange POST. */
export const EMBED_PROXY_ROUTES: readonly EmbedProxyRoute[] = [
  { methods: ["GET"], match: (s) => eqSegments(s, ["embed", "catalog"]) },
  { methods: ["GET"], match: (s) => eqSegments(s, ["embed", "jwks"]) },
  { methods: ["POST"], match: (s) => eqSegments(s, ["embed", "assertions"]) },
  { methods: ["POST"], match: (s) => eqSegments(s, ["embed", "exchange"]) },
];

export function frameAncestorsForPath(
  pathname: string,
  env: { WEB_EMBED_FRAME_ANCESTORS?: string } = {},
): string {
  if (!isEmbedMountPath(pathname)) {
    return "'none'";
  }
  const allow = parseEmbedFrameAncestors(env.WEB_EMBED_FRAME_ANCESTORS);
  if (allow.length === 0) {
    return "'none'";
  }
  return allow.join(" ");
}
