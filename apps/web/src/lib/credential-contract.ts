/**
 * E4.1 credential vault contract (Chloe UI) stacked on jonny's #38.
 *
 * Paths and write bodies match `docs/reference/backend-api-map.md` E4.1
 * and `apps/api/internal/httpapi/vault.go`. Isolation hook
 * `POST /workspace/credentials/{id}/use` is not the product vault.
 *
 * KEK (`CREDENTIAL_KEK`) is server-only — this adapter never reads or
 * sends it.
 */

import type {
  CreateCredentialBody,
  CredentialCatalog,
  CredentialSecretDraft,
  CredentialType,
  CredentialTypeInfo,
  DeleteCredentialBody,
  RotateCredentialBody,
  UpdateCredentialBody,
} from "./credential-types.ts";
import { CREDENTIAL_MVP_TYPES } from "./credential-types.ts";

export const CREDENTIALS_PATH = "/credentials";
export const CREDENTIALS_CATALOG_PATH = "/credentials/catalog";

export const CREDENTIAL_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
  dependencyUnavailable: "dependency-unavailable",
} as const;

/** Published #38 catalog (field names only). Used when GET catalog is unavailable. */
export const FALLBACK_CREDENTIAL_CATALOG: CredentialCatalog = {
  types: [
    {
      type: "kubernetes",
      displayName: "Kubernetes kubeconfig",
      secretFields: [{ name: "kubeconfig", input: "textarea", required: true }],
      metadataFields: [{ name: "contextName", input: "text", required: false }],
    },
    {
      type: "ssh_private_key",
      displayName: "SSH private key",
      secretFields: [
        { name: "privateKey", input: "textarea", required: true },
        { name: "passphrase", input: "password", required: false },
      ],
      metadataFields: [{ name: "keyType", input: "text", required: false }],
    },
    {
      type: "token",
      displayName: "Token / API key",
      secretFields: [{ name: "token", input: "password", required: true }],
      metadataFields: [{ name: "tokenKind", input: "text", required: false }],
    },
    {
      type: "webhook_secret",
      displayName: "Webhook secret",
      secretFields: [{ name: "secret", input: "password", required: true }],
      metadataFields: [],
    },
    {
      type: "provider",
      displayName: "Provider connector",
      secretFields: [{ name: "token", input: "password", required: true }],
      metadataFields: [{ name: "provider", input: "text", required: false }],
    },
  ],
};

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function credentialsCatalogPath(): string {
  return CREDENTIALS_CATALOG_PATH;
}

export function credentialPath(credentialId: string): string {
  return `${CREDENTIALS_PATH}/${credentialId}`;
}

export function credentialRotatePath(credentialId: string): string {
  return `${credentialPath(credentialId)}/rotate`;
}

export function credentialDisablePath(credentialId: string): string {
  return `${credentialPath(credentialId)}/disable`;
}

export function credentialEnablePath(credentialId: string): string {
  return `${credentialPath(credentialId)}/enable`;
}

export function credentialTestPath(credentialId: string): string {
  return `${credentialPath(credentialId)}/test`;
}

export function credentialUsePath(credentialId: string): string {
  return `${credentialPath(credentialId)}/use`;
}

export function credentialUsagePath(credentialId: string): string {
  return `${credentialPath(credentialId)}/usage`;
}

export function credentialEventsPath(credentialId: string): string {
  return `${credentialPath(credentialId)}/events`;
}

export function credentialDeletionImpactPath(credentialId: string): string {
  return `${credentialPath(credentialId)}/deletion-impact`;
}

/** List is unfiltered `{items}`. Search is client-side on metadata only. */
export function credentialListPath(): string {
  return CREDENTIALS_PATH;
}

/** Secret keys the UI may send once on create/rotate. Never query/path. */
export const SECRET_DRAFT_KEYS = [
  "kubeconfig",
  "privateKey",
  "passphrase",
  "token",
  "secret",
] as const;

export function emptySecretDraft(): CredentialSecretDraft {
  return {
    kubeconfig: "",
    privateKey: "",
    passphrase: "",
    token: "",
    secret: "",
  };
}

export function catalogTypeInfo(
  catalog: CredentialCatalog,
  type: CredentialType,
): CredentialTypeInfo | undefined {
  return catalog.types.find((item) => item.type === type);
}

export function secretFieldsForType(
  type: CredentialType,
  catalog: CredentialCatalog = FALLBACK_CREDENTIAL_CATALOG,
): readonly string[] {
  return (
    catalogTypeInfo(catalog, type)?.secretFields.map((field) => field.name) ?? []
  );
}

export function metadataFieldsForType(
  type: CredentialType,
  catalog: CredentialCatalog = FALLBACK_CREDENTIAL_CATALOG,
): readonly string[] {
  return (
    catalogTypeInfo(catalog, type)?.metadataFields.map((field) => field.name) ??
    []
  );
}

export function buildCreateCredentialBody(
  input: CreateCredentialBody,
  catalog: CredentialCatalog = FALLBACK_CREDENTIAL_CATALOG,
): CreateCredentialBody {
  const expiresAt = input.expiresAt?.trim();
  return {
    type: input.type,
    displayName: input.displayName.trim(),
    tags: sanitizeTagDraft(input.tags),
    metadata: pickMetadataDraft(input.type, input.metadata ?? {}, catalog),
    ...(expiresAt ? { expiresAt } : {}),
    secret: pickSecretDraft(input.type, input.secret, catalog),
  };
}

export function buildRotateCredentialBody(
  type: CredentialType,
  secret: CredentialSecretDraft,
  catalog: CredentialCatalog = FALLBACK_CREDENTIAL_CATALOG,
): RotateCredentialBody {
  return {
    secret: pickSecretDraft(type, secret, catalog),
  };
}

export function buildUpdateCredentialBody(
  input: UpdateCredentialBody,
): UpdateCredentialBody {
  const body: UpdateCredentialBody = {};
  if (typeof input.displayName === "string") {
    body.displayName = input.displayName.trim();
  }
  if (input.tags) {
    body.tags = sanitizeTagDraft(input.tags);
  }
  if (input.metadata) {
    body.metadata = pickSafeMetadata(input.metadata);
  }
  if (input.expiresAt === null) {
    body.expiresAt = null;
  } else if (typeof input.expiresAt === "string") {
    const expiresAt = input.expiresAt.trim();
    if (expiresAt) {
      body.expiresAt = expiresAt;
    }
  }
  return body;
}

export function buildDeleteCredentialBody(): DeleteCredentialBody {
  return { confirm: true };
}

function sanitizeTagDraft(tags: string[] | undefined): string[] {
  return (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => /^[a-z0-9-]{1,40}$/.test(tag));
}

function pickSecretDraft(
  type: CredentialType,
  secret: CredentialSecretDraft,
  catalog: CredentialCatalog,
): CredentialSecretDraft {
  const allowed = new Set(secretFieldsForType(type, catalog));
  const out: CredentialSecretDraft = {};
  for (const [key, raw] of Object.entries(secret)) {
    if (!allowed.has(key)) {
      continue;
    }
    const value = raw.trim();
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

function pickMetadataDraft(
  type: CredentialType,
  metadata: Record<string, string>,
  catalog: CredentialCatalog,
): Record<string, string> {
  const allowed = new Set(metadataFieldsForType(type, catalog));
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(metadata)) {
    if (!allowed.has(key)) {
      continue;
    }
    const value = raw.trim();
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

function pickSafeMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(metadata)) {
    const name = key.trim();
    const value = raw.trim();
    if (!name || !value) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Overwrite secret strings so UI memory cannot retain plaintext after submit. */
export function forgetSecretDraft(
  draft: CredentialSecretDraft,
): CredentialSecretDraft {
  for (const key of Object.keys(draft)) {
    draft[key] = "";
  }
  for (const key of SECRET_DRAFT_KEYS) {
    draft[key] = "";
  }
  return emptySecretDraft();
}

export function isKnownCredentialType(value: string): value is CredentialType {
  return (CREDENTIAL_MVP_TYPES as readonly string[]).includes(value);
}
