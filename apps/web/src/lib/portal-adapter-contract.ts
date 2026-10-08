/**
 * E11.3 CP Ops Portal adapter (Chloe host wiring).
 *
 * Portal entry RBAC stays on the host. FlowForge mint/exchange stay
 * embed.v1. This file is the route, capability, and frame-ancestor map
 * so Chloe can wire the Portal add-in without rewriting product pages.
 *
 * Relates to #123 / Part of #120. Keep #123 open.
 *
 * ADV-005: empty PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST fails closed
 * (HTTP 403) the same as an unknown issuer. No UI rewrite.
 *
 * ADV-004: mint subject binds to the Portal service caller unless
 * embed.impersonate (PLATFORM_ADMINS). A different issuer is 403.
 * No host chrome change — backend identity + allowlist only.
 *
 * ADV-007: embed exchange cookies are CHIPS (SameSite=None; Secure;
 * Partitioned). Keep credentials:include. Do not request Storage
 * Access / unpartitioned cookies. Cookie not sent is 401/403.
 *
 * ADV-008: POST /embed/exchange verifies before workspace lookup.
 * No host chrome change.
 *
 * ADV-011: Portal + embed frame ancestors share one allowlist with
 * postMessage. Prefer GET /portal/adapter frameAncestors (same merge
 * as GET /embed/catalog). Empty fails closed.
 *
 * ADV-013: prove the adapter on two distinct HTTPS origins (Portal
 * host ≠ embed). In-repo /portal/workflows is same-origin only.
 * Cross-origin hosts use deliverCrossOriginPortalAssertion and
 * buildCrossOriginPortalEmbedSrc. See adv013-cross-origin-contract.ts.
 *
 * ADV-023: Portal-framed exchange must send X-FlowForge-Host-Issuer
 * set to the configured PORTAL_ISSUER (never peeked from the
 * assertion) and X-FlowForge-Host-Context: portal. Prefer no host
 * chrome rewrite beyond those headers.
 */

import {
  EMBED_ASSERTION_MESSAGE_TYPE,
  EMBED_ASSERTION_MESSAGE_VERSION,
  EMBED_AUDIENCE,
  EMBED_EXCHANGE_PATH,
  EMBED_HOST_CONTEXT_PORTAL,
  EMBED_HOST_ISSUER_HELP,
  FLOWFORGE_HOST_CONTEXT_HEADER,
  FLOWFORGE_HOST_ISSUER_HEADER,
  EMBED_HOST_DISPLAY_KEYS,
  EMBED_MAX_ASSERTION_BYTES,
  EMBED_MINT_PATH,
  EMBED_MOUNT_PREFIX,
  EMBED_ROUTES,
  EMBED_SDK,
  assertionFromURL,
  embedMountPath,
  embedHostAllowlist,
  embedPostMessageAllowlist,
  frameAncestorsForPath,
  isAllowedEmbedMessageOrigin,
  isCompactJws,
  isEmbedMountPath,
  parseCatalogFrameAncestors,
  parseCatalogIssuers,
  type EmbedHostAllowlistEnv,
  stripAssertionParams,
  type EmbedAssertionMessage,
  type EmbedHostDisplay,
  type EmbedProxyRoute,
  type EmbedRouteId,
} from "./embed-contract.ts";

export const PORTAL_ADAPTER = "portal.v1" as const;
export const PORTAL_STORY = 123;
export const PORTAL_EPIC = 120;
export const PORTAL_API_PR = 129;
export const PORTAL_ROUTE_MAP_SOURCE = "e113-#129" as const;
export const PORTAL_ENTRY_PATH = "/portal/workflows";
export const PORTAL_HOST_NAME = "CP Ops Portal";
export const PORTAL_ADAPTER_PATH = "/portal/adapter";
export const PORTAL_MINT_PATH = "/portal/adapter/assertions";
export const PORTAL_EXCHANGE_PATH = EMBED_EXCHANGE_PATH;
export const PORTAL_MOUNT_PREFIX = EMBED_MOUNT_PREFIX;
export const PORTAL_AUDIENCE = EMBED_AUDIENCE;
export const PORTAL_SDK = EMBED_SDK;

export const PORTAL_ROLES = [
  "portal.viewer",
  "portal.editor",
  "portal.publisher",
  "portal.operator",
  "portal.approver",
  "portal.admin",
] as const;

export type PortalRole = (typeof PORTAL_ROLES)[number];

export const PORTAL_ROLE_ALIASES: Record<PortalRole, string> = {
  "portal.viewer": "viewer",
  "portal.editor": "editor",
  "portal.publisher": "publisher",
  "portal.operator": "operator",
  "portal.approver": "approver",
  "portal.admin": "admin",
};

export const PORTAL_CAPABILITY_MAP: Record<PortalRole, readonly string[]> = {
  "portal.viewer": [
    "workflow.view",
    "execution.view",
    "approval.view",
    "opsconfig.view",
    "alert.view",
  ],
  "portal.editor": [
    "workflow.view",
    "workflow.edit",
    "execution.view",
    "credential.view",
    "approval.view",
    "opsconfig.view",
    "opsconfig.edit",
    "alert.view",
  ],
  "portal.publisher": [
    "workflow.view",
    "workflow.edit",
    "workflow.publish",
    "execution.view",
    "credential.view",
    "approval.view",
    "opsconfig.view",
    "opsconfig.edit",
    "opsconfig.publish",
    "alert.view",
  ],
  "portal.operator": [
    "workflow.view",
    "workflow.execute",
    "execution.view",
    "execution.cancel",
    "credential.view",
    "credential.use",
    "approval.view",
    "kubernetes.apply",
    "kubernetes.read",
    "ssh.run",
    "script.run",
    "script.revoke",
    "script.emergencyStop",
    "alert.view",
    "alert.ack",
    "opsconfig.view",
    "opsconfig.use",
    "clusterTarget.use",
    "sshTarget.use",
    "commandProfile.use",
    "runtimeProfile.use",
    "connection.use",
    "recipientList.use",
    "messageTemplate.use",
    "responseSchema.use",
    "policy.use",
  ],
  "portal.approver": [
    "workflow.view",
    "execution.view",
    "approval.view",
    "approval.decide",
    "alert.view",
  ],
  "portal.admin": [],
};

export const PORTAL_BOUNDARY = {
  sharesDatabase: false,
  sharesExecutor: false,
  portalEntryIsAuthorization: false,
  hostTenantIsAuthorization: false,
  assertionAcceptedFromURL: false,
  credentialsOrRawLogsExposedToHost: false,
  usesEmbedMint: true,
  usesEmbedExchange: true,
  parallelAuthPath: false,
} as const;

export const PORTAL_HOST_WIRING = [
  {
    id: "entry",
    actor: "portal",
    path: PORTAL_ENTRY_PATH,
    do: "Portal navigation + Portal RBAC decide whether the user may enter the add-in.",
  },
  {
    id: "map-roles",
    actor: "portal-backend",
    path: `/api/v1${PORTAL_ADAPTER_PATH}`,
    do: "Map Portal roles to FlowForge capabilities. Unknown roles fail closed.",
  },
  {
    id: "mint",
    actor: "portal-backend",
    path: `/api/v1${PORTAL_MINT_PATH}`,
    do: "Mint embed.v1 (aud=flowforge) after Portal RBAC. Compact JWS once.",
  },
  {
    id: "mount",
    actor: "portal-frontend",
    path: PORTAL_MOUNT_PREFIX,
    do: "Load the canonical UI under /embed/v1. Frame and postMessage only when the origin is on GET /portal/adapter frameAncestors (shared host allowlist). Host tenant/workbench is display-only.",
  },
  {
    id: "exchange",
    actor: "embed-shell",
    path: `/api/v1${PORTAL_EXCHANGE_PATH}`,
    do: "POST {assertion,sdk:embed.v1} to E11.1 exchange with credentials:include. Optional X-FlowForge-Host-Issuer from GET /portal/adapter issuers and X-FlowForge-Host-Context: portal (must agree with signed ctx=portal). Issues CHIPS ff_session/ff_csrf (SameSite=None; Secure; Partitioned). Replay is 409. Cookie not sent is 401/403.",
  },
] as const;

function eqSegments(segments: string[], expected: string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

/** Next `/api/control-plane` allowlist for the Portal adapter. */
export const PORTAL_PROXY_ROUTES: readonly EmbedProxyRoute[] = [
  { methods: ["GET"], match: (s) => eqSegments(s, ["portal", "adapter"]) },
  {
    methods: ["POST"],
    match: (s) => eqSegments(s, ["portal", "adapter", "assertions"]),
  },
];

export function normalizePortalRole(raw: string | undefined): PortalRole | "" {
  const role = raw?.trim().toLowerCase() ?? "";
  if (!role) {
    return "";
  }
  if ((PORTAL_ROLES as readonly string[]).includes(role)) {
    return role as PortalRole;
  }
  for (const [portalRole, alias] of Object.entries(PORTAL_ROLE_ALIASES)) {
    if (alias === role) {
      return portalRole as PortalRole;
    }
  }
  return "";
}

export function mapPortalRoles(roles: readonly string[]): {
  capabilities: string[];
  unknown: string[];
} {
  const unknown: string[] = [];
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const raw of roles) {
    const canon = normalizePortalRole(raw);
    if (!canon) {
      unknown.push(raw);
      continue;
    }
    for (const cap of PORTAL_CAPABILITY_MAP[canon]) {
      if (seen.has(cap)) {
        continue;
      }
      seen.add(cap);
      capabilities.push(cap);
    }
  }
  return { capabilities, unknown };
}

export type MintPortalAssertionBody = {
  subject?: string;
  displayName?: string;
  issuer?: string;
  tenantId?: string;
  workbenchKey?: string;
  workspaceId?: string;
  portalRoles?: string[];
  capabilities?: string[];
  ttlSeconds?: number;
};

export function portalMintBody(
  input: MintPortalAssertionBody,
): MintPortalAssertionBody {
  return {
    subject: input.subject,
    displayName: input.displayName,
    issuer: input.issuer,
    tenantId: input.tenantId,
    workbenchKey: input.workbenchKey,
    workspaceId: input.workspaceId,
    portalRoles: input.portalRoles,
    capabilities: input.capabilities,
    ttlSeconds: input.ttlSeconds,
  };
}

export function portalFrameAncestors(env: EmbedHostAllowlistEnv = {}): string {
  return frameAncestorsForPath(EMBED_MOUNT_PREFIX, env);
}

/** Same shared list as embedHostAllowlist / catalog frameAncestors. */
export function portalPostMessageAllowlist(
  env: EmbedHostAllowlistEnv = {},
): string[] {
  return embedPostMessageAllowlist(env);
}

export {
  embedHostAllowlist,
  isAllowedEmbedMessageOrigin,
  parseCatalogFrameAncestors,
  parseCatalogIssuers,
};

/** Contract note. Not UI copy: never render it. */
export const PORTAL_FLOW_CONTRACT_NOTE =
  "Portal entry is not FlowForge authorization. Mint via /portal/adapter/assertions, exchange via /embed/exchange, mount /embed/v1. Relates to #123 / Part of #120 (E11.3, #129 route map).";

export const PORTAL_HELP =
  "Portal access is not FlowForge authorization. FlowForge checks your access itself.";

export const PORTAL_CHIPS_HELP =
  "Exchange issues CHIPS ff_session/ff_csrf (SameSite=None; Secure; Partitioned) for the cross-site iframe. Keep credentials:include. Do not request Storage Access or unpartitioned cookies. Cookie not sent is 401/403. Top-level FlowForge sessions stay Lax/Strict.";

export const PORTAL_DIRECT_MINT = EMBED_MINT_PATH;

export const PORTAL_RBAC_HELP =
  "Portal access decides whether this page can open FlowForge. It isn't FlowForge authorization and is never passed to FlowForge as a permission.";

export const PORTAL_TENANCY_HELP =
  "Tenant and workbench here only label the embedded view. Once you're signed in, FlowForge uses the workspace it verified, and if access is refused it doesn't try again with these values.";

/** Contract note. Not UI copy: never render it. */
export const PORTAL_ASSERTION_CONTRACT_NOTE =
  "Mint through POST /portal/adapter/assertions {portalRoles}. Subject defaults to the caller; a different subject requires embed.impersonate (PLATFORM_ADMINS). Then postMessage {type:\"flowforge.embed.assertion\",version:1,assertion} into the iframe. The embed shell POSTs /embed/exchange with X-FlowForge-Host-Issuer set to the configured PORTAL_ISSUER (never peeked from the assertion) and X-FlowForge-Host-Context: portal. Never put the JWS in the URL, hash, path, or localStorage.";

export const PORTAL_ASSERTION_HELP =
  "Opening FlowForge creates a short-lived sign-in token for the embedded view. FlowForge passes it to the frame once and then forgets it. It's never put in a link or saved in the browser.";

/** PortalHost status lines. */
export const PORTAL_SETTINGS_LOADED =
  "Portal settings loaded. FlowForge maps portal roles itself, and only allowed hosts can show FlowForge in a frame.";

export const PORTAL_SETTINGS_UNAVAILABLE =
  "FlowForge couldn't load the portal settings, so it's using the default role map. It won't pass a sign-in token to the frame until the list of allowed hosts loads.";

export const PORTAL_TOKEN_CREATED =
  "Sign-in token created. FlowForge will pass it to the frame when the frame loads.";

export const PORTAL_TOKEN_DELIVERED =
  "Sign-in token passed to the frame and forgotten. FlowForge checks access with its own session, not the portal's roles.";

export const PORTAL_TOKEN_SKIPPED =
  "The frame loaded, but the sign-in token wasn't passed to it. The token was still forgotten.";

export const PORTAL_NOT_MOUNTED_HELP =
  "FlowForge opens here once portal access is granted and a sign-in token is created. The frame never gets the portal's database, workers, or roles.";

export const PORTAL_ADMIN_NOT_MEMBER_HELP =
  "A portal admin isn't automatically a FlowForge member.";

export const PORTAL_HOST_ISSUER_HELP = EMBED_HOST_ISSUER_HELP;

export const PORTAL_HOST_ISSUER_RULES = {
  header: FLOWFORGE_HOST_ISSUER_HEADER,
  contextHeader: FLOWFORGE_HOST_CONTEXT_HEADER,
  context: EMBED_HOST_CONTEXT_PORTAL,
  sendConfiguredPortalIssuer: true,
  neverPeekIssFromAssertion: true,
  wrongIssuerForHostIs403: true,
} as const;

export const PORTAL_BOUNDARY_HELP =
  "This page shows FlowForge inside the portal. FlowForge keeps its own database, workers, and access checks. Portal roles stay in the portal.";

export const PORTAL_DENIED_MESSAGE =
  "Portal access is denied, so FlowForge wasn't opened. Granting portal access later doesn't give you FlowForge access on its own. FlowForge still checks your sign-in.";

export const PORTAL_HOSTILE_ISSUER_MESSAGE =
  "FlowForge doesn't recognize this portal as an allowed host, so it wasn't opened. A portal admin isn't automatically a FlowForge member.";

export const PORTAL_NO_BOOTSTRAP_MESSAGE =
  "Embed sessions cannot create tenants or sibling workbenches (HTTP 403). Portal admin does not grant platform.administer or FlowForge membership bootstrap.";

export const PORTAL_REPLAY_MESSAGE =
  "This sign-in token was already used. Select Open FlowForge again to get a new one.";

export type PortalEntryRole = "granted" | "denied";

export type PortalEntryRbac = {
  role: PortalEntryRole;
  surface: "portal-entry";
  authorizesFlowForge: false;
};

export function portalRbacIsFlowForgeAuthorization(
  _rbac?: PortalEntryRbac | unknown,
): false {
  void _rbac;
  return false;
}

export function portalEntryAllowsMount(rbac: PortalEntryRbac): boolean {
  return rbac.surface === "portal-entry" && rbac.role === "granted";
}

export function portalEntryRbac(role: PortalEntryRole): PortalEntryRbac {
  return {
    role,
    surface: "portal-entry",
    authorizesFlowForge: false,
  };
}

export function isPortalHostPath(pathname: string | null | undefined): boolean {
  if (!pathname) {
    return false;
  }
  return pathname === "/portal" || pathname.startsWith("/portal/");
}

/** Portal host may iframe same-origin /embed/v1. Standalone stays frame-src none. */
export function frameSrcForPath(pathname: string): string {
  return isPortalHostPath(pathname) ? "'self'" : "'none'";
}

export type PortalHostDisplay = EmbedHostDisplay & {
  host: string;
};

export function portalHostDisplay(input: {
  host?: string;
  tenant?: string;
  tenantId?: string;
  workbench?: string;
  displayName?: string;
}): PortalHostDisplay {
  return {
    host: input.host?.trim() || PORTAL_HOST_NAME,
    tenant: input.tenant?.trim() ?? "",
    tenantId: input.tenantId?.trim() ?? "",
    workbench: input.workbench?.trim() ?? "",
    displayName: input.displayName?.trim() ?? "",
    unverified: true,
  };
}

export function portalDisplayQuery(display: PortalHostDisplay): string {
  const params = new URLSearchParams();
  const pairs: Array<[string, string]> = [
    ["host", display.host],
    ["tenant", display.tenant],
    ["tenantId", display.tenantId],
    ["workbench", display.workbench],
    ["displayName", display.displayName],
  ];
  for (const [key, value] of pairs) {
    if (value && (EMBED_HOST_DISPLAY_KEYS as readonly string[]).includes(key)) {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function fillRouteTemplate(
  template: string,
  params: Record<string, string> | undefined,
): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => {
    const value = params?.[key]?.trim() ?? "";
    return value || `{${key}}`;
  });
}

export type PortalEmbedSrc = {
  src: string;
  rejectedAssertion: boolean;
  displayOnly: true;
};

/** iframe src: /embed/v1 deep link + display query. Assertion never attached. */
export function buildPortalEmbedSrc(input: {
  routeId?: EmbedRouteId;
  standalone?: string;
  params?: Record<string, string>;
  display: PortalHostDisplay;
  leakedSearch?: string;
}): PortalEmbedSrc {
  const route = EMBED_ROUTES.find((item) => item.id === (input.routeId ?? "workflows"));
  const standalone = input.standalone?.trim() || route?.standalone || "/workflows";
  const path = fillRouteTemplate(
    isEmbedMountPath(standalone) ? standalone : embedMountPath(standalone),
    input.params,
  );
  const display = portalDisplayQuery(input.display);
  const leaked = stripAssertionParams(input.leakedSearch ?? "");
  return {
    src: `${path}${display}`,
    rejectedAssertion: leaked.rejected,
    displayOnly: true,
  };
}

export type CrossOriginPortalEmbedSrc = PortalEmbedSrc & {
  embedOrigin: string;
  portalOrigin?: string;
};

/**
 * ADV-013: iframe src on a Portal origin ≠ embed origin.
 * Assertion still never attached. embedOrigin must be an exact http(s) origin.
 */
export function buildCrossOriginPortalEmbedSrc(input: {
  embedOrigin: string;
  routeId?: EmbedRouteId;
  standalone?: string;
  params?: Record<string, string>;
  display: PortalHostDisplay;
  leakedSearch?: string;
}): CrossOriginPortalEmbedSrc {
  const built = buildPortalEmbedSrc(input);
  const embedOrigin = normalizeExactOrigin(input.embedOrigin);
  return {
    ...built,
    src: embedOrigin ? `${embedOrigin}${built.src}` : built.src,
    embedOrigin,
  };
}

export function normalizeExactOrigin(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "null") {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }
    if (parsed.username) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

/** Distinct registrable-looking HTTPS origins (scheme+host+port). */
export function isDistinctOriginPair(a: string, b: string): boolean {
  const left = normalizeExactOrigin(a);
  const right = normalizeExactOrigin(b);
  return Boolean(left && right && left !== right);
}

export function portalUrlContainsAssertion(url: string): boolean {
  if (assertionFromURL(url) !== null) {
    return true;
  }
  try {
    const parsed = new URL(url, "http://portal.invalid");
    if (stripAssertionParams(parsed.search).rejected) {
      return true;
    }
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    if (stripAssertionParams(hash).rejected) {
      return true;
    }
    const path = parsed.pathname.toLowerCase();
    return path.includes("/assertion/") || path.includes("/token/") || path.includes("/jws/");
  } catch {
    return stripAssertionParams(url).rejected;
  }
}

export function parsePortalMintAssertion(payload: unknown):
  | { ok: true; assertion: string; tokenId: string }
  | { ok: false; errors: string[] } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["Mint response is missing."] };
  }
  const raw = payload as Record<string, unknown>;
  const assertion = typeof raw.assertion === "string" ? raw.assertion.trim() : "";
  if (!isCompactJws(assertion) || assertion.length > EMBED_MAX_ASSERTION_BYTES) {
    return {
      ok: false,
      errors: ["Mint did not return a compact JWS. Do not invent one on the host."],
    };
  }
  const tokenId =
    typeof raw.tokenId === "string"
      ? raw.tokenId.trim()
      : typeof raw.jti === "string"
        ? raw.jti.trim()
        : "";
  return { ok: true, assertion, tokenId };
}

export function buildPortalAssertionMessage(
  assertion: string,
): EmbedAssertionMessage | null {
  const trimmed = assertion.trim();
  if (!isCompactJws(trimmed)) {
    return null;
  }
  return {
    type: EMBED_ASSERTION_MESSAGE_TYPE,
    version: EMBED_ASSERTION_MESSAGE_VERSION,
    assertion: trimmed,
  };
}

export function validatePortalRoles(roles: readonly string[]):
  | { ok: true; portalRoles: string[] }
  | { ok: false; errors: string[] } {
  if (roles.length === 0) {
    return {
      ok: false,
      errors: ["Mint requires portalRoles. Portal RBAC is not a FlowForge capability."],
    };
  }
  const mapped = mapPortalRoles(roles);
  if (mapped.unknown.length > 0) {
    return {
      ok: false,
      errors: [`Unknown Portal roles fail closed: ${mapped.unknown.join(", ")}`],
    };
  }
  return { ok: true, portalRoles: roles.map((role) => role.trim()).filter(Boolean) };
}
