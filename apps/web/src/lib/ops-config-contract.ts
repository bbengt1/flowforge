/**
 * E4.2 contract adapter aligned to #41 on main
 * (`docs/reference/backend-api-map.md`).
 *
 * Draft save is PUT + body `revision` (not If-Match). There is no
 * authorized/compare/restore route — select is POST, restore is PUT
 * draft from a version snapshot.
 */

import type {
  BatchSelectBody,
  CreateConfigBody,
  KindDescriptor,
  OpsConfigKind,
  OpsConfigSpec,
  PublishConfigBody,
  SaveDraftBody,
  SelectConfigBody,
  SelectRef,
} from "./ops-config-types.ts";
import { OPS_CONFIG_KINDS } from "./ops-config-types.ts";

export const OPS_CONFIG_STORY = 36;
export const OPS_CONFIG_EPIC = 34;
export const OPS_CONFIG_API_PR = 41;

export const OPS_CONFIG_CATALOG_PATH = "/ops-config/catalog";
export const OPS_CONFIG_SELECT_PATH = "/ops-config/select";

export const OPS_CONFIG_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

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
    summary:
      "Workspace cluster endpoint + vault credential + optional Kubernetes policy pin. Kubeconfig stays in the vault.",
    yamlRef: "clusterTargetId",
  },
  {
    kind: "ssh_target",
    collection: OPS_CONFIG_COLLECTIONS.ssh_target,
    group: "targets",
    title: "SSH targets",
    summary:
      "Workspace SSH host + vault credential + known-host fingerprint. Key-only auth. Private keys stay in the vault.",
    yamlRef: "sshTargetId",
  },
  {
    kind: "command_profile",
    collection: OPS_CONFIG_COLLECTIONS.command_profile,
    group: "profiles",
    title: "Command profiles",
    summary:
      "Admin-owned SSH command templates with typed parameter constraints. Published revisions are immutable pins.",
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
    summary: "HTTP, webhook, and SMTP endpoint policy. Credentials stay in the vault.",
    yamlRef: "connectionId",
  },
  {
    kind: "recipient_list",
    collection: OPS_CONFIG_COLLECTIONS.recipient_list,
    group: "config",
    title: "Recipient lists",
    summary: "Approved recipient emails and domains. Published versions are pinned.",
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
    summary:
      "Target and profile policy revisions, including Kubernetes namespace/kind/verb allowlists. Referenced versions are immutable.",
    yamlRef: "policyId",
  },
];

export const OPS_CONFIG_COLLECTION_VALUES = Object.values(OPS_CONFIG_COLLECTIONS);

export function isOpsConfigKind(value: string | undefined): value is OpsConfigKind {
  return Boolean(value && (OPS_CONFIG_KINDS as readonly string[]).includes(value));
}

export function isOpsConfigCollection(value: string | undefined): boolean {
  return Boolean(value && OPS_CONFIG_COLLECTION_VALUES.includes(value));
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

export function catalogPath(): string {
  return OPS_CONFIG_CATALOG_PATH;
}

export function batchSelectPath(): string {
  return OPS_CONFIG_SELECT_PATH;
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

export function selectPath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/select`;
}

export function disablePath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/disable`;
}

export function enablePath(kind: OpsConfigKind, resourceId: string): string {
  return `${resourcePath(kind, resourceId)}/enable`;
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

export function workflowVersionPinsPath(
  workflowId: string,
  versionId: string,
): string {
  return `/workflows/${workflowId}/versions/${versionId}/pins`;
}

export function emptySpecForKind(kind: OpsConfigKind): OpsConfigSpec {
  switch (kind) {
    case "cluster_target":
      return {
        credentialId: "",
        endpoint: { apiServer: "" },
        serviceAccount: { name: "", roleTemplate: "namespace-scoped-runner" },
      };
    case "ssh_target":
      return {
        credentialId: "",
        hostname: "",
        port: 22,
        hostKeyFingerprint: "",
      };
    case "command_profile":
      return {
        parameterSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        template: "",
      };
    case "runtime_profile":
      return {
        language: "python",
        imageDigest: "",
        dependencyLockDigest: "",
        limits: {
          cpuMillis: 500,
          memoryMib: 256,
          timeoutSeconds: 30,
          processes: 1,
        },
      };
    case "connection":
      return {
        type: "http",
        endpointPolicy: {
          hosts: [],
          methods: ["GET"],
          pathPrefixes: ["/"],
          tlsRequired: true,
          allowRedirects: false,
        },
      };
    case "recipient_list":
      return { recipientPolicy: { emails: [], domains: [] } };
    case "message_template":
      return {
        inputSchema: {},
        contentClassification: "internal",
        body: "",
      };
    case "response_schema":
      return { schema: { type: "object" }, maxBytes: 16384 };
    case "policy":
      return { kind: "kubernetes", policy: {} };
  }
}

export function kindAcceptsPolicyId(kind: OpsConfigKind): boolean {
  return (
    kind === "cluster_target" ||
    kind === "ssh_target" ||
    kind === "command_profile"
  );
}

/** Host-supplied id / workspaceId are never sent on writes. */
export function buildCreateBody(
  name: string,
  spec: OpsConfigSpec,
  slug?: string,
  kind?: OpsConfigKind,
): CreateConfigBody {
  const body: CreateConfigBody = {
    name: name.trim(),
    spec: pickSafeSpec(spec, kind),
  };
  const trimmedSlug = slug?.trim();
  if (trimmedSlug) {
    body.slug = trimmedSlug;
  }
  return body;
}

export function buildSaveDraftBody(
  revision: number,
  spec: OpsConfigSpec,
  name?: string,
  kind?: OpsConfigKind,
): SaveDraftBody {
  const body: SaveDraftBody = {
    revision,
    spec: pickSafeSpec(spec, kind),
  };
  const trimmed = name?.trim();
  if (trimmed) {
    body.name = trimmed;
  }
  return body;
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

export function buildSelectBody(versionId?: string): SelectConfigBody {
  const trimmed = versionId?.trim();
  return trimmed ? { versionId: trimmed } : {};
}

export function buildBatchSelectBody(refs: SelectRef[]): BatchSelectBody {
  return {
    refs: refs.map((ref) => {
      const next: SelectRef = {
        kind: ref.kind,
        resourceId: ref.resourceId,
      };
      if (ref.versionId?.trim()) {
        next.versionId = ref.versionId.trim();
      }
      return next;
    }),
  };
}

const SPEC_KEYS: readonly (keyof OpsConfigSpec)[] = [
  "credentialId",
  "endpoint",
  "allowedNamespaces",
  "hostname",
  "port",
  "hostKeyFingerprint",
  "allowedAddresses",
  "policyId",
  "parameterSchema",
  "template",
  "retrySafe",
  "language",
  "imageDigest",
  "dependencyLockDigest",
  "limits",
  "type",
  "endpointPolicy",
  "recipientPolicy",
  "inputSchema",
  "contentClassification",
  "subject",
  "body",
  "schema",
  "maxBytes",
  "kind",
  "policy",
  "serviceAccount",
];

export function pickSafeSpec(
  spec: OpsConfigSpec,
  kind?: OpsConfigKind,
): OpsConfigSpec {
  const out: OpsConfigSpec = {};
  for (const key of SPEC_KEYS) {
    const value = spec[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "policyId" && kind && !kindAcceptsPolicyId(kind)) {
      continue;
    }
    if (key === "credentialId" || key === "policyId") {
      const id = String(value).trim();
      if (id) {
        out[key] = id;
      }
      continue;
    }
    if (
      (key === "allowedNamespaces" || key === "allowedAddresses") &&
      Array.isArray(value) &&
      value.length === 0
    ) {
      continue;
    }
    if (key === "policy" && value && typeof value === "object" && !Array.isArray(value)) {
      out.policy = omitEmptyAllowlistFields(value as Record<string, unknown>);
      continue;
    }
    if (key === "serviceAccount") {
      const sa = asServiceAccount(value);
      if (sa) {
        out.serviceAccount = sa;
      }
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

const EMPTY_ALLOWLIST_KEYS = new Set([
  "allowedNamespaces",
  "namespaces",
  "allowedKinds",
  "kinds",
  "allowedVerbs",
  "verbs",
  "operations",
]);

function omitEmptyAllowlistFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (EMPTY_ALLOWLIST_KEYS.has(key) && Array.isArray(item) && item.length === 0) {
      continue;
    }
    out[key] = item;
  }
  return out;
}

function asServiceAccount(
  value: unknown,
): OpsConfigSpec["serviceAccount"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) {
    return undefined;
  }
  const out: NonNullable<OpsConfigSpec["serviceAccount"]> = { name };
  if (typeof row.namespace === "string" && row.namespace.trim()) {
    out.namespace = row.namespace.trim();
  }
  if (typeof row.roleTemplate === "string" && row.roleTemplate.trim()) {
    out.roleTemplate = row.roleTemplate.trim();
  }
  return out;
}

export const OPS_CONFIG_VIEW_PERMISSIONS = ["opsconfig.view"] as const;
export const OPS_CONFIG_EDIT_PERMISSIONS = ["opsconfig.edit"] as const;
export const OPS_CONFIG_PUBLISH_PERMISSIONS = ["opsconfig.publish"] as const;
