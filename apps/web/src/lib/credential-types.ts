/**
 * Safe credential vault types for Chloe's E4.1 UI (#35).
 *
 * Responses are metadata only. Plaintext secret fields are never part of
 * a persisted or displayed record. Unexpected secret keys are stripped
 * by `sanitizeCredentialRecord` and treated as a contract bug.
 *
 * TODO(#35): retarget field names when jonny publishes the vault route map.
 */

export const CREDENTIAL_MVP_TYPES = [
  "kubernetes_target",
  "ssh_private_key",
  "token",
  "webhook_secret",
] as const;

export type CredentialType = (typeof CREDENTIAL_MVP_TYPES)[number];

export const CREDENTIAL_STATUSES = [
  "active",
  "disabled",
  "expired",
  "rotating",
] as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CREDENTIAL_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "failed",
  "untested",
] as const;

export type CredentialHealth = (typeof CREDENTIAL_HEALTH_STATES)[number];

export const CREDENTIAL_POLICY_STATES = [
  "allowed",
  "restricted",
  "pending_approval",
] as const;

export type CredentialPolicyState = (typeof CREDENTIAL_POLICY_STATES)[number];

export const CREDENTIAL_ACTIONS = [
  "view",
  "edit",
  "rotate",
  "disable",
  "enable",
  "test",
  "delete",
  "use",
] as const;

export type CredentialAction = (typeof CREDENTIAL_ACTIONS)[number];

export const CREDENTIAL_ALLOWED_USES = [
  "credential.use",
  "workflow.execute",
  "webhook.verify",
  "kubernetes.apply",
  "ssh.run",
] as const;

export type CredentialAllowedUse = (typeof CREDENTIAL_ALLOWED_USES)[number];

/** Safe target metadata — never kubeconfig, keys, tokens, or connection strings. */
export type CredentialTargetMetadata = {
  clusterName?: string;
  apiServerHost?: string;
  hostname?: string;
  port?: number;
  username?: string;
  hostKeyFingerprint?: string;
  issuerHint?: string;
  audienceHint?: string;
  destinationLabel?: string;
};

export type CredentialOwnership = {
  ownerDisplayName?: string;
  ownerId?: string;
};

export type CredentialRecord = {
  id: string;
  displayName: string;
  tags: string[];
  type: CredentialType;
  status: CredentialStatus;
  health: CredentialHealth;
  policyState: CredentialPolicyState;
  permittedActions: CredentialAction[];
  lastTestedAt?: string;
  lastTestStatus?: "passed" | "failed" | "untested";
  rotatedAt?: string;
  rotateAfter?: string;
  createdAt?: string;
  updatedAt?: string;
  ownerDisplayName?: string;
  allowedUse: CredentialAllowedUse[];
  targetMetadata: CredentialTargetMetadata;
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
export type CredentialSecretDraft = {
  kubeconfig?: string;
  token?: string;
  privateKey?: string;
  passphrase?: string;
  apiKey?: string;
  secret?: string;
};

export type CreateCredentialBody = {
  displayName: string;
  tags?: string[];
  type: CredentialType;
  secret: CredentialSecretDraft;
  targetMetadata?: CredentialTargetMetadata;
  ownership?: CredentialOwnership;
  allowedUse?: CredentialAllowedUse[];
  rotateAfter?: string;
  testOnCreate?: boolean;
};

export type UpdateCredentialBody = {
  displayName?: string;
  tags?: string[];
  targetMetadata?: CredentialTargetMetadata;
  ownership?: CredentialOwnership;
  allowedUse?: CredentialAllowedUse[];
  rotateAfter?: string | null;
};

export type RotateCredentialBody = {
  secret: CredentialSecretDraft;
  testOnRotate?: boolean;
};

export type CredentialTestResult = {
  status: "passed" | "failed" | "untested";
  testedAt?: string;
  message?: string;
};

export type CredentialUsageItem = {
  workflowId: string;
  workflowName: string;
  nodeId?: string;
  versionId?: string;
  kind: "draft" | "version";
};

export type CredentialPermissionGrant = {
  principalType: string;
  principalDisplayName: string;
  permission: string;
};

export type CredentialUsage = {
  permissions: CredentialPermissionGrant[];
  usages: CredentialUsageItem[];
};

export type CredentialAuditEvent = {
  id: string;
  eventType: string;
  actorDisplayName?: string;
  occurredAt: string;
  detailsRedacted?: Record<string, string>;
};

export type CredentialAuditList = {
  items: CredentialAuditEvent[];
};

export type DeletionImpactDraft = {
  workflowId: string;
  name: string;
  slug?: string;
};

export type DeletionImpactVersion = {
  workflowId: string;
  versionId: string;
  versionNumber?: number;
  name: string;
};

export type DeletionImpactExecution = {
  executionId: string;
  workflowName: string;
  status: string;
};

export type CredentialDeletionImpact = {
  credentialId: string;
  displayName: string;
  canDelete: boolean;
  blockingReason?: string;
  affectedDrafts: DeletionImpactDraft[];
  affectedVersions: DeletionImpactVersion[];
  activeExecutions: DeletionImpactExecution[];
};

export type WizardStep =
  | "identity"
  | "type"
  | "secret"
  | "target"
  | "policy"
  | "review";

export const WIZARD_STEPS: readonly WizardStep[] = [
  "identity",
  "type",
  "secret",
  "target",
  "policy",
  "review",
];
