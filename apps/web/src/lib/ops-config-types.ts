/**
 * Safe E4.2 operational-config types (Chloe UI, #36).
 *
 * Jonny's route map is still in flight. Shapes follow documented
 * drafts/publish/versions plus database.md operational tables.
 * Retarget field names in ops-config-contract.ts — do not invent
 * encryption or secret-bearing fields.
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

export const CONNECTION_TYPES = ["http", "webhook", "email"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export const RUNTIME_LANGUAGES = ["python", "go"] as const;
export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number];

export const POLICY_KINDS = [
  "kubernetes",
  "ssh",
  "script",
  "connection",
  "notification",
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** Secret-free spec. Credential refs are vault ids only. */
export type OpsConfigSpec = {
  credentialId?: string;
  credentialDisplayName?: string;
  endpointMetadata?: Record<string, string | number | boolean>;
  hostname?: string;
  port?: number;
  hostKeyFingerprint?: string;
  policyId?: string;
  parameterSchema?: Record<string, unknown>;
  template?: string;
  retrySafe?: boolean;
  language?: RuntimeLanguage | string;
  imageDigest?: string;
  dependencyLockDigest?: string;
  limits?: Record<string, string | number>;
  connectionType?: ConnectionType | string;
  endpointPolicy?: Record<string, unknown>;
  recipientPolicy?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  contentClassification?: string;
  body?: string;
  schema?: Record<string, unknown>;
  maxBytes?: number;
  policyKind?: PolicyKind | string;
  policyJson?: Record<string, unknown>;
};

export type OpsConfigSummary = {
  id: string;
  kind: OpsConfigKind;
  name: string;
  status: OpsConfigStatus;
  draftRevision?: number;
  latestVersionId?: string;
  latestVersionNumber?: number;
  latestDigest?: string;
  updatedAt?: string;
};

export type OpsConfigRecord = OpsConfigSummary & {
  spec: OpsConfigSpec;
  draftRevision: number;
};

export type OpsConfigDraft = {
  resourceId: string;
  kind: OpsConfigKind;
  name: string;
  revision: number;
  spec: OpsConfigSpec;
  digest?: string;
};

export type OpsConfigVersion = {
  id: string;
  resourceId: string;
  kind: OpsConfigKind;
  name: string;
  versionNumber: number;
  digest: string;
  spec: OpsConfigSpec;
  publishNote?: string;
  publishedAt?: string;
  publishedBy?: string;
};

export type OpsConfigPin = {
  id: string;
  kind: OpsConfigKind;
  displayName: string;
  versionId: string;
  versionNumber: number;
  digest: string;
};

export type OpsConfigList = {
  items: OpsConfigSummary[];
};

export type OpsConfigDetail = {
  resource?: OpsConfigRecord;
  draft?: OpsConfigDraft;
};

export type PublishConfigBody = {
  revision?: number;
  note?: string;
};

export type PublishConfigResult = {
  resource: OpsConfigRecord;
  version: OpsConfigVersion;
};

export type CreateConfigBody = {
  name: string;
  spec: OpsConfigSpec;
};

export type SaveDraftBody = {
  revision: number;
  name?: string;
  spec: OpsConfigSpec;
};

export type RestoreDraftBody = {
  expectedRevision?: number;
};

export type CompareConfigRef =
  | { kind: "draft" }
  | { kind: "version"; versionId?: string; versionNumber?: number };

export type CompareConfigBody = {
  left: CompareConfigRef;
  right: CompareConfigRef;
};

export type CompareConfigChange = {
  path: string;
  code?: string;
  message?: string;
};

export type CompareConfigResult = {
  equal: boolean;
  digestMatch: boolean;
  leftDigest?: string;
  rightDigest?: string;
  changes: CompareConfigChange[];
};

export type OpsConfigVersionList = {
  items: OpsConfigVersion[];
};

export type AuthorizedPinList = {
  items: OpsConfigPin[];
};

export type KindDescriptor = {
  kind: OpsConfigKind;
  collection: string;
  group: OpsConfigGroup;
  title: string;
  summary: string;
  yamlRef: string;
};
