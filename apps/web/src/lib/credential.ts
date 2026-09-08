/**
 * Secret-free credential helpers. Plaintext is accepted only as a
 * one-shot create/rotate draft and is discarded after submit.
 *
 * Unexpected secret-bearing keys on API responses are treated as a
 * contract bug: strip/ignore, never display or retain.
 */

import { forgetSecretDraft } from "./credential-contract.ts";
import type {
  CredentialAction,
  CredentialAllowedUse,
  CredentialAuditEvent,
  CredentialDeletionImpact,
  CredentialHealth,
  CredentialListQuery,
  CredentialPermissionGrant,
  CredentialPolicyState,
  CredentialRecord,
  CredentialSecretDraft,
  CredentialStatus,
  CredentialTargetMetadata,
  CredentialType,
  CredentialUsage,
  CredentialUsageItem,
  DeletionImpactDraft,
  DeletionImpactExecution,
  DeletionImpactVersion,
} from "./credential-types.ts";
import {
  CREDENTIAL_ACTIONS,
  CREDENTIAL_ALLOWED_USES,
  CREDENTIAL_HEALTH_STATES,
  CREDENTIAL_MVP_TYPES,
  CREDENTIAL_POLICY_STATES,
  CREDENTIAL_STATUSES,
} from "./credential-types.ts";

const SECRET_KEY_ALIASES = new Set([
  "authorization",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "bearer",
  "ciphertext",
  "client_secret",
  "clientsecret",
  "connection_string",
  "connectionstring",
  "cookie",
  "database_url",
  "dek_envelope",
  "dekenvelope",
  "dsn",
  "kubeconfig",
  "password",
  "passwd",
  "passphrase",
  "plaintext",
  "private_key",
  "privatekey",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secrets",
  "set_cookie",
  "token",
  "webhook_secret",
  "webhooksecret",
]);

const SECRET_KEY_PARTS = [
  "password",
  "secret",
  "token",
  "authorization",
  "credential",
  "api_key",
  "private_key",
  "kubeconfig",
  "passphrase",
  "ciphertext",
];

const SAFE_RECORD_KEYS = new Set([
  "id",
  "displayName",
  "display_name",
  "tags",
  "type",
  "status",
  "health",
  "policyState",
  "policy_state",
  "permittedActions",
  "permitted_actions",
  "lastTestedAt",
  "last_tested_at",
  "lastTestStatus",
  "last_test_status",
  "rotatedAt",
  "rotated_at",
  "rotateAfter",
  "rotate_after",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "ownerDisplayName",
  "owner_display_name",
  "allowedUse",
  "allowed_use",
  "targetMetadata",
  "target_metadata",
]);

const SAFE_TARGET_KEYS = new Set([
  "clusterName",
  "cluster_name",
  "apiServerHost",
  "api_server_host",
  "hostname",
  "port",
  "username",
  "hostKeyFingerprint",
  "host_key_fingerprint",
  "issuerHint",
  "issuer_hint",
  "audienceHint",
  "audience_hint",
  "destinationLabel",
  "destination_label",
]);

/** Metadata keys that contain "credential" but are not secret material. */
const NEVER_STRIP_KEYS = new Set([
  "id",
  "credentialid",
  "credential_id",
  "displayname",
  "display_name",
  "ownerdisplayname",
  "owner_display_name",
  "actordisplayname",
  "actor_display_name",
  "principaldisplayname",
  "principal_display_name",
  "workflowid",
  "workflow_id",
  "workflowname",
  "workflow_name",
  "versionid",
  "version_id",
  "executionid",
  "execution_id",
  "eventtype",
  "event_type",
  "occurredat",
  "occurred_at",
  "detailsredacted",
  "details_redacted",
  "candelete",
  "can_delete",
  "blockingreason",
  "blocking_reason",
  "affecteddrafts",
  "affected_drafts",
  "affectedversions",
  "affected_versions",
  "activeexecutions",
  "active_executions",
  "permittedactions",
  "permitted_actions",
  "policystate",
  "policy_state",
  "lasttestedat",
  "last_tested_at",
  "lastteststatus",
  "last_test_status",
  "rotatedat",
  "rotated_at",
  "rotateafter",
  "rotate_after",
  "alloweduse",
  "allowed_use",
  "targetmetadata",
  "target_metadata",
  "testoncreate",
  "test_on_create",
  "testonrotate",
  "test_on_rotate",
  "items",
  "tags",
  "type",
  "status",
  "health",
  "permissions",
  "usages",
  "kind",
  "name",
  "slug",
  "message",
  "testedat",
  "tested_at",
]);

export type Sanitized<T> = {
  value: T;
  strippedKeys: string[];
};

export function normalizeSecretKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

export function isSecretFieldName(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  const compact = normalized.replace(/_/g, "");
  if (NEVER_STRIP_KEYS.has(normalized) || NEVER_STRIP_KEYS.has(compact)) {
    return false;
  }
  if (SECRET_KEY_ALIASES.has(compact) || SECRET_KEY_ALIASES.has(normalized)) {
    return true;
  }
  for (const part of SECRET_KEY_PARTS) {
    if (
      normalized === part ||
      normalized.endsWith(`_${part}`) ||
      normalized.startsWith(`${part}_`) ||
      normalized.includes(`_${part}_`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively drop secret-bearing keys. Used on every inbound vault
 * payload so unexpected plaintext cannot reach React state or storage.
 */
export function stripSecretFields(value: unknown, path = ""): Sanitized<unknown> {
  const strippedKeys: string[] = [];
  const cleaned = stripInner(value, path, strippedKeys);
  return { value: cleaned, strippedKeys };
}

function stripInner(
  value: unknown,
  path: string,
  strippedKeys: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      stripInner(item, path ? `${path}[${index}]` : `[${index}]`, strippedKeys),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSecretFieldName(key)) {
      strippedKeys.push(childPath);
      continue;
    }
    out[key] = stripInner(child, childPath, strippedKeys);
  }
  return out;
}

export function sanitizeCredentialRecord(
  value: unknown,
): Sanitized<CredentialRecord | null> {
  const stripped = stripSecretFields(value);
  if (!isPlainObject(stripped.value)) {
    return { value: null, strippedKeys: stripped.strippedKeys };
  }
  const raw = stripped.value;
  const id = readString(raw.id);
  const displayName = readString(raw.displayName, raw.display_name);
  const type = readEnum(raw.type, CREDENTIAL_MVP_TYPES);
  if (!id || !displayName || !type) {
    return { value: null, strippedKeys: stripped.strippedKeys };
  }
  const record: CredentialRecord = {
    id,
    displayName,
    tags: readStringList(raw.tags),
    type,
    status: readEnum(raw.status, CREDENTIAL_STATUSES) ?? "active",
    health: readEnum(raw.health, CREDENTIAL_HEALTH_STATES) ?? "unknown",
    policyState:
      readEnum(raw.policyState, CREDENTIAL_POLICY_STATES) ??
      readEnum(raw.policy_state, CREDENTIAL_POLICY_STATES) ??
      "allowed",
    permittedActions: readActionList(
      raw.permittedActions ?? raw.permitted_actions,
    ),
    lastTestedAt: optionalString(raw.lastTestedAt, raw.last_tested_at),
    lastTestStatus: readTestStatus(raw.lastTestStatus ?? raw.last_test_status),
    rotatedAt: optionalString(raw.rotatedAt, raw.rotated_at),
    rotateAfter: optionalString(raw.rotateAfter, raw.rotate_after),
    createdAt: optionalString(raw.createdAt, raw.created_at),
    updatedAt: optionalString(raw.updatedAt, raw.updated_at),
    ownerDisplayName: optionalString(
      raw.ownerDisplayName,
      raw.owner_display_name,
    ),
    allowedUse: readAllowedUse(raw.allowedUse ?? raw.allowed_use),
    targetMetadata: readTargetMetadata(
      raw.targetMetadata ?? raw.target_metadata,
    ),
  };
  return { value: record, strippedKeys: stripped.strippedKeys };
}

export function sanitizeCredentialList(value: unknown): Sanitized<CredentialRecord[]> {
  const stripped = stripSecretFields(value);
  const items = isPlainObject(stripped.value)
    ? stripped.value.items
    : Array.isArray(stripped.value)
      ? stripped.value
      : [];
  const records: CredentialRecord[] = [];
  const extraKeys = [...stripped.strippedKeys];
  if (Array.isArray(items)) {
    for (const item of items) {
      const sanitized = sanitizeCredentialRecord(item);
      extraKeys.push(...sanitized.strippedKeys);
      if (sanitized.value) {
        records.push(sanitized.value);
      }
    }
  }
  return { value: records, strippedKeys: extraKeys };
}

export function sanitizeDeletionImpact(
  value: unknown,
): Sanitized<CredentialDeletionImpact | null> {
  const stripped = stripSecretFields(value);
  if (!isPlainObject(stripped.value)) {
    return { value: null, strippedKeys: stripped.strippedKeys };
  }
  const raw = stripped.value;
  const credentialId = readString(raw.credentialId, raw.credential_id);
  const displayName = readString(raw.displayName, raw.display_name);
  if (!credentialId || !displayName) {
    return { value: null, strippedKeys: stripped.strippedKeys };
  }
  const impact: CredentialDeletionImpact = {
    credentialId,
    displayName,
    canDelete: raw.canDelete !== false && raw.can_delete !== false,
    blockingReason: optionalString(raw.blockingReason, raw.blocking_reason),
    affectedDrafts: readDraftImpacts(raw.affectedDrafts ?? raw.affected_drafts),
    affectedVersions: readVersionImpacts(
      raw.affectedVersions ?? raw.affected_versions,
    ),
    activeExecutions: readExecutionImpacts(
      raw.activeExecutions ?? raw.active_executions,
    ),
  };
  if (impact.activeExecutions.length > 0) {
    impact.canDelete = false;
    impact.blockingReason =
      impact.blockingReason ||
      "Active executions still reference this credential.";
  }
  return { value: impact, strippedKeys: stripped.strippedKeys };
}

export function sanitizeUsage(value: unknown): Sanitized<CredentialUsage> {
  const stripped = stripSecretFields(value);
  const raw = isPlainObject(stripped.value) ? stripped.value : {};
  return {
    value: {
      permissions: readPermissions(raw.permissions),
      usages: readUsages(raw.usages),
    },
    strippedKeys: stripped.strippedKeys,
  };
}

export function sanitizeAuditEvents(
  value: unknown,
): Sanitized<CredentialAuditEvent[]> {
  const stripped = stripSecretFields(value);
  const items = isPlainObject(stripped.value)
    ? stripped.value.items
    : Array.isArray(stripped.value)
      ? stripped.value
      : [];
  const events: CredentialAuditEvent[] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isPlainObject(item)) {
        continue;
      }
      const id = readString(item.id);
      const eventType = readString(item.eventType, item.event_type);
      const occurredAt = readString(item.occurredAt, item.occurred_at);
      if (!id || !eventType || !occurredAt) {
        continue;
      }
      const details = item.detailsRedacted ?? item.details_redacted;
      events.push({
        id,
        eventType,
        actorDisplayName: optionalString(
          item.actorDisplayName,
          item.actor_display_name,
        ),
        occurredAt,
        detailsRedacted: readRedactedDetails(details),
      });
    }
  }
  return { value: events, strippedKeys: stripped.strippedKeys };
}

/** List/search matches display name and tags only — never secret material. */
export function matchesCredentialSearch(
  record: CredentialRecord,
  query: CredentialListQuery,
): boolean {
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const haystack = [record.displayName, ...record.tags]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) {
      return false;
    }
  }
  if (query.type && record.type !== query.type) {
    return false;
  }
  if (query.status && record.status !== query.status) {
    return false;
  }
  const tag = query.tag?.trim().toLowerCase();
  if (tag && !record.tags.some((item) => item.toLowerCase() === tag)) {
    return false;
  }
  return true;
}

export function filterCredentialList(
  items: CredentialRecord[],
  query: CredentialListQuery,
): CredentialRecord[] {
  return items.filter((item) => matchesCredentialSearch(item, query));
}

export type DeletionConfirmation = {
  canProceed: boolean;
  requiresAck: boolean;
  blockingReason?: string;
};

export function deletionConfirmationState(
  impact: CredentialDeletionImpact | null,
  typedName = "",
): DeletionConfirmation {
  if (!impact) {
    return {
      canProceed: false,
      requiresAck: true,
      blockingReason: "Load deletion impact before deleting.",
    };
  }
  if (!impact.canDelete) {
    return {
      canProceed: false,
      requiresAck: true,
      blockingReason:
        impact.blockingReason || "Deletion is blocked by the control plane.",
    };
  }
  const expected = impact.displayName.trim();
  const typed = typedName.trim();
  if (!expected || typed !== expected) {
    return {
      canProceed: false,
      requiresAck: true,
      blockingReason: "Type the credential display name to confirm deletion.",
    };
  }
  return { canProceed: true, requiresAck: false };
}

export function credentialTypeLabel(type: CredentialType): string {
  switch (type) {
    case "kubernetes_target":
      return "Kubernetes target credential";
    case "ssh_private_key":
      return "SSH private key";
    case "token":
      return "Token / API key";
    case "webhook_secret":
      return "Webhook secret";
    default:
      return type;
  }
}

export function credentialHealthLabel(health: CredentialHealth): string {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "failed":
      return "Failed";
    case "untested":
      return "Untested";
    default:
      return "Unknown";
  }
}

export function credentialPolicyLabel(state: CredentialPolicyState): string {
  switch (state) {
    case "restricted":
      return "Restricted";
    case "pending_approval":
      return "Approval required";
    default:
      return "Allowed";
  }
}

export function parseTagsInput(value: string): string[] {
  return value
    .split(/[,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function formatTagsInput(tags: string[]): string {
  return tags.join(", ");
}

/**
 * After a successful create/rotate/test, overwrite secret strings and
 * return a fresh empty draft. Callers must replace React state with the
 * return value — do not keep the previous object.
 */
export function clearSecretDraftAfterSubmit(
  draft: CredentialSecretDraft,
): CredentialSecretDraft {
  return forgetSecretDraft(draft);
}

/** Never write secret-bearing objects to Web Storage. */
export function assertSecretFreeStorageValue(value: unknown): string[] {
  return stripSecretFields(value).strippedKeys;
}

export function recordHasAction(
  record: CredentialRecord,
  action: CredentialAction,
): boolean {
  return record.permittedActions.includes(action);
}

export function isSafeRecordKey(key: string): boolean {
  return SAFE_RECORD_KEYS.has(key);
}

function readTargetMetadata(value: unknown): CredentialTargetMetadata {
  if (!isPlainObject(value)) {
    return {};
  }
  const meta: CredentialTargetMetadata = {};
  const clusterName = optionalString(value.clusterName, value.cluster_name);
  const apiServerHost = optionalString(
    value.apiServerHost,
    value.api_server_host,
  );
  const hostname = optionalString(value.hostname);
  const username = optionalString(value.username);
  const hostKeyFingerprint = optionalString(
    value.hostKeyFingerprint,
    value.host_key_fingerprint,
  );
  const issuerHint = optionalString(value.issuerHint, value.issuer_hint);
  const audienceHint = optionalString(value.audienceHint, value.audience_hint);
  const destinationLabel = optionalString(
    value.destinationLabel,
    value.destination_label,
  );
  const port = typeof value.port === "number" && Number.isFinite(value.port)
    ? value.port
    : undefined;
  if (clusterName) meta.clusterName = clusterName;
  if (apiServerHost) meta.apiServerHost = apiServerHost;
  if (hostname) meta.hostname = hostname;
  if (port !== undefined) meta.port = port;
  if (username) meta.username = username;
  if (hostKeyFingerprint) meta.hostKeyFingerprint = hostKeyFingerprint;
  if (issuerHint) meta.issuerHint = issuerHint;
  if (audienceHint) meta.audienceHint = audienceHint;
  if (destinationLabel) meta.destinationLabel = destinationLabel;
  for (const key of Object.keys(value)) {
    if (!SAFE_TARGET_KEYS.has(key) && isSecretFieldName(key)) {
      continue;
    }
  }
  return meta;
}

function readDraftImpacts(value: unknown): DeletionImpactDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: DeletionImpactDraft[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const workflowId = readString(item.workflowId, item.workflow_id);
    const name = readString(item.name);
    if (!workflowId || !name) {
      continue;
    }
    out.push({
      workflowId,
      name,
      slug: optionalString(item.slug),
    });
  }
  return out;
}

function readVersionImpacts(value: unknown): DeletionImpactVersion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: DeletionImpactVersion[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const workflowId = readString(item.workflowId, item.workflow_id);
    const versionId = readString(item.versionId, item.version_id);
    const name = readString(item.name);
    if (!workflowId || !versionId || !name) {
      continue;
    }
    const versionNumber =
      typeof item.versionNumber === "number"
        ? item.versionNumber
        : typeof item.version_number === "number"
          ? item.version_number
          : undefined;
    out.push({ workflowId, versionId, name, versionNumber });
  }
  return out;
}

function readExecutionImpacts(value: unknown): DeletionImpactExecution[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: DeletionImpactExecution[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const executionId = readString(item.executionId, item.execution_id);
    const workflowName = readString(item.workflowName, item.workflow_name);
    const status = readString(item.status);
    if (!executionId || !workflowName || !status) {
      continue;
    }
    out.push({ executionId, workflowName, status });
  }
  return out;
}

function readPermissions(value: unknown): CredentialPermissionGrant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CredentialPermissionGrant[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const principalType = readString(item.principalType, item.principal_type);
    const principalDisplayName = readString(
      item.principalDisplayName,
      item.principal_display_name,
    );
    const permission = readString(item.permission);
    if (!principalType || !principalDisplayName || !permission) {
      continue;
    }
    out.push({ principalType, principalDisplayName, permission });
  }
  return out;
}

function readUsages(value: unknown): CredentialUsageItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CredentialUsageItem[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const workflowId = readString(item.workflowId, item.workflow_id);
    const workflowName = readString(item.workflowName, item.workflow_name);
    const kind = item.kind === "version" ? "version" : "draft";
    if (!workflowId || !workflowName) {
      continue;
    }
    out.push({
      workflowId,
      workflowName,
      nodeId: optionalString(item.nodeId, item.node_id),
      versionId: optionalString(item.versionId, item.version_id),
      kind,
    });
  }
  return out;
}

function readRedactedDetails(
  value: unknown,
): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key) || typeof child !== "string") {
      continue;
    }
    out[key] = child;
  }
  return Object.keys(out).length ? out : undefined;
}

function readActionList(value: unknown): CredentialAction[] {
  if (!Array.isArray(value)) {
    return [...CREDENTIAL_ACTIONS];
  }
  const out: CredentialAction[] = [];
  for (const item of value) {
    const action = readEnum(item, CREDENTIAL_ACTIONS);
    if (action && !out.includes(action)) {
      out.push(action);
    }
  }
  return out;
}

function readAllowedUse(value: unknown): CredentialAllowedUse[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CredentialAllowedUse[] = [];
  for (const item of value) {
    const use = readEnum(item, CREDENTIAL_ALLOWED_USES);
    if (use && !out.includes(use)) {
      out.push(use);
    }
  }
  return out;
}

function readTestStatus(
  value: unknown,
): "passed" | "failed" | "untested" | undefined {
  if (value === "passed" || value === "failed" || value === "untested") {
    return value;
  }
  return undefined;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function optionalString(...values: unknown[]): string | undefined {
  const value = readString(...values);
  return value || undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isCredentialType(value: unknown): value is CredentialType {
  return readEnum(value, CREDENTIAL_MVP_TYPES) !== undefined;
}

export function isCredentialStatus(value: unknown): value is CredentialStatus {
  return readEnum(value, CREDENTIAL_STATUSES) !== undefined;
}
