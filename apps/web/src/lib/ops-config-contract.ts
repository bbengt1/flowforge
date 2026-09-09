/**
 * E4.2 versioned operational-config contract (Chloe UI, #36).
 *
 * Jonny owns the Go APIs + immutability. This adapter is the single
 * retarget point when the route map lands on main — do not stack this
 * UI on a disappearing API feature branch (lesson from #31/#39).
 *
 * TODO(#36): replace OPS_CONFIG_COLLECTIONS / path helpers if jonny
 * publishes different collection names or nests under /workspace/.
 * Prefer REST under /api/v1/ consistent with credentials/workflows:
 * list/create, get/patch draft, publish, versions, compare/restore.
 *
 * Never invent encryption or store secrets client-side. Credentials
 * stay in the E4.1 vault — select by display name / id only.
 */

import type {
  CompareConfigBody,
  CompareConfigRef,
  CreateConfigBody,
  KindDescriptor,
  OpsConfigKind,
  OpsConfigSpec,
  PublishConfigBody,
  RestoreDraftBody,
  SaveDraftBody,
} from "./ops-config-types.ts";
import { OPS_CONFIG_KINDS } from "./ops-config-types.ts";

export const OPS_CONFIG_STORY = 36;
export const OPS_CONFIG_EPIC = 34;

export const IF_MATCH_HEADER = "If-Match";

export const OPS_CONFIG_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

/** Collection paths keyed to #36. Easy to retarget when the API map lands. */
export const OPS_CONFIG_COLLECTIONS: Record<OpsConfigKind, string> = {
  cluster_target: "cluster-targets",
  ssh_target: "ssh-targets",
  command_profile: "command-profiles",
  runtime_profile: "runtime-profiles",
  connection: "connections",
  recipient_list: "recipient-lists",
  message_template: "message-templates",
  response_schema: "response-schemas",
  policy: "policies",
};

export const OPS_CONFIG_KIND_CATALOG: readonly KindDescriptor[] = [
  {
    kind: "cluster_target",
    collection: OPS_CONFIG_COLLECTIONS.cluster_target,
    group: "targets",
    title: "Kubernetes cluster targets",
    summary: "Workspace cluster endpoint metadata. Kubeconfig stays in the vault.",
    yamlRef: "clusterTargetId",
  },
  {
    kind: "ssh_target",
    collection: OPS_CONFIG_COLLECTIONS.ssh_target,
    group: "targets",
    title: "SSH targets",
    summary: "Hostname, port, and host-key fingerprint. Private keys stay in the vault.",
    yamlRef: "sshTargetId",
  },
  {
    kind: "command_profile",
    collection: OPS_CONFIG_COLLECTIONS.command_profile,
    group: "profiles",
    title: "Command profiles",
    summary: "Approved SSH command templates with typed parameters. Published versions are immutable.",
    yamlRef: "commandProfileId",
  },
  {
    kind: "runtime_profile",
    collection: OPS_CONFIG_COLLECTIONS.runtime_profile,
    group: "profiles",
    title: "Runtime profiles",
    summary: "Pinned script runtime image and lock digests. No mutable tags.",
    yamlRef: "runtimeProfileId",
  },
  {
    kind: "connection",
    collection: OPS_CONFIG_COLLECTIONS.connection,
    group: "config",
    title: "Connections",
    summary: "HTTP, webhook, and email endpoint policy. Credentials stay in the vault.",
    yamlRef: "connectionId",
  },
  {
    kind: "recipient_list",
    collection: OPS_CONFIG_COLLECTIONS.recipient_list,
    group: "config",
    title: "Recipient lists",
    summary: "Approved recipient domains and addresses. Published versions are pinned.",
    yamlRef: "recipientListId",
  },
  {
    kind: "message_template",
    collection: OPS_CONFIG_COLLECTIONS.message_template,
    group: "config",
    title: "Message templates",
    summary: "Schema-constrained notification templates. No secrets in content.",
    yamlRef: "templateId",
  },
  {
    kind: "response_schema",
    collection: OPS_CONFIG_COLLECTIONS.response_schema,
    group: "config",
    title: "Response schemas",
    summary: "Bounded JSON-schema subset and max bytes for provider results.",
    yamlRef: "responseSchemaRef",
  },
  {
    kind: "policy",
    collection: OPS_CONFIG_COLLECTIONS.policy,
    group: "config",
    title: "Policies",
    summary: "Target and profile policy revisions. Referenced versions are immutable.",
    yamlRef: "policyId",
  },
];

export const OPS_CONFIG_COLLECTION_VALUES = Object.values(OPS_CONFIG_COLLECTIONS);

export function isOpsConfigKind(value: string | undefined): value is OpsConfigKind {
  return Boolean(value && (OPS_CONFIG_KINDS as readonly string[]).includes(value));
}

export function isOpsConfigCollection(
  value: string | undefined,
): boolean {
  return Boolean(
    value && OPS_CONFIG_COLLECTION_VALUES.includes(value),
  );
}

export function kindFromCollection(
  collection: string | undefined,
): OpsConfigKind | null {
  if (!collection) {
    return null;
  }
  const found = OPS_CONFIG_KIND_CATALOG.find(
    (item) => item.collection === collection,
  );
  return found?.kind ?? null;
}

export function descriptorForKind(kind: OpsConfigKind): KindDescriptor {
  const found = OPS_CONFIG_KIND_CATALOG.find((item) => item.kind === kind);
  if (!found) {
    throw new Error(`unknown ops config kind: ${kind}`);
  }
  return found;
}

export function collectionPath(kind: OpsConfigKind): string {
  return `/${OPS_CONFIG_COLLECTIONS[kind]}`;
}

export function authorizedPath(kind: OpsConfigKind): string {
  return `${collectionPath(kind)}/authorized`;
}

export function resourcePath(kind: OpsConfigKind, resourceId: string): string {
  return `${collectionPath(kind)}/${resourceId}`;
}

export function draftPath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/draft`;
}

export function publishPath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/publish`;
}

export function comparePath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/compare`;
}

export function versionsPath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/versions`;
}

export function versionPath(
  kind: OpsConfigKind,
  resourceId: string,
  versionId: string,
): string {
  return `${versionsPath(kind, resourceId)}/${versionId}`;
}

export function restorePath(
  kind: OpsConfigKind,
  resourceId: string,
  versionId: string,
): string {
  return `${versionPath(kind, resourceId, versionId)}/restore`;
}

export function emptySpecForKind(kind: OpsConfigKind): OpsConfigSpec {
  switch (kind) {
    case "cluster_target":
      return {
        credentialId: "",
        endpointMetadata: { apiServerHost: "", apiServerPort: 6443 },
      };
    case "ssh_target":
      return {
        credentialId: "",
        hostname: "",
        port: 22,
        hostKeyFingerprint: "",
      };
    case "command_profile":
      return { parameterSchema: {}, template: "", retrySafe: false };
    case "runtime_profile":
      return {
        language: "python",
        imageDigest: "",
        dependencyLockDigest: "",
        limits: { cpu: "500m", memory: "256Mi", timeoutSeconds: 30 },
      };
    case "connection":
      return {
        credentialId: "",
        connectionType: "http",
        endpointPolicy: {
          hosts: [],
          methods: ["GET"],
          paths: ["/"],
          tlsVerify: true,
          allowRedirects: false,
        },
      };
    case "recipient_list":
      return { recipientPolicy: { domains: [], addresses: [] } };
    case "message_template":
      return {
        inputSchema: {},
        contentClassification: "internal",
        body: "",
      };
    case "response_schema":
      return { schema: { type: "object" }, maxBytes: 16384 };
    case "policy":
      return { policyKind: "kubernetes", policyJson: {} };
  }
}

/** Host-supplied id / workspaceId are never sent on writes. */
export function buildCreateBody(
  name: string,
  spec: OpsConfigSpec,
): CreateConfigBody {
  return {
    name: name.trim(),
    spec: pickSafeSpec(spec),
  };
}

export function buildSaveDraftBody(
  revision: number,
  name: string,
  spec: OpsConfigSpec,
): SaveDraftBody {
  return {
    revision,
    name: name.trim(),
    spec: pickSafeSpec(spec),
  };
}

export function buildPublishBody(
  revision?: number,
  note?: string,
): PublishConfigBody {
  const body: PublishConfigBody = {};
  if (typeof revision === "number") {
    body.revision = revision;
  }
  const trimmed = note?.trim();
  if (trimmed) {
    body.note = trimmed;
  }
  return body;
}

export function buildRestoreBody(expectedRevision?: number): RestoreDraftBody {
  return typeof expectedRevision === "number" ? { expectedRevision } : {};
}

export function buildCompareBody(
  left: CompareConfigRef,
  right: CompareConfigRef,
): CompareConfigBody {
  return { left, right };
}

const SPEC_KEYS: readonly (keyof OpsConfigSpec)[] = [
  "credentialId",
  "credentialDisplayName",
  "endpointMetadata",
  "hostname",
  "port",
  "hostKeyFingerprint",
  "policyId",
  "parameterSchema",
  "template",
  "retrySafe",
  "language",
  "imageDigest",
  "dependencyLockDigest",
  "limits",
  "connectionType",
  "endpointPolicy",
  "recipientPolicy",
  "inputSchema",
  "contentClassification",
  "body",
  "schema",
  "maxBytes",
  "policyKind",
  "policyJson",
];

export function pickSafeSpec(spec: OpsConfigSpec): OpsConfigSpec {
  const out: OpsConfigSpec = {};
  for (const key of SPEC_KEYS) {
    const value = spec[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "credentialId" || key === "policyId") {
      const id = String(value).trim();
      if (id) {
        out[key] = id;
      }
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Permissions that currently exist on the E2.1 matrix and reasonably
 * gate this operator until jonny publishes E4.2-specific keys.
 *
 * TODO(#36): retarget to clusterTarget.view / commandProfile.manage / etc.
 */
export const OPS_CONFIG_VIEW_PERMISSIONS = [
  "credential.view",
  "workflow.edit",
  "workspace.administer",
] as const;

export const OPS_CONFIG_EDIT_PERMISSIONS = [
  "credential.manage",
  "workflow.edit",
  "workspace.administer",
] as const;

export const OPS_CONFIG_PUBLISH_PERMISSIONS = [
  "workflow.publish",
  "workspace.administer",
] as const;
