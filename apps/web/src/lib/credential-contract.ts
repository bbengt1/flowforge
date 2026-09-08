/**
 * E4.1 credential vault contract adapter (Chloe UI).
 *
 * Jonny owns vault APIs + encryption/rotation (#35). This file is the
 * single retarget point when that route map lands. Paths, query keys,
 * and write-body shapes live here so screens and the typed client stay
 * stable.
 *
 * TODO(#35): confirm `/api/v1/credentials` vs `/api/v1/workspace/credentials`
 * once jonny publishes the vault route map. Isolation hook
 * `POST /workspace/credentials/{id}/use` is not the vault API.
 *
 * TODO(#35): confirm camelCase vs snake_case JSON. This adapter sends
 * camelCase to match E3.2 workflows; parsers accept both.
 */

import type {
  CreateCredentialBody,
  CredentialListQuery,
  CredentialSecretDraft,
  CredentialType,
  RotateCredentialBody,
  UpdateCredentialBody,
} from "./credential-types.ts";

export const CREDENTIALS_PATH = "/credentials";

export const CREDENTIAL_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
  deletionBlocked: "deletion-blocked",
} as const;

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
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

export function credentialUsagePath(credentialId: string): string {
  return `${credentialPath(credentialId)}/usage`;
}

export function credentialAuditPath(credentialId: string): string {
  return `${credentialPath(credentialId)}/audit`;
}

export function credentialDeletionImpactPath(credentialId: string): string {
  return `${credentialPath(credentialId)}/deletion-impact`;
}

/**
 * List/search query. Only safe metadata filters — never secret values.
 * TODO(#35): retarget query param names if the API uses `query` / `tags`.
 */
export function credentialListSearch(query: CredentialListQuery = {}): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) {
    params.set("q", q);
  }
  const type = query.type?.trim();
  if (type) {
    params.set("type", type);
  }
  const tag = query.tag?.trim();
  if (tag) {
    params.set("tag", tag);
  }
  const status = query.status?.trim();
  if (status) {
    params.set("status", status);
  }
  const encoded = params.toString();
  return encoded ? `${CREDENTIALS_PATH}?${encoded}` : CREDENTIALS_PATH;
}

/** Secret keys the UI may send once on create/rotate. Never query/path. */
export const SECRET_DRAFT_KEYS = [
  "kubeconfig",
  "token",
  "privateKey",
  "passphrase",
  "apiKey",
  "secret",
] as const;

export function emptySecretDraft(): CredentialSecretDraft {
  return {
    kubeconfig: "",
    token: "",
    privateKey: "",
    passphrase: "",
    apiKey: "",
    secret: "",
  };
}

export function secretFieldsForType(type: CredentialType): readonly string[] {
  switch (type) {
    case "kubernetes_target":
      return ["kubeconfig", "token"];
    case "ssh_private_key":
      return ["privateKey", "passphrase"];
    case "token":
      return ["token", "apiKey"];
    case "webhook_secret":
      return ["secret"];
    default:
      return [];
  }
}

export function buildCreateCredentialBody(
  input: CreateCredentialBody,
): CreateCredentialBody {
  return {
    displayName: input.displayName.trim(),
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    type: input.type,
    secret: pickSecretDraft(input.type, input.secret),
    targetMetadata: input.targetMetadata ?? {},
    ownership: input.ownership,
    allowedUse: input.allowedUse ?? [],
    rotateAfter: input.rotateAfter?.trim() || undefined,
    testOnCreate: Boolean(input.testOnCreate),
  };
}

export function buildRotateCredentialBody(
  type: CredentialType,
  secret: CredentialSecretDraft,
  testOnRotate = false,
): RotateCredentialBody {
  return {
    secret: pickSecretDraft(type, secret),
    testOnRotate,
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
    body.tags = input.tags.map((tag) => tag.trim()).filter(Boolean);
  }
  if (input.targetMetadata) {
    body.targetMetadata = input.targetMetadata;
  }
  if (input.ownership) {
    body.ownership = input.ownership;
  }
  if (input.allowedUse) {
    body.allowedUse = input.allowedUse;
  }
  if (input.rotateAfter === null) {
    body.rotateAfter = null;
  } else if (typeof input.rotateAfter === "string") {
    body.rotateAfter = input.rotateAfter.trim() || null;
  }
  return body;
}

function pickSecretDraft(
  type: CredentialType,
  secret: CredentialSecretDraft,
): CredentialSecretDraft {
  const allowed = new Set(secretFieldsForType(type));
  const out: CredentialSecretDraft = {};
  for (const key of SECRET_DRAFT_KEYS) {
    if (!allowed.has(key)) {
      continue;
    }
    const value = secret[key]?.trim();
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

/** Overwrite secret strings so UI memory cannot retain plaintext after submit. */
export function forgetSecretDraft(
  draft: CredentialSecretDraft,
): CredentialSecretDraft {
  for (const key of SECRET_DRAFT_KEYS) {
    if (key in draft) {
      draft[key] = "";
    }
  }
  return emptySecretDraft();
}
