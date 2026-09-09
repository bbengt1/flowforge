/**
 * E4.2 operational-config types aligned to jonny's #41 contract on main.
 * JSON camelCase. Specs are secret-free; credentials stay in the E4.1 vault.
 */

export const OPS_CONFIG_KINDS = [
  "cluster_target",
  "ssh_target",
  "command_profile",
  "runtime_profile",
  "connection",
  "recipient_list",
  "message_template",
  "response_schema",
  "policy",
] as const;

export type OpsConfigKind = (typeof OPS_CONFIG_KINDS)[number];

export const OPS_CONFIG_STATUSES = ["draft", "published", "disabled"] as const;
export type OpsConfigStatus = (typeof OPS_CONFIG_STATUSES)[number];

export const OPS_CONFIG_GROUPS = ["targets", "profiles", "config"] as const;
export type OpsConfigGroup = (typeof OPS_CONFIG_GROUPS)[number];

export const CONNECTION_TYPES = ["http", "webhook", "smtp"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export const RUNTIME_LANGUAGES = ["python", "go"] as const;
export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number];

export const POLICY_KINDS = [
  "kubernetes",
  "ssh",
  "script",
  "http",
  "notification",
  "approval",
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const CONTENT_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
] as const;

/** Secret-free spec. Unknown fields are rejected by the API. */
export type OpsConfigSpec = {
  credentialId?: string;
  endpoint?: {
    apiServer?: string;
    tlsServerName?: string;
    skipTLSVerify?: boolean;
  };
  allowedNamespaces?: string[];
  hostname?: string;
  port?: number;
  hostKeyFingerprint?: string;
  allowedAddresses?: string[];
  policyId?: string;
  parameterSchema?: Record<string, unknown>;
  template?: string;
  retrySafe?: boolean;
  verification?: {
    template?: string;
    expectExitCode?: number;
    expectStdoutContains?: string;
    onMatch?: string;
    onMismatch?: string;
    onError?: string;
  };
  language?: RuntimeLanguage | string;
  imageDigest?: string;
  dependencyLockDigest?: string;
  limits?: {
    cpuMillis?: number;
    memoryMib?: number;
    timeoutSeconds?: number;
    processes?: number;
  };
  type?: ConnectionType | string;
  endpointPolicy?: Record<string, unknown>;
  recipientPolicy?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  contentClassification?: string;
  subject?: string;
  body?: string;
  schema?: Record<string, unknown>;
  maxBytes?: number;
  kind?: PolicyKind | string;
  policy?: Record<string, unknown>;
  serviceAccount?: {
    name?: string;
    namespace?: string;
    roleTemplate?: string;
  };
};

export type OpsConfigSummary = {
  id: string;
  kind: OpsConfigKind;
  slug?: string;
  name: string;
  status: OpsConfigStatus;
  draftRevision: number;
  draftDigest?: string;
  latestVersionId?: string;
  latestVersionNumber?: number;
  latestVersionDigest?: string;
  credentialId?: string;
  policyId?: string;
  updatedAt?: string;
};

export type OpsConfigRecord = OpsConfigSummary;

export type OpsConfigDraft = {
  resourceId: string;
  kind: OpsConfigKind;
  revision: number;
  spec: OpsConfigSpec;
  digest?: string;
};

export type OpsConfigVersion = {
  id: string;
  resourceId: string;
  kind: OpsConfigKind;
  versionNumber: number;
  digest: string;
  spec: OpsConfigSpec;
  publishNote?: string;
  publishedAt?: string;
  publishedBy?: string;
};

/** Server-authorized pin from POST …/select. */
export type OpsConfigPin = {
  kind: OpsConfigKind;
  resourceId: string;
  versionId: string;
  versionNumber: number;
  digest: string;
  name?: string;
  slug?: string;
  spec?: OpsConfigSpec;
};

export type OpsConfigCatalogKind = {
  kind: OpsConfigKind;
  collection: string;
  displayName: string;
  yamlFields: string[];
  usePermission: string;
  allowedCredentialTypes?: string[];
  engine?: string;
};

export type OpsConfigCatalog = {
  kinds: OpsConfigCatalogKind[];
  kubernetesEngine?: Record<string, unknown>;
  /** Present when jonny ships E8.1 catalog fields. */
  sshEngine?: Record<string, unknown>;
};

export type KindDescriptor = {
  kind: OpsConfigKind;
  collection: string;
  group: OpsConfigGroup;
  title: string;
  summary: string;
  yamlRef: string;
};

export type CreateConfigBody = {
  name: string;
  slug?: string;
  spec: OpsConfigSpec;
};

export type SaveDraftBody = {
  revision: number;
  spec: OpsConfigSpec;
  name?: string;
};

export type PublishConfigBody = {
  revision?: number;
  note?: string;
};

export type SelectConfigBody = {
  versionId?: string;
};

export type SelectRef = {
  kind: OpsConfigKind;
  resourceId: string;
  versionId?: string;
};

export type BatchSelectBody = {
  refs: SelectRef[];
};

export type PublishConfigResult = {
  resource: OpsConfigRecord;
  version: OpsConfigVersion;
};
