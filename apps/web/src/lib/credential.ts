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
  CredentialCatalog,
  CredentialCatalogField,
  CredentialDeletionImpact,
  CredentialEvent,
  CredentialRecord,
  CredentialRef,
  CredentialSecretDraft,
  CredentialStatus,
  CredentialTestResult,
  CredentialType,
  CredentialTypeInfo,
  CredentialUsage,
  CatalogFieldInput,
} from "./credential-types.ts";
import {
  CREDENTIAL_ACTIONS,
  CREDENTIAL_MVP_TYPES,
  CREDENTIAL_REF_KINDS,
  CREDENTIAL_STATUSES,
  CREDENTIAL_TEST_STATUSES,
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

/** Metadata keys that contain "credential" / "token" but are not secret material. */
const NEVER_STRIP_KEYS = new Set([
  "id",
  "credential",
  "credentialid",
  "credential_id",
  "displayname",
  "display_name",
  "workflowid",
  "workflow_id",
  "workflowslug",
  "workflow_slug",
  "workflowname",
  "workflow_name",
  "versionid",
  "version_id",
  "versionnumber",
  "version_number",
  "executionid",
  "execution_id",
  "executionstatus",
  "execution_status",
  "eventtype",
  "event_type",
  "occurredat",
  "occurred_at",
  "actorid",
  "actor_id",
  "candelete",
  "can_delete",
  "blockreason",
  "block_reason",
  "permittedactions",
  "permitted_actions",
  "lasttestedat",
  "last_tested_at",
  "lastteststatus",
  "last_test_status",
  "lasttestreason",
  "last_test_reason",
  "lastusedat",
  "last_used_at",
  "lastusedby",
  "last_used_by",
  "usecount",
  "use_count",
  "rotatedat",
  "rotated_at",
  "expiresat",
  "expires_at",
  "disabledat",
  "disabled_at",
  "createdby",
  "created_by",
  "updatedby",
  "updated_by",
  "createdat",
  "created_at",
  "updatedat",
  "updated_at",
  "encryptionversion",
  "encryption_version",
  "keyreference",
  "key_reference",
  "fingerprint",
  "metadata",
  "activeexecutions",
  "active_executions",
  "items",
  "types",
  "type",
  "status",
  "tags",
  "kind",
  "name",
  "input",
  "required",
  "reason",
  "checkedat",
  "checked_at",
  "result",
  "details",
  "drafts",
  "versions",
  "executions",
  "secretfields",
  "secret_fields",
  "metadatafields",
  "metadata_fields",
  "contextname",
  "context_name",
  "keytype",
  "key_type",
  "tokenkind",
  "token_kind",
  "provider",
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
    type,
    displayName,
    status: readEnum(raw.status, CREDENTIAL_STATUSES) ?? "active",
    tags: readStringList(raw.tags),
    metadata: readStringMap(raw.metadata),
    fingerprint: readString(raw.fingerprint),
    encryptionVersion: readNumber(raw.encryptionVersion, raw.encryption_version),
    keyReference: readString(raw.keyReference, raw.key_reference),
    lastTestStatus:
      readEnum(raw.lastTestStatus, CREDENTIAL_TEST_STATUSES) ??
      readEnum(raw.last_test_status, CREDENTIAL_TEST_STATUSES) ??
      "untested",
    lastTestedAt: optionalString(raw.lastTestedAt, raw.last_tested_at),
    lastTestReason: optionalString(raw.lastTestReason, raw.last_test_reason),
    lastUsedAt: optionalString(raw.lastUsedAt, raw.last_used_at),
    lastUsedBy: optionalString(raw.lastUsedBy, raw.last_used_by),
    useCount: readNumber(raw.useCount, raw.use_count),
    rotatedAt: optionalString(raw.rotatedAt, raw.rotated_at),
    expiresAt: optionalString(raw.expiresAt, raw.expires_at),
    disabledAt: optionalString(raw.disabledAt, raw.disabled_at),
    createdBy: optionalString(raw.createdBy, raw.created_by),
    updatedBy: optionalString(raw.updatedBy, raw.updated_by),
    createdAt: optionalString(raw.createdAt, raw.created_at),
    updatedAt: optionalString(raw.updatedAt, raw.updated_at),
    permittedActions: readActionList(
      raw.permittedActions ?? raw.permitted_actions,
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

export function sanitizeCatalog(value: unknown): Sanitized<CredentialCatalog> {
  const stripped = stripSecretFields(value);
  const typesRaw = isPlainObject(stripped.value) ? stripped.value.types : [];
  const types: CredentialTypeInfo[] = [];
  if (Array.isArray(typesRaw)) {
    for (const item of typesRaw) {
      if (!isPlainObject(item)) {
        continue;
      }
      const type = readEnum(item.type, CREDENTIAL_MVP_TYPES);
      const displayName = readString(item.displayName, item.display_name);
      if (!type || !displayName) {
        continue;
      }
      types.push({
        type,
        displayName,
        secretFields: readCatalogFields(item.secretFields ?? item.secret_fields),
        metadataFields: readCatalogFields(
          item.metadataFields ?? item.metadata_fields,
        ),
      });
    }
  }
  return { value: { types }, strippedKeys: stripped.strippedKeys };
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
    status: readEnum(raw.status, CREDENTIAL_STATUSES) ?? "active",
    canDelete: raw.canDelete !== false && raw.can_delete !== false,
    blockReason: optionalString(raw.blockReason, raw.block_reason),
    drafts: readRefs(raw.drafts),
    versions: readRefs(raw.versions),
    activeExecutions: readRefs(raw.activeExecutions ?? raw.active_executions),
  };
  if (impact.activeExecutions.length > 0) {
    impact.canDelete = false;
    impact.blockReason =
      impact.blockReason ||
      "Active executions still reference this credential.";
  }
  return { value: impact, strippedKeys: stripped.strippedKeys };
}

export function sanitizeUsage(value: unknown): Sanitized<CredentialUsage | null> {
  const stripped = stripSecretFields(value);
  if (!isPlainObject(stripped.value)) {
    return { value: null, strippedKeys: stripped.strippedKeys };
  }
  const raw = stripped.value;
  const credentialId = readString(raw.credentialId, raw.credential_id);
  if (!credentialId) {
    return { value: null, strippedKeys: stripped.strippedKeys };
  }
  return {
    value: {
      credentialId,
      lastUsedAt: optionalString(raw.lastUsedAt, raw.last_used_at),
      lastUsedBy: optionalString(raw.lastUsedBy, raw.last_used_by),
      useCount: readNumber(raw.useCount, raw.use_count),
      drafts: readRefs(raw.drafts),
      versions: readRefs(raw.versions),
      executions: readRefs(raw.executions),
    },
    strippedKeys: stripped.strippedKeys,
  };
}

export function sanitizeEvents(value: unknown): Sanitized<CredentialEvent[]> {
  const stripped = stripSecretFields(value);
  const items = isPlainObject(stripped.value)
    ? stripped.value.items
    : Array.isArray(stripped.value)
      ? stripped.value
      : [];
  const events: CredentialEvent[] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isPlainObject(item)) {
        continue;
      }
      const id = readString(item.id);
      const credentialId = readString(item.credentialId, item.credential_id);
      const eventType = readString(item.eventType, item.event_type);
      const occurredAt = readString(item.occurredAt, item.occurred_at);
      if (!id || !credentialId || !eventType || !occurredAt) {
        continue;
      }
      events.push({
        id,
        credentialId,
        eventType,
        actorId: optionalString(item.actorId, item.actor_id),
        details: readStringMap(item.details),
        occurredAt,
      });
    }
  }
  return { value: events, strippedKeys: stripped.strippedKeys };
}

export function sanitizeTestResponse(value: unknown): Sanitized<{
  result: CredentialTestResult;
  credential: CredentialRecord | null;
}> {
  const stripped = stripSecretFields(value);
  const raw = isPlainObject(stripped.value) ? stripped.value : {};
  const resultRaw = isPlainObject(raw.result) ? raw.result : raw;
  const credential = sanitizeCredentialRecord(raw.credential);
  const status =
    readEnum(resultRaw.status, CREDENTIAL_TEST_STATUSES) ?? "untested";
  return {
    value: {
      result: {
        status,
        reason: optionalString(resultRaw.reason),
        checkedAt: optionalString(resultRaw.checkedAt, resultRaw.checked_at),
      },
      credential: credential.value,
    },
    strippedKeys: [...stripped.strippedKeys, ...credential.strippedKeys],
  };
}

/** List/search matches display name and tags only — never secret material. */
export function matchesCredentialSearch(
  record: CredentialRecord,
  query: {
    q?: string;
    type?: CredentialType | "";
    tag?: string;
    status?: CredentialStatus | "";
  },
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
  query: {
    q?: string;
    type?: CredentialType | "";
    tag?: string;
    status?: CredentialStatus | "";
  },
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
        impact.blockReason || "Deletion is blocked by the control plane.",
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

export function credentialTypeLabel(
  type: CredentialType,
  catalog?: CredentialCatalog,
): string {
  const fromCatalog = catalog?.types.find((item) => item.type === type);
  if (fromCatalog) {
    return fromCatalog.displayName;
  }
  switch (type) {
    case "kubernetes":
      return "Kubernetes kubeconfig";
    case "ssh_private_key":
      return "SSH private key";
    case "token":
      return "Token / API key";
    case "webhook_secret":
      return "Webhook secret";
    case "provider":
      return "Provider connector";
    default:
      return type;
  }
}

export function credentialStatusLabel(status: CredentialStatus): string {
  return status === "disabled" ? "Disabled" : "Active";
}

export function parseTagsInput(value: string): string[] {
  return value
    .split(/[,]+/)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => /^[a-z0-9-]{1,40}$/.test(tag));
}

export function formatTagsInput(tags: string[]): string {
  return tags.join(", ");
}

export function formatRef(ref: CredentialRef): string {
  const name = ref.workflowName || ref.workflowSlug || ref.workflowId;
  if (ref.kind === "version" && ref.versionNumber) {
    return `${name} v${ref.versionNumber}`;
  }
  if (ref.kind === "execution") {
    return `${name} · ${ref.executionStatus || ref.executionId || "execution"}`;
  }
  return ref.workflowSlug ? `${name} (${ref.workflowSlug})` : name;
}

/**
 * After a successful create/rotate, overwrite secret strings and
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

export function isCredentialType(value: unknown): value is CredentialType {
  return readEnum(value, CREDENTIAL_MVP_TYPES) !== undefined;
}

export function isCredentialStatus(value: unknown): value is CredentialStatus {
  return readEnum(value, CREDENTIAL_STATUSES) !== undefined;
}

function readCatalogFields(value: unknown): CredentialCatalogField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CredentialCatalogField[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const name = readString(item.name);
    if (!name) {
      continue;
    }
    const input = readCatalogInput(item.input);
    out.push({
      name,
      input,
      required: item.required === true,
    });
  }
  return out;
}

function readCatalogInput(value: unknown): CatalogFieldInput {
  if (value === "textarea" || value === "password" || value === "text") {
    return value;
  }
  return "text";
}

function readRefs(value: unknown): CredentialRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CredentialRef[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const workflowId = readString(item.workflowId, item.workflow_id);
    const workflowName = readString(item.workflowName, item.workflow_name);
    const kind = readEnum(item.kind, CREDENTIAL_REF_KINDS);
    if (!workflowId || !workflowName || !kind) {
      continue;
    }
    const versionNumber =
      typeof item.versionNumber === "number"
        ? item.versionNumber
        : typeof item.version_number === "number"
          ? item.version_number
          : undefined;
    out.push({
      kind,
      workflowId,
      workflowName,
      workflowSlug: optionalString(item.workflowSlug, item.workflow_slug),
      versionId: optionalString(item.versionId, item.version_id),
      versionNumber,
      executionId: optionalString(item.executionId, item.execution_id),
      executionStatus: optionalString(
        item.executionStatus,
        item.execution_status,
      ),
    });
  }
  return out;
}

function readActionList(value: unknown): CredentialAction[] {
  if (!Array.isArray(value)) {
    return [];
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

function readNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
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

function readStringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key) || typeof child !== "string") {
      continue;
    }
    const trimmed = child.trim();
    if (trimmed) {
      out[key] = trimmed;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
