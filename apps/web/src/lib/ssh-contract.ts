/**
 * Single adapter for Chloe's E8.1 SSH target + command-profile UI.
 * Retargeted to jonny's #86 map on `main`.
 *
 *   GET      /ops-config/catalog          {kinds, kubernetesEngine, sshEngine}
 *   GET      /ssh/catalog                 param types, render, retry schema, errors
 *   GET|POST /ssh-targets
 *   GET|PUT  /ssh-targets/{id}/draft
 *   POST     /ssh-targets/{id}/publish|select|disable|enable
 *   GET      /ssh-targets/{id}/versions[/{versionId}]
 *   GET|POST /command-profiles
 *   GET|PUT  /command-profiles/{id}/draft
 *   POST     /command-profiles/{id}/publish|select|disable|enable
 *   GET      /command-profiles/{id}/versions[/{versionId}]
 *   POST     /ops-config/select
 *
 * Cookie session + `X-CSRF-Token` on mutations. JSON camelCase.
 * RFC 9457. Host-supplied `id` / `workspaceId` → 400 UX. UI never
 * receives privateKey, passphrase, host private material, or raw logs.
 *
 * Relates to #82 / Part of #81. Keep #82 open (jonny owns engine/APIs).
 * Do not change `apps/api`.
 */

import { ENGINE_CATALOG_UNAVAILABLE_HELP } from "./catalog-fail-closed.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import {
  SSH_CREDENTIAL_TYPE,
  SSH_DEFAULT_PORT,
  SSH_DENIED_FEATURES,
  SSH_SECRET_FIELD_NAMES,
  SSH_TEMPLATE_FORBIDDEN_TOKENS,
  type SshEngineCatalog,
} from "./ssh-types.ts";

export const SSH_RETRY_SAFE_HELP =
  "Mark retrySafe only when this profile declares an idempotent verification probe. Enabling it means a later ssh.run may retry after that probe — never a blind repeat. Default is false. retrySafe=true requires spec.verification.template. maxAttempts>0 on ssh.run requires retrySafe plus verification.";

export { SSH_DENIED_FEATURES } from "./ssh-types.ts";

export const SSH_STORY = 82;
export const SSH_EPIC = 81;
/** Jonny's E8.1 map on main. */
export const SSH_API_PR = 86;
export const SSH_ROUTE_MAP_SOURCE = "e81-#86" as const;

export const SSH_TARGET_UI_COLLECTION = "ssh-targets";
export const SSH_TARGET_UPSTREAM_COLLECTION = "ssh-targets";
export const COMMAND_PROFILE_UI_COLLECTION = "command-profiles";
export const COMMAND_PROFILE_UPSTREAM_COLLECTION = "command-profiles";
export const SSH_CATALOG_UI_COLLECTION = "ssh";
export const SSH_CATALOG_UPSTREAM_COLLECTION = "ssh";
export const SSH_CATALOG_ACTION = "catalog";
export const SSH_OPS_CONFIG_SELECT_UI_PATH = "/ops-config/select";
export const SSH_OPS_CONFIG_SELECT_UPSTREAM_PATH = "/ops-config/select";
export const SSH_OPS_CONFIG_CATALOG_UI_PATH = "/ops-config/catalog";
export const SSH_OPS_CONFIG_CATALOG_UPSTREAM_PATH = "/ops-config/catalog";

export const SSH_DRAFT_ACTION = "draft";
export const SSH_PUBLISH_ACTION = "publish";
export const SSH_SELECT_ACTION = "select";
export const SSH_DISABLE_ACTION = "disable";
export const SSH_ENABLE_ACTION = "enable";
export const SSH_VERSIONS_ACTION = "versions";

export const SSH_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

export const SSH_SECRET_FREE_HELP =
  "SSH targets bind a workspace vault credential by display name and id. The UI never lists, stores, or renders private keys, passwords, host private material, or raw logs.";

export const SSH_FAIL_CLOSED_HELP =
  "Selectors fail closed on HTTP 403. Cross-workspace or unauthorized SSH targets and command profiles are not listed.";

export const SSH_HOST_SUPPLIED_IDENTITY_HELP =
  "Host-supplied id or workspaceId is not accepted. The API returns 400 invalid-request.";

export const SSH_HOST_SUPPLIED_IDENTITY_DETAIL =
  "Do not send id or workspaceId on writes. Workspace scope comes from the session and tenant + workbench headers.";

export const SSH_NOT_A_TERMINAL_HELP =
  "This is not an interactive terminal. Operators choose a published command profile with typed parameters. Arbitrary user shell commands are not accepted.";

export const SSH_REVIEWED_RENDER_HELP =
  "The reviewed profile renderer owns POSIX single-quote substitution for {name} placeholders. It rejects $(), backticks, ${, {{, and values outside the typed schema.";

export const SSH_IMMUTABLE_PIN_HELP =
  "Command profiles are administrator-owned, versioned templates. A profile cannot be edited in place after a workflow version references it. Publication pins the exact target and profile revisions used at execution.";

export const SSH_KEY_ONLY_HELP =
  "Key-only authentication. Bind a workspace ssh_private_key vault credential. Password authentication is denied in MVP.";

export const SSH_FINGERPRINT_HELP =
  "sha256:<64 hex> or OpenSSH SHA256:<base64>. The API canonicalizes to sha256:<hex>.";

export const SSH_ADDRESS_HELP =
  "Optional IP/CIDR allowlist. A present empty list fails closed. 0.0.0.0/0 and unspecified addresses are rejected.";

export const SSH_SAFETY_NOTES = [
  "SSH targets bind a workspace-scoped vault credential — never paste keys, passwords, or host private material into this UI.",
  "This is not an interactive terminal. Workflows run a published command profile with typed parameters, not arbitrary shell.",
  "Known-host fingerprints and host/port allowlists are required configuration. Connections use key-only auth.",
  "Password authentication, agent forwarding, port forwarding, proxy commands, and host-key auto-acceptance are MVP non-goals and stay denied.",
  "Command profiles are admin-owned versioned templates. Publish pins the exact target + profile revisions; later draft edits do not retarget a pin.",
  "The reviewed renderer quotes {name} placeholders with POSIX single quotes and rejects $(), backticks, ${, {{.",
] as const;

/**
 * Empty fail-closed catalog when GET /ssh/catalog is missing or 403.
 * Secret-field names stay so unexpected plaintext can still be stripped.
 */
export const SSH_ENGINE_UNAVAILABLE_CATALOG: SshEngineCatalog = {
  source: "unavailable",
  credentialType: SSH_CREDENTIAL_TYPE,
  allowedCredentialTypes: [],
  credentialSecretFields: [...SSH_SECRET_FIELD_NAMES],
  defaultPort: SSH_DEFAULT_PORT,
  authMethods: [],
  denied: SSH_DENIED_FEATURES,
  templateForbidden: SSH_TEMPLATE_FORBIDDEN_TOKENS,
  parameterTypes: [],
  retrySafeExposed: false,
  notes: ENGINE_CATALOG_UNAVAILABLE_HELP,
};

export function sshTargetsPath(): string {
  return `/${SSH_TARGET_UI_COLLECTION}`;
}

export function sshTargetPath(resourceId: string): string {
  return `${sshTargetsPath()}/${resourceId}`;
}

export function sshTargetDraftPath(resourceId: string): string {
  return `${sshTargetPath(resourceId)}/${SSH_DRAFT_ACTION}`;
}

export function sshTargetPublishPath(resourceId: string): string {
  return `${sshTargetPath(resourceId)}/${SSH_PUBLISH_ACTION}`;
}

export function sshTargetSelectPath(resourceId: string): string {
  return `${sshTargetPath(resourceId)}/${SSH_SELECT_ACTION}`;
}

export function sshTargetDisablePath(resourceId: string): string {
  return `${sshTargetPath(resourceId)}/${SSH_DISABLE_ACTION}`;
}

export function sshTargetEnablePath(resourceId: string): string {
  return `${sshTargetPath(resourceId)}/${SSH_ENABLE_ACTION}`;
}

export function sshTargetVersionsPath(resourceId: string): string {
  return `${sshTargetPath(resourceId)}/${SSH_VERSIONS_ACTION}`;
}

export function sshTargetVersionPath(
  resourceId: string,
  versionId: string,
): string {
  return `${sshTargetVersionsPath(resourceId)}/${versionId}`;
}

export function commandProfilesPath(): string {
  return `/${COMMAND_PROFILE_UI_COLLECTION}`;
}

export function commandProfilePath(resourceId: string): string {
  return `${commandProfilesPath()}/${resourceId}`;
}

export function commandProfileDraftPath(resourceId: string): string {
  return `${commandProfilePath(resourceId)}/${SSH_DRAFT_ACTION}`;
}

export function commandProfilePublishPath(resourceId: string): string {
  return `${commandProfilePath(resourceId)}/${SSH_PUBLISH_ACTION}`;
}

export function commandProfileSelectPath(resourceId: string): string {
  return `${commandProfilePath(resourceId)}/${SSH_SELECT_ACTION}`;
}

export function commandProfileVersionsPath(resourceId: string): string {
  return `${commandProfilePath(resourceId)}/${SSH_VERSIONS_ACTION}`;
}

export function commandProfileVersionPath(
  resourceId: string,
  versionId: string,
): string {
  return `${commandProfileVersionsPath(resourceId)}/${versionId}`;
}

export function sshBatchSelectPath(): string {
  return SSH_OPS_CONFIG_SELECT_UI_PATH;
}

export function sshOpsConfigCatalogPath(): string {
  return SSH_OPS_CONFIG_CATALOG_UI_PATH;
}

export function sshCatalogPath(): string {
  return `/${SSH_CATALOG_UI_COLLECTION}/${SSH_CATALOG_ACTION}`;
}

export function sshTargetsHref(): string {
  return `/config/${SSH_TARGET_UI_COLLECTION}`;
}

export function commandProfilesHref(): string {
  return `/config/${COMMAND_PROFILE_UI_COLLECTION}`;
}

export function retargetSshCollectionPath(
  uiApiPath: string,
  uiCollection: string,
  upstreamCollection: string,
): string {
  const prefix = `/api/v1/${uiCollection}`;
  const target = `/api/v1/${upstreamCollection}`;
  if (
    uiApiPath === prefix ||
    uiApiPath.startsWith(`${prefix}/`) ||
    uiApiPath.startsWith(`${prefix}?`)
  ) {
    return `${target}${uiApiPath.slice(prefix.length)}`;
  }
  return uiApiPath;
}

function retargetExactPath(
  collected: string,
  uiPath: string,
  upstreamPath: string,
): string {
  if (uiPath === upstreamPath) {
    return collected;
  }
  const from = `/api/v1${uiPath}`;
  const to = `/api/v1${upstreamPath}`;
  if (collected === from || collected.startsWith(`${from}?`)) {
    return `${to}${collected.slice(from.length)}`;
  }
  return collected;
}

/**
 * Rewrite UI `/api/v1/{ssh-targets,command-profiles,ssh,ops-config}…`
 * onto the #86 upstream collections. Today this is identity.
 */
export function retargetSshApiPath(uiApiPath: string): string {
  let collected = retargetSshCollectionPath(
    uiApiPath,
    SSH_TARGET_UI_COLLECTION,
    SSH_TARGET_UPSTREAM_COLLECTION,
  );
  collected = retargetSshCollectionPath(
    collected,
    COMMAND_PROFILE_UI_COLLECTION,
    COMMAND_PROFILE_UPSTREAM_COLLECTION,
  );
  collected = retargetSshCollectionPath(
    collected,
    SSH_CATALOG_UI_COLLECTION,
    SSH_CATALOG_UPSTREAM_COLLECTION,
  );
  collected = retargetExactPath(
    collected,
    SSH_OPS_CONFIG_CATALOG_UI_PATH,
    SSH_OPS_CONFIG_CATALOG_UPSTREAM_PATH,
  );
  return retargetExactPath(
    collected,
    SSH_OPS_CONFIG_SELECT_UI_PATH,
    SSH_OPS_CONFIG_SELECT_UPSTREAM_PATH,
  );
}

export function isSshProxySegments(segments: string[]): boolean {
  return (
    segments[0] === SSH_TARGET_UI_COLLECTION ||
    segments[0] === COMMAND_PROFILE_UI_COLLECTION ||
    (segments[0] === SSH_CATALOG_UI_COLLECTION &&
      segments[1] === SSH_CATALOG_ACTION)
  );
}

export type SshProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function isE81Collection(value: string | undefined): boolean {
  return (
    value === SSH_TARGET_UI_COLLECTION ||
    value === COMMAND_PROFILE_UI_COLLECTION
  );
}

/**
 * Allowlisted Next proxy routes. identity-proxy spreads this array so a
 * retarget only edits this file. Draft/publish/versions/select match
 * the #86 map (ops-config collections + GET /ssh/catalog).
 * No GET …/authorized.
 */
export const SSH_PROXY_ROUTES: readonly SshProxyRoute[] = [
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === SSH_CATALOG_UI_COLLECTION &&
      s[1] === SSH_CATALOG_ACTION,
  },
  {
    methods: ["GET", "POST"],
    match: (s) => s.length === 1 && isE81Collection(s[0]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 && isE81Collection(s[0]) && isResourceId(s[1]),
  },
  {
    methods: ["GET", "PUT"],
    match: (s) =>
      s.length === 3 &&
      isE81Collection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === SSH_DRAFT_ACTION,
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      isE81Collection(s[0]) &&
      isResourceId(s[1]) &&
      (s[2] === SSH_PUBLISH_ACTION ||
        s[2] === SSH_SELECT_ACTION ||
        s[2] === SSH_DISABLE_ACTION ||
        s[2] === SSH_ENABLE_ACTION),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      isE81Collection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === SSH_VERSIONS_ACTION,
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 4 &&
      isE81Collection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === SSH_VERSIONS_ACTION &&
      isResourceId(s[3]),
  },
];

export function emptySshTargetSpec(): {
  credentialId: string;
  hostname: string;
  port: number;
  hostKeyFingerprint: string;
} {
  return {
    credentialId: "",
    hostname: "",
    port: SSH_DEFAULT_PORT,
    hostKeyFingerprint: "",
  };
}

export function emptyCommandProfileSpec(): {
  parameterSchema: Record<string, unknown>;
  template: string;
  retrySafe: false;
} {
  return {
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    template: "",
    retrySafe: false,
  };
}
