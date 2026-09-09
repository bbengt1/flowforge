/**
 * Persist and apply FlowForge-verified embed workspace lookup.
 * Values come from POST /embed/exchange or GET /workspace — never from
 * host query, hash, or postMessage identity fields.
 *
 * Relates to #122 / Part of #120. Keep #122 open. Do not change apps/api.
 */

import { saveDevIdentity } from "./dev-identity.ts";
import type { DevIdentity } from "./identity-headers.ts";
import type { EmbedVerifiedContext } from "./embed-contract.ts";
import {
  EMBED_VERIFIED_STORAGE_KEY,
  identityFromVerified,
  parseEmbedVerifiedWorkspace,
  verifiedWorkspaceFromCurrent,
  verifiedWorkspaceFromExchange,
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

/** Force workspace lookup headers onto the FlowForge-verified pair. */
export function bindIdentityToVerified(
  identity: DevIdentity,
  verified: EmbedVerifiedWorkspace,
): DevIdentity {
  const next = identityFromVerified(identity, verified);
  saveDevIdentity(next);
  return next;
}
