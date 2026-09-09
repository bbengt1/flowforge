/**
 * Safe credential vault types for Chloe's E4.1 UI (#35).
 *
 * Shapes match jonny's #38 contract (`vault.Metadata`, catalog, usage,
 * deletion-impact, events). Responses are metadata only. Plaintext
 * secret fields are never part of a persisted or displayed record.
 */

export const CREDENTIAL_MVP_TYPES = [
  "kubernetes",
  "ssh_private_key",
  "token",
  "webhook_secret",
  "provider",
] as const;

export type CredentialType = (typeof CREDENTIAL_MVP_TYPES)[number];

export const CREDENTIAL_STATUSES = ["active", "disabled"] as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CREDENTIAL_TEST_STATUSES = [
  "passed",
  "failed",
  "untested",
] as const;

export type CredentialTestStatus = (typeof CREDENTIAL_TEST_STATUSES)[number];

export const CREDENTIAL_ACTIONS = [
  "view",
  "use",
  "test",
  "rotate",
  "disable",
  "enable",
  "delete",
  "manage",
] as const;

export type CredentialAction = (typeof CREDENTIAL_ACTIONS)[number];

export const CREDENTIAL_EVENT_TYPES = [
  "created",
  "rotated",
  "disabled",
  "enabled",
  "tested",
  "used",
  "metadata_updated",
  "deleted",
] as const;

export type CredentialEventType = (typeof CREDENTIAL_EVENT_TYPES)[number];

export const CREDENTIAL_REF_KINDS = [
  "draft",
  "version",
  "execution",
] as const;

export type CredentialRefKind = (typeof CREDENTIAL_REF_KINDS)[number];

export type CatalogFieldInput = "text" | "textarea" | "password";

export type CredentialCatalogField = {
  name: string;
  input: CatalogFieldInput;
  required: boolean;
};

export type CredentialTypeInfo = {
  type: CredentialType;
  displayName: string;
  secretFields: CredentialCatalogField[];
  metadataFields: CredentialCatalogField[];
};

export type CredentialCatalog = {
  types: CredentialTypeInfo[];
};

/** Metadata-only record. Never includes `secret` or ciphertext. */
export type CredentialRecord = {
  id: string;
  type: CredentialType;
  displayName: string;
  status: CredentialStatus;
  tags: string[];
  metadata: Record<string, string>;
  fingerprint: string;
  encryptionVersion: number;
  keyReference: string;
  lastTestStatus: CredentialTestStatus;
  lastTestedAt?: string;
  lastTestReason?: string;
  lastUsedAt?: string;
  lastUsedBy?: string;
  useCount: number;
  rotatedAt?: string;
  expiresAt?: string;
  disabledAt?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  permittedActions: CredentialAction[];
};

export type CredentialList = {
  items: CredentialRecord[];
};

export type CredentialListQuery = {
  q?: string;
  type?: CredentialType | "";
  tag?: string;
  status?: CredentialStatus | "";
};

/** Type-specific secret fields sent once on create/rotate — never retained. */
export type CredentialSecretDraft = Record<string, string>;

export type CreateCredentialBody = {
  type: CredentialType;
  displayName: string;
  tags?: string[];
  metadata?: Record<string, string>;
  expiresAt?: string;
  secret: CredentialSecretDraft;
};

export type UpdateCredentialBody = {
  displayName?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  expiresAt?: string | null;
};

export type RotateCredentialBody = {
  secret: CredentialSecretDraft;
};

export type DeleteCredentialBody = {
  confirm: true;
};

export type CredentialTestResult = {
  status: CredentialTestStatus;
  reason?: string;
  checkedAt?: string;
};

export type CredentialTestResponse = {
  result: CredentialTestResult;
  credential: CredentialRecord;
};

export type CredentialRef = {
  kind: CredentialRefKind;
  workflowId: string;
  workflowSlug?: string;
  workflowName: string;
  versionId?: string;
  versionNumber?: number;
  executionId?: string;
  executionStatus?: string;
};

export type CredentialUsage = {
  credentialId: string;
  lastUsedAt?: string;
  lastUsedBy?: string;
  useCount: number;
  drafts: CredentialRef[];
  versions: CredentialRef[];
  executions: CredentialRef[];
};

export type CredentialEvent = {
  id: string;
  credentialId: string;
  eventType: string;
  actorId?: string;
  details: Record<string, string>;
  occurredAt: string;
};

export type CredentialEventList = {
  items: CredentialEvent[];
};

export type CredentialDeletionImpact = {
  credentialId: string;
  displayName: string;
  status: CredentialStatus;
  canDelete: boolean;
  blockReason?: string;
  drafts: CredentialRef[];
  versions: CredentialRef[];
  activeExecutions: CredentialRef[];
};

export type WizardStep =
  | "identity"
  | "type"
  | "secret"
  | "metadata"
  | "review";

export const WIZARD_STEPS: readonly WizardStep[] = [
  "identity",
  "type",
  "secret",
  "metadata",
  "review",
];
