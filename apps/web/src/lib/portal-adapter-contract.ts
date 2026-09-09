/**
 * E11.3 CP Ops Portal adapter (Chloe host wiring).
 *
 * Portal entry RBAC stays on the host. FlowForge mint/exchange stay
 * embed.v1. This file is the route, capability, and frame-ancestor map
 * so Chloe can wire the Portal add-in without rewriting product pages.
 *
 * Relates to #123 / Part of #120. Keep #123 open.
 */

import {
  EMBED_AUDIENCE,
  EMBED_EXCHANGE_PATH,
  EMBED_MINT_PATH,
  EMBED_MOUNT_PREFIX,
  EMBED_SDK,
  frameAncestorsForPath,
  type EmbedProxyRoute,
} from "./embed-contract.ts";

export const PORTAL_ADAPTER = "portal.v1" as const;
export const PORTAL_STORY = 123;
export const PORTAL_EPIC = 120;
export const PORTAL_ENTRY_PATH = "/portal/workflows";
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
    do: "POST {assertion,sdk:embed.v1} to E11.1 exchange. Replay is 409.",
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

export const PORTAL_DIRECT_MINT = EMBED_MINT_PATH;
