/**
 * Persist and apply FlowForge-verified embed workspace lookup.
 * Values come from POST /embed/exchange `workspace` / `session.embed`
 * or GET /session — never from host query.
 *
 * Relates to #122 / Part of #120. Keep #122 open. Do not change apps/api.
 */

import { saveDevIdentity } from "./dev-identity.ts";
import {
  EMBED_AUDIENCE,
  EMBED_SDK,
  embedWorkspaceHeaders,
  type EmbedVerifiedContext,
} from "./embed-contract.ts";
import {
  FLOWFORGE_TENANT_ID_HEADER,
  FLOWFORGE_WORKBENCH_KEY_HEADER,
  type DevIdentity,
} from "./identity-headers.ts";
import {
  EMBED_VERIFIED_STORAGE_KEY,
  identityFromVerified,
  parseEmbedVerifiedWorkspace,
  shouldAttachEmbedTenancyHeaders,
  verifiedWorkspaceFromCurrent,
  verifiedWorkspaceFromExchange,
  verifiedWorkspaceFromSessionEmbed,
  type EmbedVerifiedWorkspace,
} from "./embed-tenancy-contract.ts";
import type { CurrentWorkspace } from "./identity-types.ts";

const EMPTY: EmbedVerifiedWorkspace | null = null;

let cachedRaw: string | null = null;
let cached: EmbedVerifiedWorkspace | null = EMPTY;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeEmbedVerified(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function loadEmbedVerified(): EmbedVerifiedWorkspace | null {
  if (typeof sessionStorage === "undefined") {
    return EMPTY;
  }
  try {
    const raw = sessionStorage.getItem(EMBED_VERIFIED_STORAGE_KEY);
    if (raw === cachedRaw) {
      return cached;
    }
    cachedRaw = raw;
    cached = raw ? parseEmbedVerifiedWorkspace(JSON.parse(raw)) : EMPTY;
    return cached;
  } catch {
    cachedRaw = null;
    cached = EMPTY;
    return EMPTY;
  }
}

export function emptyEmbedVerified(): EmbedVerifiedWorkspace | null {
  return EMPTY;
}

export function saveEmbedVerified(
  verified: EmbedVerifiedWorkspace | null,
): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  if (!verified) {
    sessionStorage.removeItem(EMBED_VERIFIED_STORAGE_KEY);
    cachedRaw = null;
    cached = EMPTY;
    emit();
    return;
  }
  sessionStorage.setItem(EMBED_VERIFIED_STORAGE_KEY, JSON.stringify(verified));
  cachedRaw = null;
  cached = verified;
  emit();
}

export function clearEmbedVerified(): void {
  saveEmbedVerified(null);
}

export function persistVerifiedFromExchange(
  context: EmbedVerifiedContext,
): EmbedVerifiedWorkspace | null {
  const verified = verifiedWorkspaceFromExchange(context);
  saveEmbedVerified(verified);
  return verified;
}

export function persistVerifiedFromWorkspace(
  current: CurrentWorkspace,
): EmbedVerifiedWorkspace | null {
  const verified = verifiedWorkspaceFromCurrent(current);
  if (verified) {
    saveEmbedVerified(verified);
  }
  return verified;
}

/** GET /session session.embed is the source of truth over host route state. */
export function persistVerifiedFromSession(
  session: unknown,
): EmbedVerifiedWorkspace | null {
  const verified = verifiedWorkspaceFromSessionEmbed(session);
  if (verified) {
    saveEmbedVerified(verified);
  }
  return verified;
}

/**
 * Overlay bound tenant + workbench onto later /api/v1 calls.
 * Overwrites host-supplied header values. Skips catalog/jwks/exchange.
 */
export function attachEmbedWorkspaceHeaders(
  headers: Record<string, string>,
  instance: string,
): Record<string, string> {
  if (!shouldAttachEmbedTenancyHeaders(instance)) {
    return headers;
  }
  const verified = loadEmbedVerified();
  if (!verified) {
    return headers;
  }
  const bound = embedWorkspaceHeaders({
    audience: EMBED_AUDIENCE,
    sdk: EMBED_SDK,
    tenantId: verified.tenantId,
    tenantSlug: verified.tenantSlug,
    workbenchKey: verified.workbenchKey,
    workspaceId: verified.workspaceId,
    workspaceName: verified.workspaceName,
    capabilities: verified.capabilities ?? [],
    tokenId: "",
  });
  if (!bound.tenantId || !bound.workbenchKey) {
    return headers;
  }
  return {
    ...headers,
    [FLOWFORGE_TENANT_ID_HEADER]: bound.tenantId,
    [FLOWFORGE_WORKBENCH_KEY_HEADER]: bound.workbenchKey,
  };
}

/** Force workspace lookup headers onto the FlowForge-verified pair. */
export function bindIdentityToVerified(
  identity: DevIdentity,
  verified: EmbedVerifiedWorkspace,
): DevIdentity {
  const next = identityFromVerified(identity, verified);
  saveDevIdentity(next);
  return next;
}
