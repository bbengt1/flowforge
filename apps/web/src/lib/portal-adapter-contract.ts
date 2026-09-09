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
 */

import {
  EMBED_ASSERTION_MESSAGE_TYPE,
  EMBED_ASSERTION_MESSAGE_VERSION,
  EMBED_AUDIENCE,
  EMBED_EXCHANGE_PATH,
  EMBED_HOST_DISPLAY_KEYS,
  EMBED_MAX_ASSERTION_BYTES,
  EMBED_MINT_PATH,
  EMBED_MOUNT_PREFIX,
  EMBED_ROUTES,
  EMBED_SDK,
  assertionFromURL,
  embedMountPath,
  frameAncestorsForPath,
  isCompactJws,
  isEmbedMountPath,
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
    do: "Load the canonical UI under /embed/v1. Host tenant/workbench is display-only.",
  },
  {
    id: "exchange",
    actor: "embed-shell",
    path: `/api/v1${PORTAL_EXCHANGE_PATH}`,
    do: "POST {assertion,sdk:embed.v1} to E11.1 exchange with credentials:include. Issues CHIPS ff_session/ff_csrf (SameSite=None; Secure; Partitioned). Replay is 409. Cookie not sent is 401/403.",
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

export function portalFrameAncestors(env: {
  WEB_EMBED_FRAME_ANCESTORS?: string;
  WEB_PORTAL_FRAME_ANCESTORS?: string;
} = {}): string {
  return frameAncestorsForPath(EMBED_MOUNT_PREFIX, env);
}

export const PORTAL_HELP =
  "Portal entry is not FlowForge authorization. Mint via /portal/adapter/assertions, exchange via /embed/exchange, mount /embed/v1.";

export const PORTAL_CHIPS_HELP =
  "Exchange issues CHIPS ff_session/ff_csrf (SameSite=None; Secure; Partitioned) for the cross-site iframe. Keep credentials:include. Do not request Storage Access or unpartitioned cookies. Cookie not sent is 401/403. Top-level FlowForge sessions stay Lax/Strict.";

export const PORTAL_DIRECT_MINT = EMBED_MINT_PATH;

export const PORTAL_RBAC_HELP =
  "Portal entry RBAC decides whether this host may mint/mount. It is not FlowForge authorization and is never sent as a capability.";

export const PORTAL_TENANCY_HELP =
  "Tenant and workbench on this host are display context for the iframe query. After exchange the embed uses FlowForge-verified session.embed headers. Host values are not retried on 403.";

export const PORTAL_ASSERTION_HELP =
  "Mint through POST /portal/adapter/assertions {portalRoles}. Subject defaults to the caller; a different subject requires embed.impersonate (PLATFORM_ADMINS). Then postMessage {type:\"flowforge.embed.assertion\",version:1,assertion} into the iframe. The embed shell POSTs /embed/exchange. Never put the JWS in the URL, hash, path, or localStorage.";

export const PORTAL_BOUNDARY_HELP =
  "This host replaces Portal's protected workflow surface by embedding FlowForge. FlowForge keeps its own database, executor, and authorization. Portal RBAC stays on the Portal side of the iframe.";

export const PORTAL_DENIED_MESSAGE =
  "Portal entry is denied. FlowForge was not contacted. Granting Portal RBAC later still does not authorize FlowForge — a verified assertion exchange is required.";

export const PORTAL_HOSTILE_ISSUER_MESSAGE =
  "Hostile or missing Portal issuer (HTTP 403). Empty PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST fails closed; unknown issuers are denied. Portal admin is not FlowForge membership.";

export const PORTAL_NO_BOOTSTRAP_MESSAGE =
  "Embed sessions cannot create tenants or sibling workbenches (HTTP 403). Portal admin does not grant platform.administer or FlowForge membership bootstrap.";

export const PORTAL_REPLAY_MESSAGE =
  "This assertion was already used (HTTP 409). Exchange is POST /embed/exchange only. Request a new mint.";

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
