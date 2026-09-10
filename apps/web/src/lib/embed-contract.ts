/**
 * E11.1 + E11.2 embed SDK/contract adapter (Chloe embed shell).
 *
 * Paths, claims, mint/exchange, rotate, and tenancy rules live here so
 * the embed shell stays in one place. E11.2 adds durable jti, overlap
 * rotation, and (tenant_id, workbench_key) session binding.
 *
 * Relates to #122 / #121 / Part of #120. Keep #122 open — Chloe still
 * has UI pending to honor session.embed / tenant+workbench headers.
 *
 * ADV-021: EmbedChrome is driven from GET /session via
 * session-embed-contract.ts — not host query, peeked JWS, or postMessage.
 *
 * ADV-005: empty EMBED_ISSUER / EMBED_ISSUER_ALLOWLIST fails closed
 * (HTTP 403) on mint and, when Portal is also empty, exchange. No UI rewrite.
 *
 * ADV-004: mint subject/issuer bind to the authenticated caller.
 * A different subject requires embed.impersonate (PLATFORM_ADMINS).
 * A different issuer is 403. The embed shell does not mint. No UI rewrite.
 *
 * ADV-007: embed ff_session / ff_csrf after POST /embed/exchange are
 * CHIPS (SameSite=None; Secure; Partitioned). Top-level cookies stay
 * Lax/Strict. Keep credentials:include. Do not request Storage Access
 * / unpartitioned cookies. Cookie not sent is 401/403.
 *
 * ADV-014: register-overlap requires short overlapUntil (max 4h).
 * The embed shell does not rotate keys. No UI rewrite.
 *
 * ADV-008: POST /embed/exchange verifies the assertion before any
 * workspace lookup. Invalid assertions fail closed the same way
 * whether or not the tenant exists. No UI rewrite.
 *
 * ADV-023: exchange binds assertion iss to the minting host issuer.
 * Send X-FlowForge-Host-Issuer (or body hostIssuer) set to the
 * configured Portal / embed issuer for this frame — never peeked from
 * the assertion. Optional X-FlowForge-Host-Context: portal|embed
 * selects the path allowlist. Prefer no UI rewrite beyond the header.
 *
 * ADV-012: POST /embed/exchange is rate-limited (429 rate-limited).
 * Treat 429 as backoff and retry after Retry-After / the window.
 * Prefer no UI change beyond that. Authz decisions are audited
 * server-side; this shell never logs the assertion.
 *
 * ADV-011: WEB_EMBED_FRAME_ANCESTORS ∪ WEB_PORTAL_FRAME_ANCESTORS ∪
 * PORTAL_FRAME_ANCESTORS is one host allowlist. It drives CSP
 * frame-ancestors on /embed/v1 and postMessage origin checks.
 * Empty fails closed. NEXT_PUBLIC_EMBED_FRAME_ANCESTORS is not a source.
 * Prefer GET /embed/catalog frameAncestors in the shell.
 *
 * ADV-021: embed chrome (nav / capabilities / tenant display) is driven
 * from GET /session session.embed — not assertion leftovers, catalog
 * guesses, or host query. Fail closed on /embed/v1 if the session lacks
 * an embed binding. Prefer no product-shell rewrite in this API story;
 * Chloe owns the chrome retarget via parseEmbedChromeFromSession.
 */

export const EMBED_SDK = "embed.v1" as const;
export const EMBED_AUDIENCE = "flowforge" as const;
export const EMBED_ALGORITHM = "EdDSA" as const;
export const EMBED_MOUNT_PREFIX = "/embed/v1";

/** Set by src/proxy.ts so SSR sees the inbound /embed/v1 path after rewrite. */
export const EMBED_MOUNT_HEADER = "x-flowforge-embed";
/** Boolean flag only — never copies the assertion value. */
export const EMBED_REJECTED_ASSERTION_HEADER = "x-flowforge-embed-rejected";

export const EMBED_API_PREFIX = "/api/v1";
export const EMBED_CATALOG_PATH = "/embed/catalog";
export const EMBED_JWKS_PATH = "/embed/jwks";
export const EMBED_MINT_PATH = "/embed/assertions";
export const EMBED_EXCHANGE_PATH = "/embed/exchange";
export const EMBED_ROTATE_PATH = "/embed/keys/rotate";

export const EMBED_DEFAULT_TTL_SECONDS = 60;
export const EMBED_MIN_TTL_SECONDS = 15;
export const EMBED_MAX_TTL_SECONDS = 300;
/** Max overlapUntil window for overlap verify keys (ADV-014). Not assertion TTL. */
export const EMBED_MAX_OVERLAP_TTL_SECONDS = 4 * 60 * 60;

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

/** Env vars that feed the shared host allowlist (ADV-011). */
export const EMBED_HOST_ALLOWLIST_ENV = [
  "WEB_EMBED_FRAME_ANCESTORS",
  "WEB_PORTAL_FRAME_ANCESTORS",
  "PORTAL_FRAME_ANCESTORS",
] as const;

export type EmbedHostAllowlistEnv = {
  WEB_EMBED_FRAME_ANCESTORS?: string;
  WEB_PORTAL_FRAME_ANCESTORS?: string;
  PORTAL_FRAME_ANCESTORS?: string;
};

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
    if (origin === "'self'" || origin === "self") {
      if (!seen.has("'self'")) {
        seen.add("'self'");
        out.push("'self'");
      }
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

/**
 * Shared host allowlist: WEB_EMBED ∪ WEB_PORTAL ∪ PORTAL_FRAME_ANCESTORS.
 * Drives CSP frame-ancestors on /embed/v1 and postMessage origin checks.
 * Empty fails closed. NEXT_PUBLIC_EMBED_FRAME_ANCESTORS is ignored.
 */
export function embedHostAllowlist(env: EmbedHostAllowlistEnv = {}): string[] {
  return parseEmbedFrameAncestors(
    [
      env.WEB_EMBED_FRAME_ANCESTORS,
      env.WEB_PORTAL_FRAME_ANCESTORS,
      env.PORTAL_FRAME_ANCESTORS,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** Same list as embedHostAllowlist — do not parse a second env source. */
export function embedPostMessageAllowlist(
  env: EmbedHostAllowlistEnv = {},
): string[] {
  return embedHostAllowlist(env);
}

/** Read GET /embed/catalog or GET /portal/adapter `frameAncestors`. */
export function parseCatalogFrameAncestors(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const raw = (payload as Record<string, unknown>).frameAncestors;
  if (Array.isArray(raw)) {
    return parseEmbedFrameAncestors(
      raw.map((item) => (typeof item === "string" ? item : "")).join(" "),
    );
  }
  if (typeof raw === "string") {
    return parseEmbedFrameAncestors(raw);
  }
  return [];
}

export type EmbedProxyRoute = {
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
  { methods: ["POST"], match: (s) => eqSegments(s, ["embed", "keys", "rotate"]) },
];

export function frameAncestorsForPath(
  pathname: string,
  env: EmbedHostAllowlistEnv = {},
): string {
  if (!isEmbedMountPath(pathname)) {
    return "'none'";
  }
  const allow = embedHostAllowlist(env);
  if (allow.length === 0) {
    return "'none'";
  }
  return allow.join(" ");
}

/**
 * Chloe embed-shell helpers on jonny's #125 map (`e111-#125`).
 * Relates to #121 / Part of #120. Keep #121 open.
 */
export const EMBED_STORY = 121;
export const EMBED_VALIDATION_STORY = 122;
export const EMBED_EPIC = 120;
export const EMBED_API_PR = 125;
export const EMBED_ROUTE_MAP_SOURCE = "e111-#125" as const;

export const EMBED_ASSERTION_MESSAGE_TYPE = "flowforge.embed.assertion" as const;
export const EMBED_ASSERTION_MESSAGE_VERSION = 1;
export const EMBED_MAX_ASSERTION_BYTES = 16384;
export const EMBED_JWS_COMPACT_RE =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const EMBED_JWKS_PRIVATE_FIELDS = [
  "d",
  "seed",
  "pem",
  "pkcs8",
  "private_key",
  "privateKey",
  "EMBED_SIGNING_KEY",
] as const;

export const EMBED_HOST_DISPLAY_KEYS = [
  "host",
  "tenant",
  "tenantId",
  "workbench",
  "displayName",
] as const;

export const EMBED_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
  replay: "replay",
  rateLimited: "rate-limited",
} as const;

export const FLOWFORGE_HOST_ISSUER_HEADER = "X-FlowForge-Host-Issuer";
export const FLOWFORGE_HOST_CONTEXT_HEADER = "X-FlowForge-Host-Context";
export const EMBED_HOST_CONTEXT_EMBED = "embed" as const;
export const EMBED_HOST_CONTEXT_PORTAL = "portal" as const;

export const EMBED_EXCHANGE_HELP =
  "POST /embed/exchange {assertion, sdk?: \"embed.v1\"} through the same-origin /api/v1 proxy with credentials:include. The compact JWS is body-only — never query, hash, path, or localStorage. The API verifies signature and claims before any workspace lookup. Send X-FlowForge-Host-Issuer set to the configured host issuer for this frame (Portal issuer on a Portal-framed flow; embed issuer standalone) — never copy iss from the assertion. Optional X-FlowForge-Host-Context: portal|embed selects that path allowlist. Success sets CHIPS ff_session + ff_csrf (SameSite=None; Secure; Partitioned). Host identity is display context until this call succeeds. HTTP 429 rate-limited means backoff (Retry-After); do not treat it as a forbidden assertion.";

/** Embed session cookies after POST /embed/exchange. Not used for POST /session. */
export const EMBED_SESSION_COOKIE = {
  name: "ff_session",
  httpOnly: true,
  sameSite: "None",
  secure: true,
  partitioned: true,
  path: "/api/v1",
} as const;

export const EMBED_CSRF_COOKIE = {
  name: "ff_csrf",
  httpOnly: false,
  sameSite: "None",
  secure: true,
  partitioned: true,
  path: "/api/v1",
} as const;

/** Top-level / non-embed cookies stay Lax/Strict and are not Partitioned. */
export const TOPLEVEL_SESSION_COOKIE = {
  name: "ff_session",
  sameSite: "Lax",
  partitioned: false,
} as const;

export const TOPLEVEL_CSRF_COOKIE = {
  name: "ff_csrf",
  sameSite: "Strict",
  partitioned: false,
} as const;

export const EMBED_COOKIE_CREDENTIALS = "include" as const;

/**
 * CHIPS cookies are sent in a third-party iframe without Storage Access.
 * Do not call requestStorageAccess to get an unpartitioned cookie, and
 * do not fall back to SameSite=None without Partitioned.
 */
export const EMBED_STORAGE_ACCESS_API = {
  required: false,
  requestUnpartitioned: false,
  reason:
    "CHIPS Partitioned cookies are sent in the third-party iframe without unpartitioned storage access.",
} as const;

export const EMBED_CHIPS_SET_COOKIE =
  "SameSite=None; Secure; Partitioned" as const;

export const EMBED_COOKIE_REQUIREMENTS = {
  secureContext: true,
  https: true,
  partitionedSupport: true,
  storageAccessApi: false,
} as const;

export const EMBED_MINT_HELP =
  "Mint is POST /embed/assertions from the host backend (CSRF if ff_session). Subject and issuer bind to the authenticated caller. A different subject requires embed.impersonate (PLATFORM_ADMINS); a different issuer is 403. This shell does not mint. E11.3 owns the Portal adapter.";

export const EMBED_URL_SECRET_MESSAGE =
  "Assertion tokens must not appear in the URL (query, hash, or path). Remove assertion/token/jws params and POST the compact JWS in the exchange body.";

export const EMBED_EXCHANGED_MESSAGE =
  "Assertion exchanged. FlowForge issued a CHIPS ff_session / ff_csrf cookie session (SameSite=None; Secure; Partitioned). Host identity is no longer the authority.";

export const EMBED_SECRET_LEAK_MESSAGE =
  "The API unexpectedly included a compact JWS or private key field. It was discarded and not shown. This is a contract bug.";

export const EMBED_HOST_SUPPLIED_MESSAGE =
  "Do not send id or workspace_id on the exchange body. Workspace scope comes from the verified assertion. Host-supplied identity is HTTP 400.";

export const EMBED_UNAUTHENTICATED_MESSAGE =
  "Session is missing or stale (HTTP 401). In a cross-site iframe this usually means the CHIPS cookie (SameSite=None; Secure; Partitioned) was not stored or sent — require HTTPS / a secure context and Partitioned support. Host identity is still display-only. Exchange a fresh assertion. Do not weaken SameSite.";

export const EMBED_COOKIE_NOT_SENT_MESSAGE = EMBED_UNAUTHENTICATED_MESSAGE;

export const EMBED_FORBIDDEN_MESSAGE =
  "Embed exchange was forbidden (HTTP 403). Host route, tenant, and workbench values do not authorize. The API rejected the assertion.";

export const EMBED_REPLAY_MESSAGE =
  "This assertion was already used or is no longer valid (HTTP 409). Assertions are single-use. Request a new mint from the host backend.";

export const EMBED_RATE_LIMITED_MESSAGE =
  "Embed exchange was rate-limited (HTTP 429). Back off and retry after Retry-After. Do not treat this as a forbidden or invalid assertion.";

/** ADV-012: exchange is rate-limited. Chloe treats 429 as backoff only. */
export const EMBED_RATE_LIMIT_RULES = {
  exchangeRateLimited: true,
  status: 429,
  code: "rate-limited",
  treatAsBackoff: true,
  noUiChangeBeyondBackoff: true,
} as const;

export const EMBED_HOST_DISPLAY_HELP =
  "Host session ≠ FlowForge session. tenant, workbench, host, and displayName on the deep link are display context only until exchange succeeds. They never authorize.";

export const EMBED_TENANCY_HELP =
  "After exchange, persist tenantId + workbenchKey from the API workspace/session.embed — never from host query. Send X-FlowForge-Tenant-ID + X-FlowForge-Workbench-Key on every later call. A disagreeing host tenant/workbench is HTTP 403. Host tenant is never authorization.";

export const EMBED_ROTATE_HELP =
  "Ops only: POST /embed/keys/rotate {action:\"register-overlap\"|\"retire\", publicJwk, overlapUntil} with platform.administer (PLATFORM_ADMINS). overlapUntil is required RFC3339 and must be a short future window (max 4h). publicJwk must be the previous active signing key. The active signing key is not an overlap key and does not use overlapUntil. workspace.administer is 403. Exchange/JWKS refresh overlap from the store and drop missing/expired/far-future overlapUntil kids. Production requires a durable EMBED_SIGNING_KEY (boot-fail if missing). Bad EMBED_OVERLAP_KEYS is boot-fail. The embed shell does not rotate keys.";

export type EmbedHostContext =
  | typeof EMBED_HOST_CONTEXT_EMBED
  | typeof EMBED_HOST_CONTEXT_PORTAL;

export type EmbedHostBinding = {
  hostIssuer?: string;
  hostContext?: EmbedHostContext | string;
};

export type EmbedExchangeBody = {
  assertion: string;
  sdk?: typeof EMBED_SDK;
  hostIssuer?: string;
  hostContext?: string;
};

export type EmbedHostDisplay = {
  host: string;
  tenant: string;
  tenantId: string;
  workbench: string;
  displayName: string;
  unverified: true;
};

export type EmbedVerifiedContext = {
  audience: string;
  sdk: string;
  tenantId: string;
  tenantSlug: string;
  workbenchKey: string;
  workspaceId: string;
  workspaceName: string;
  capabilities: string[];
  tokenId: string;
  expiresAt?: string;
};

export type EmbedSessionBinding = {
  mode: "embed";
  sdk: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  workbenchKey: string;
  workspaceId: string;
  workspaceName: string;
  capabilities: string[];
};

/** Chrome-safe GET /session fields. No secrets, no raw assertion. */
export type EmbedChromeFromSession = EmbedSessionBinding & {
  displayName: string;
};

export type EmbedChromeDecision =
  | {
      ok: true;
      chrome: EmbedChromeFromSession;
      leaked: boolean;
      strippedKeys: string[];
    }
  | {
      ok: false;
      reason: "missing-embed-binding";
      message: string;
      leaked: boolean;
      strippedKeys: string[];
    };

/** How the embed shell must honor workbench/tenant after E11.2 exchange. */
export const EMBED_TENANCY_RULES = {
  persistFromExchangeNotHost: true,
  sendTenantAndWorkbenchHeaders: true,
  hostTenantIsNotAuthorization: true,
  headerMismatchFailsClosed: true,
  capabilitiesCapSession: true,
  sessionEmbedIsSourceOfTruth: true,
  chromeFromGetSession: true,
} as const;

/**
 * ADV-021 Chloe retarget map — drive embed chrome from GET /session.
 * Keep #151 open. Prefer no product-shell rewrite here.
 */
export const EMBED_CHROME_FROM_SESSION = {
  path: "GET /session",
  source: "session.embed",
  embedModeField: "session.embed.mode",
  embedModeValue: "embed",
  fields: {
    mode: "session.embed.mode — always \"embed\" when the object is present",
    sdk: "session.embed.sdk — embed.v1",
    capabilities: "session.embed.capabilities — session-capped minted set; hide nav the session cannot perform",
    tenantId: "session.embed.tenantId",
    tenantSlug: "session.embed.tenantSlug — chrome tenant label (prefer over id)",
    tenantName: "session.embed.tenantName",
    workbenchKey: "session.embed.workbenchKey",
    workspaceId: "session.embed.workspaceId",
    workspaceName: "session.embed.workspaceName",
    displayName: "principal.display_name — chrome-safe subject label",
  },
  refetch: [
    "after successful POST /embed/exchange (overwrite sessionStorage from GET /session, not assertion leftovers)",
    "on /embed/v1 mount when ff_session may exist",
    "after POST /session/refresh",
    "on 401 — clear chrome and re-exchange; do not keep stale sessionStorage",
  ],
  failClosed:
    "On /embed/v1, GET /session without session.embed is not an embed session. Close chrome. Do not fall back to host query, catalog capabilities, or assertion leftovers.",
  doNotUse: [
    "assertion leftovers (display_name / host / jti / compact JWS)",
    "GET /embed/catalog capabilities as chrome nav authority",
    "host query tenant / workbench / displayName / workspace_id",
    "client-only guesses after a bound session exists",
  ],
  secretsNeverPresent: [
    "assertion",
    "jti",
    "tokenId",
    "d",
    "seed",
    "pem",
    "private_key",
    "privateKey",
    "EMBED_SIGNING_KEY",
  ],
} as const;

export const EMBED_CHROME_FROM_SESSION_RULES = {
  sessionIsAuthority: true,
  noAssertionLeftovers: true,
  noCatalogGuesses: true,
  noHostQueryAuthority: true,
  failClosedWithoutEmbedBinding: true,
  capabilitiesAreCapped: true,
  noSecrets: true,
  noProductShellRewrite: true,
} as const;

export const EMBED_CHROME_FROM_SESSION_HELP =
  "Drive embed chrome from GET /session session.embed after exchange. Capabilities, tenant/workbench display, workspace identity, and the embed mode flag come from that object (plus principal.display_name). Host query, catalog guesses, and assertion leftovers are not chrome authority. Fail closed on /embed/v1 if session.embed is missing.";

export const EMBED_CHROME_MISSING_SESSION_MESSAGE =
  "This embed has no FlowForge-bound session. GET /session did not return session.embed. Host identity and catalog values are not chrome authority. Exchange a host assertion.";

/** ADV-008: exchange verifies before tenant/workbench resolution. No UI. */
export const EMBED_VERIFY_RULES = {
  verifyBeforeWorkspaceLookup: true,
  noWorkspaceOracleOnInvalidAssertion: true,
  jtiConsumeAfterVerify: true,
} as const;

/**
 * ADV-023: bind iss to the minting host issuer on exchange.
 * Chloe sends the configured host issuer, never a peeked assertion iss.
 */
export const EMBED_HOST_ISSUER_RULES = {
  bindIssToMintingHost: true,
  header: FLOWFORGE_HOST_ISSUER_HEADER,
  contextHeader: FLOWFORGE_HOST_CONTEXT_HEADER,
  neverPeekIssFromAssertion: true,
  requiredWhenMultipleIssuers: true,
  wrongIssuerForHostIs403: true,
  noUiRewriteBeyondHeader: true,
  catalogIssuersField: "issuers",
  portalIssuerEnv: "PORTAL_ISSUER",
  embedIssuerEnv: "EMBED_ISSUER",
  nextPublicIsNotASource: true,
} as const;

export const EMBED_HOST_ISSUER_HELP =
  "On POST /embed/exchange send X-FlowForge-Host-Issuer (or body hostIssuer) set to the configured Portal or embed issuer for this frame. Do not copy iss/host from the assertion. Optional X-FlowForge-Host-Context: portal (Portal-framed) or embed (standalone) selects that path allowlist. Wrong-issuer-for-host is HTTP 403. Prefer no UI rewrite beyond attaching the header.";

/** ADV-009: atomic jti consume; used ids retained 24h past exp. No UI. */
export const EMBED_JTI_RULES = {
  atomicSingleStatementConsume: true,
  retainUsedIdsPastExpiry: true,
  retention: "24h",
  replayIs409: true,
} as const;

/** ADV-007: embed cookies are CHIPS; top-level cookies stay Lax/Strict. */
export const EMBED_CHIPS_RULES = {
  partitioned: true,
  secure: true,
  sameSite: "None",
  neverDropSecure: true,
  neverSameSiteNoneWithoutPartitioned: true,
  neverWeakenTopLevelSameSite: true,
  credentialsInclude: true,
  storageAccessApiRequired: false,
  storageAccessUnpartitionedForbidden: true,
  cookieNotSentIs401or403: true,
} as const;

export type EmbedExchangeResult = {
  context: EmbedVerifiedContext;
  leaked: boolean;
  strippedKeys: string[];
};

export type EmbedAssertionMessage = {
  type: typeof EMBED_ASSERTION_MESSAGE_TYPE;
  version: typeof EMBED_ASSERTION_MESSAGE_VERSION;
  assertion: string;
};

export function isEmbedUiPath(pathname: string | null | undefined): boolean {
  return Boolean(pathname && isEmbedMountPath(pathname));
}

export function isCompactJws(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.length > EMBED_MAX_ASSERTION_BYTES) {
    return false;
  }
  return EMBED_JWS_COMPACT_RE.test(trimmed);
}

export function forgetEmbedAssertion(holder: { assertion: string }): string {
  holder.assertion = "";
  return "";
}

export function buildEmbedExchangeBody(
  assertion: string,
  binding?: EmbedHostBinding,
): EmbedExchangeBody {
  const body: EmbedExchangeBody = { assertion: assertion.trim(), sdk: EMBED_SDK };
  const hostIssuer = binding?.hostIssuer?.trim();
  const hostContext = binding?.hostContext?.trim();
  if (hostIssuer) {
    body.hostIssuer = hostIssuer;
  }
  if (hostContext) {
    body.hostContext = hostContext;
  }
  return body;
}

/** Headers Chloe must send on exchange. Values are configured host issuers. */
export function embedHostBindingHeaders(
  binding?: EmbedHostBinding,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const hostIssuer = binding?.hostIssuer?.trim();
  const hostContext = binding?.hostContext?.trim();
  if (hostIssuer) {
    headers[FLOWFORGE_HOST_ISSUER_HEADER] = hostIssuer;
  }
  if (hostContext) {
    headers[FLOWFORGE_HOST_CONTEXT_HEADER] = hostContext;
  }
  return headers;
}

/**
 * ADV-023: the embed shell never reads iss / host from the compact JWS.
 * Always undefined — configured catalog/env issuers are the only source.
 */
export function peekAssertionHostIssuer(_assertion: string): undefined {
  void _assertion;
  return undefined;
}

export type ConfiguredHostIssuerEnv = {
  PORTAL_ISSUER?: string;
  EMBED_ISSUER?: string;
  WEB_PORTAL_FRAME_ANCESTORS?: string;
  NEXT_PUBLIC_PORTAL_ISSUER?: string;
  NEXT_PUBLIC_EMBED_ISSUER?: string;
};

/**
 * Server-only issuer config. NEXT_PUBLIC_* is ignored — not a source of
 * truth for host-issuer binding (same rule as ADV-011 frame ancestors).
 */
export function readConfiguredHostIssuers(
  env: ConfiguredHostIssuerEnv = {},
): {
  portalIssuer: string;
  embedIssuer: string;
  portalReferrerAllowlist: string[];
} {
  void env.NEXT_PUBLIC_PORTAL_ISSUER;
  void env.NEXT_PUBLIC_EMBED_ISSUER;
  return {
    portalIssuer: env.PORTAL_ISSUER?.trim() ?? "",
    embedIssuer: env.EMBED_ISSUER?.trim() ?? "",
    portalReferrerAllowlist: parseEmbedFrameAncestors(
      env.WEB_PORTAL_FRAME_ANCESTORS,
    ),
  };
}

/**
 * Published allowlist from GET /portal/adapter (or catalog `issuers` if
 * present). Never reads iss / host / assertion.
 */
export function parseCatalogIssuers(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const raw = payload as Record<string, unknown>;
  const fromList = readConfiguredIssuerList(raw.issuers);
  if (fromList.length > 0) {
    return fromList;
  }
  const single = readConfiguredIssuerString(
    raw.issuer ?? raw.embedIssuer ?? raw.portalIssuer,
  );
  return single ? [single] : [];
}

/** Single configured issuer, or empty when the allowlist is ambiguous. */
export function resolveConfiguredHostIssuer(input: {
  issuers?: readonly string[];
  primaryIssuer?: string;
}): string {
  const primary = readConfiguredIssuerString(input.primaryIssuer);
  if (primary) {
    return primary;
  }
  const unique = uniqueConfiguredIssuers(input.issuers);
  if (unique.length === 1) {
    return unique[0] ?? "";
  }
  return "";
}

export type DetectEmbedHostContextInput = {
  /** Explicit override (tests / host wiring). */
  hostContext?: string;
  referrer?: string;
  selfOrigin?: string;
  /** Portal-only origins (WEB_PORTAL_FRAME_ANCESTORS), not the merged list. */
  portalReferrerAllowlist?: readonly string[];
};

/**
 * Portal-framed vs standalone. Same-origin /portal demo, portal referrer
 * allowlist, or an explicit prop. Unknown framing defaults to embed on
 * the embed mount — never inferred from the assertion.
 */
export function detectEmbedHostContext(
  input: DetectEmbedHostContextInput = {},
): EmbedHostContext {
  const explicit = normalizeEmbedHostContext(input.hostContext);
  if (explicit) {
    return explicit;
  }
  if (isPortalDemoReferrer(input.referrer, input.selfOrigin)) {
    return EMBED_HOST_CONTEXT_PORTAL;
  }
  const referrerOrigin = originFromReferrer(input.referrer);
  if (
    referrerOrigin &&
    isAllowedEmbedMessageOrigin(referrerOrigin, input.portalReferrerAllowlist ?? [])
  ) {
    return EMBED_HOST_CONTEXT_PORTAL;
  }
  return EMBED_HOST_CONTEXT_EMBED;
}

export type ResolveEmbedHostBindingInput = DetectEmbedHostContextInput & {
  portalIssuers?: readonly string[];
  embedIssuers?: readonly string[];
  portalIssuer?: string;
  embedIssuer?: string;
};

/**
 * Host-issuer binding for POST /embed/exchange. Input has no assertion
 * field — iss / host are never copied from the JWS.
 */
export function resolveEmbedHostBinding(
  input: ResolveEmbedHostBindingInput = {},
): EmbedHostBinding {
  const hostContext = detectEmbedHostContext(input);
  const hostIssuer =
    hostContext === EMBED_HOST_CONTEXT_PORTAL
      ? resolveConfiguredHostIssuer({
          issuers: input.portalIssuers,
          primaryIssuer: input.portalIssuer,
        })
      : resolveConfiguredHostIssuer({
          issuers: input.embedIssuers,
          primaryIssuer: input.embedIssuer,
        });
  const binding: EmbedHostBinding = { hostContext };
  if (hostIssuer) {
    binding.hostIssuer = hostIssuer;
  }
  return binding;
}

export function normalizeEmbedHostContext(
  value: string | undefined,
): EmbedHostContext | "" {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed === EMBED_HOST_CONTEXT_PORTAL) {
    return EMBED_HOST_CONTEXT_PORTAL;
  }
  if (trimmed === EMBED_HOST_CONTEXT_EMBED) {
    return EMBED_HOST_CONTEXT_EMBED;
  }
  return "";
}

/** In-repo Portal host demo: referrer path is /portal or /portal/… */
export function isPortalDemoReferrer(
  referrer: string | undefined,
  selfOrigin?: string,
): boolean {
  const parsed = parseReferrerUrl(referrer);
  if (!parsed) {
    return false;
  }
  const path = parsed.pathname;
  if (path !== "/portal" && !path.startsWith("/portal/")) {
    return false;
  }
  const self = selfOrigin?.trim() ?? "";
  if (self && parsed.origin !== self) {
    return false;
  }
  return true;
}

function parseReferrerUrl(referrer: string | undefined): URL | null {
  const trimmed = referrer?.trim() ?? "";
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function originFromReferrer(referrer: string | undefined): string {
  return parseReferrerUrl(referrer)?.origin ?? "";
}

function readConfiguredIssuerString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || isCompactJws(trimmed)) {
    return "";
  }
  return trimmed;
}

function readConfiguredIssuerList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      return uniqueConfiguredIssuers(
        value.split(/[,\s]+/).map((part) => readConfiguredIssuerString(part)),
      );
    }
    return [];
  }
  return uniqueConfiguredIssuers(
    value.map((item) => readConfiguredIssuerString(item)),
  );
}

function uniqueConfiguredIssuers(
  values: readonly (string | undefined)[] | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const issuer = readConfiguredIssuerString(value);
    if (!issuer || seen.has(issuer)) {
      continue;
    }
    seen.add(issuer);
    out.push(issuer);
  }
  return out;
}

export function validateEmbedAssertion(assertion: string):
  | { ok: true; body: EmbedExchangeBody }
  | { ok: false; errors: string[] } {
  const trimmed = assertion.trim();
  const errors: string[] = [];
  if (!trimmed) {
    errors.push("Assertion is required. POST the compact JWS in the body.");
  } else if (trimmed.length > EMBED_MAX_ASSERTION_BYTES) {
    errors.push(`Assertion exceeds ${EMBED_MAX_ASSERTION_BYTES} bytes.`);
  } else if (!isCompactJws(trimmed)) {
    errors.push(
      "Assertion must be a compact JWS (three base64url segments). Do not put it in the URL.",
    );
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, body: buildEmbedExchangeBody(trimmed) };
}

export function parseEmbedAssertionMessage(
  data: unknown,
): EmbedAssertionMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const raw = data as Record<string, unknown>;
  if (raw.type !== EMBED_ASSERTION_MESSAGE_TYPE) {
    return null;
  }
  const version =
    typeof raw.version === "number" ? raw.version : Number(raw.version);
  if (version !== EMBED_ASSERTION_MESSAGE_VERSION) {
    return null;
  }
  const assertion =
    typeof raw.assertion === "string" ? raw.assertion.trim() : "";
  if (!isCompactJws(assertion)) {
    return null;
  }
  return {
    type: EMBED_ASSERTION_MESSAGE_TYPE,
    version: EMBED_ASSERTION_MESSAGE_VERSION,
    assertion,
  };
}

export type EmbedMessageOriginOptions = {
  /** Page origin used to honor `'self'` on the shared list. */
  selfOrigin?: string;
};

/**
 * postMessage origin check against the shared host allowlist.
 * Empty list denies (including same-origin). `*` / `null` never match.
 * `'self'` matches only when selfOrigin is provided and equals origin.
 */
export function isAllowedEmbedMessageOrigin(
  origin: string,
  allowlist: readonly string[],
  options: EmbedMessageOriginOptions = {},
): boolean {
  const trimmed = origin.trim();
  if (!trimmed || trimmed === "null" || trimmed === "*") {
    return false;
  }
  if (allowlist.length === 0) {
    return false;
  }
  if (allowlist.includes(trimmed)) {
    return true;
  }
  const selfOrigin = options.selfOrigin?.trim() ?? "";
  if (
    selfOrigin &&
    trimmed === selfOrigin &&
    (allowlist.includes("'self'") || allowlist.includes("self"))
  ) {
    return true;
  }
  return false;
}

export const EMBED_HOST_ALLOWLIST_RULES = {
  sharedList: true,
  sources: EMBED_HOST_ALLOWLIST_ENV,
  catalogField: "frameAncestors",
  catalogPath: EMBED_CATALOG_PATH,
  portalCatalogPath: "/portal/adapter",
  emptyFailsClosed: true,
  noWildcard: true,
  noOpenPostMessage: true,
  nextPublicIsNotASource: true,
  cspAndPostMessageShareList: true,
} as const;

export const EMBED_HOST_ALLOWLIST_HELP =
  "CSP frame-ancestors on /embed/v1 and postMessage origin checks share one allowlist: WEB_EMBED_FRAME_ANCESTORS ∪ WEB_PORTAL_FRAME_ANCESTORS ∪ PORTAL_FRAME_ANCESTORS. Prefer GET /embed/catalog (or GET /portal/adapter) frameAncestors over client env. Empty list is frame-ancestors 'none' and denies all postMessage, including same-origin, unless 'self' or the exact origin is listed. NEXT_PUBLIC_EMBED_FRAME_ANCESTORS is not a source.";

export function parseEmbedHostDisplay(
  searchParams: URLSearchParams | Record<string, string | string[] | undefined>,
): EmbedHostDisplay {
  const read = (key: string): string => {
    if (searchParams instanceof URLSearchParams) {
      return searchParams.get(key)?.trim() ?? "";
    }
    const raw = searchParams[key];
    if (Array.isArray(raw)) {
      return raw[0]?.trim() ?? "";
    }
    return raw?.trim() ?? "";
  };
  return {
    host: read("host"),
    tenant: read("tenant"),
    tenantId: read("tenantId"),
    workbench: read("workbench"),
    displayName: read("displayName"),
    unverified: true,
  };
}

export function urlRejectedAssertion(search: string, hash = ""): boolean {
  if (stripAssertionParams(search).rejected) {
    return true;
  }
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHash || !rawHash.includes("=")) {
    return false;
  }
  return stripAssertionParams(rawHash).rejected;
}

export function publicJwksOnly(payload: unknown): {
  leaked: boolean;
  strippedKeys: string[];
  keys: Record<string, unknown>[];
} {
  const strippedKeys: string[] = [];
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const rawKeys = Array.isArray(source.keys) ? source.keys : [];
  const keys = rawKeys.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {};
    }
    const copy = { ...(item as Record<string, unknown>) };
    for (const field of EMBED_JWKS_PRIVATE_FIELDS) {
      if (field in copy) {
        delete copy[field];
        strippedKeys.push(`keys[${index}].${field}`);
      }
    }
    return copy;
  });
  return { leaked: strippedKeys.length > 0, strippedKeys, keys };
}

export function sanitizeEmbedExchangePayload(payload: unknown): {
  leaked: boolean;
  strippedKeys: string[];
  record: Record<string, unknown>;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { leaked: false, strippedKeys: [], record: {} };
  }
  const record = { ...(payload as Record<string, unknown>) };
  const strippedKeys: string[] = [];

  if (typeof record.assertion === "string" && isCompactJws(record.assertion)) {
    delete record.assertion;
    strippedKeys.push("assertion");
  } else if (
    record.assertion &&
    typeof record.assertion === "object" &&
    !Array.isArray(record.assertion)
  ) {
    const meta = { ...(record.assertion as Record<string, unknown>) };
    if (typeof meta.assertion === "string" && isCompactJws(meta.assertion)) {
      delete meta.assertion;
      strippedKeys.push("assertion.assertion");
    }
    record.assertion = meta;
  }

  return { leaked: strippedKeys.length > 0, strippedKeys, record };
}

export function parseEmbedVerifiedContext(
  payload: unknown,
): EmbedVerifiedContext {
  const { record } = sanitizeEmbedExchangePayload(payload);
  const assertion =
    record.assertion &&
    typeof record.assertion === "object" &&
    !Array.isArray(record.assertion)
      ? (record.assertion as Record<string, unknown>)
      : {};
  const workspace =
    record.workspace &&
    typeof record.workspace === "object" &&
    !Array.isArray(record.workspace)
      ? (record.workspace as Record<string, unknown>)
      : {};
  const tenant =
    record.tenant &&
    typeof record.tenant === "object" &&
    !Array.isArray(record.tenant)
      ? (record.tenant as Record<string, unknown>)
      : {};
  const session =
    record.session &&
    typeof record.session === "object" &&
    !Array.isArray(record.session)
      ? (record.session as Record<string, unknown>)
      : {};
  const sessionEmbed =
    session.embed &&
    typeof session.embed === "object" &&
    !Array.isArray(session.embed)
      ? (session.embed as Record<string, unknown>)
      : {};
  const capabilities = readStringList(
    record.capabilities ?? sessionEmbed.capabilities ?? assertion.capabilities,
  );
  return {
    audience: readString(assertion.audience, assertion.aud) || EMBED_AUDIENCE,
    sdk: readString(assertion.sdk, record.sdk) || EMBED_SDK,
    tenantId: readString(
      workspace.tenant_id,
      tenant.id,
      sessionEmbed.tenantId,
      sessionEmbed.tenant_id,
      assertion.tenantId,
      assertion.tenant_id,
    ),
    tenantSlug: readString(tenant.slug),
    workbenchKey: readString(
      workspace.workbench_key,
      sessionEmbed.workbenchKey,
      sessionEmbed.workbench_key,
      assertion.workbenchKey,
      assertion.workbench_key,
    ),
    workspaceId: readString(
      workspace.id,
      sessionEmbed.workspaceId,
      sessionEmbed.workspace_id,
      assertion.workspaceId,
    ),
    workspaceName: readString(workspace.name),
    capabilities,
    tokenId: readString(assertion.tokenId, assertion.jti),
    expiresAt: optionalString(assertion.expiresAt, assertion.expires_at),
  };
}

export function parseEmbedExchangePayload(
  payload: unknown,
): EmbedExchangeResult {
  const sanitized = sanitizeEmbedExchangePayload(payload);
  return {
    context: parseEmbedVerifiedContext(sanitized.record),
    leaked: sanitized.leaked,
    strippedKeys: sanitized.strippedKeys,
  };
}

export function embedAuthFailureMessage(
  problem: { status?: number; code?: string } | null | undefined,
): string {
  if (!problem) {
    return "";
  }
  if (
    problem.code === "csrf-required" ||
    problem.code === "csrf-invalid"
  ) {
    return "Mint and later mutations send X-CSRF-Token when ff_session is present. Exchange itself is CSRF-exempt. In a cross-site iframe both ff_session and ff_csrf must be CHIPS (SameSite=None; Secure; Partitioned) or the CSRF cookie is not sent (403).";
  }
  if (
    problem.status === 401 ||
    problem.code === EMBED_PROBLEM_CODES.unauthenticated
  ) {
    return EMBED_UNAUTHENTICATED_MESSAGE;
  }
  if (
    problem.status === 409 ||
    problem.code === EMBED_PROBLEM_CODES.conflict ||
    problem.code === EMBED_PROBLEM_CODES.replay
  ) {
    return EMBED_REPLAY_MESSAGE;
  }
  if (
    problem.status === 429 ||
    problem.code === EMBED_PROBLEM_CODES.rateLimited
  ) {
    return EMBED_RATE_LIMITED_MESSAGE;
  }
  if (
    problem.status === 403 ||
    problem.code === EMBED_PROBLEM_CODES.forbidden
  ) {
    return EMBED_FORBIDDEN_MESSAGE;
  }
  return "";
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function optionalString(...values: unknown[]): string | undefined {
  const text = readString(...values);
  return text || undefined;
}

/** Headers the embed shell must send after exchange. Host query is ignored. */
export function embedWorkspaceHeaders(ctx: EmbedVerifiedContext): {
  tenantId: string;
  workbenchKey: string;
} {
  return { tenantId: ctx.tenantId.trim(), workbenchKey: ctx.workbenchKey.trim() };
}

export function parseSessionEmbedBinding(
  session: unknown,
): EmbedSessionBinding | null {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return null;
  }
  const raw = session as Record<string, unknown>;
  const embed =
    raw.embed && typeof raw.embed === "object" && !Array.isArray(raw.embed)
      ? (raw.embed as Record<string, unknown>)
      : raw;
  const mode = readString(embed.mode);
  if (mode && mode !== "embed") {
    return null;
  }
  const binding: EmbedSessionBinding = {
    mode: "embed",
    sdk: readString(embed.sdk) || EMBED_SDK,
    tenantId: readString(embed.tenantId, embed.tenant_id),
    tenantSlug: readString(embed.tenantSlug, embed.tenant_slug),
    tenantName: readString(embed.tenantName, embed.tenant_name),
    workbenchKey: readString(embed.workbenchKey, embed.workbench_key),
    workspaceId: readString(embed.workspaceId, embed.workspace_id),
    workspaceName: readString(embed.workspaceName, embed.workspace_name),
    capabilities: readStringList(embed.capabilities),
  };
  if (!binding.tenantId || !binding.workbenchKey) {
    return null;
  }
  return binding;
}

const EMBED_CHROME_SECRET_KEYS = [
  "assertion",
  "jti",
  "tokenId",
  "token_id",
  ...EMBED_JWKS_PRIVATE_FIELDS,
] as const;

export function sanitizeSessionChromePayload(payload: unknown): {
  leaked: boolean;
  strippedKeys: string[];
  record: Record<string, unknown>;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { leaked: false, strippedKeys: [], record: {} };
  }
  const record = { ...(payload as Record<string, unknown>) };
  const strippedKeys: string[] = [];
  for (const field of EMBED_CHROME_SECRET_KEYS) {
    if (field in record) {
      delete record[field];
      strippedKeys.push(field);
    }
  }
  if (typeof record.assertion === "string" && isCompactJws(record.assertion)) {
    delete record.assertion;
    if (!strippedKeys.includes("assertion")) {
      strippedKeys.push("assertion");
    }
  }
  return { leaked: strippedKeys.length > 0, strippedKeys, record };
}

/**
 * Chloe chrome parser. Accepts GET /session `{session,principal}` or a
 * session object. Fail-closed when session.embed is missing. Strips
 * unexpected secrets; they are never chrome inputs.
 */
export function parseEmbedChromeFromSession(
  payload: unknown,
): EmbedChromeDecision {
  const sanitized = sanitizeSessionChromePayload(payload);
  const root = sanitized.record;
  const session =
    root.session && typeof root.session === "object" && !Array.isArray(root.session)
      ? (root.session as Record<string, unknown>)
      : root;
  const principal =
    root.principal &&
    typeof root.principal === "object" &&
    !Array.isArray(root.principal)
      ? (root.principal as Record<string, unknown>)
      : {};
  const binding = parseSessionEmbedBinding(session);
  if (!binding) {
    return {
      ok: false,
      reason: "missing-embed-binding",
      message: EMBED_CHROME_MISSING_SESSION_MESSAGE,
      leaked: sanitized.leaked,
      strippedKeys: sanitized.strippedKeys,
    };
  }
  return {
    ok: true,
    chrome: {
      ...binding,
      displayName: readString(
        principal.display_name,
        principal.displayName,
      ),
    },
    leaked: sanitized.leaked,
    strippedKeys: sanitized.strippedKeys,
  };
}

export function isEmbedBoundSession(session: unknown): boolean {
  return parseSessionEmbedBinding(session) !== null;
}

/** Host-supplied tenant is never authorization. Always false. */
export function hostTenantIsAuthorization(_value: unknown): false {
  void _value;
  return false;
}

export function embedHeadersMatchSession(
  headers: { tenantId?: string; workbenchKey?: string },
  bound: EmbedSessionBinding,
): boolean {
  const tenant = headers.tenantId?.trim() ?? "";
  const bench = headers.workbenchKey?.trim() ?? "";
  if (tenant && tenant.toLowerCase() !== bound.tenantId.toLowerCase()) {
    return false;
  }
  if (bench && bench !== bound.workbenchKey) {
    return false;
  }
  return true;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}
