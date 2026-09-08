import {
  emptyDevIdentity,
  type DevIdentity,
} from "./identity-headers.ts";

/** Tab-scoped bootstrap identity. E2.3 sessions replace this. Never secrets. */
export const DEV_IDENTITY_STORAGE_KEY = "flowforge.dev-identity.v1";

export function parseDevIdentity(value: unknown): DevIdentity {
  const base = emptyDevIdentity();
  if (!value || typeof value !== "object") {
    return base;
  }
  const raw = value as Record<string, unknown>;
  return {
    issuer: readString(raw.issuer),
    subject: readString(raw.subject),
    displayName: readString(raw.displayName),
    tenantId: readString(raw.tenantId),
    tenantSlug: readString(raw.tenantSlug),
    workbenchKey: readString(raw.workbenchKey),
  };
}

const EMPTY_IDENTITY = emptyDevIdentity();

let cachedRaw: string | null = null;
let cachedIdentity: DevIdentity = EMPTY_IDENTITY;

/** Stable snapshot for useSyncExternalStore. */
export function loadDevIdentity(): DevIdentity {
  if (typeof sessionStorage === "undefined") {
    return EMPTY_IDENTITY;
  }
  try {
    const raw = sessionStorage.getItem(DEV_IDENTITY_STORAGE_KEY);
    if (raw === cachedRaw) {
      return cachedIdentity;
    }
    cachedRaw = raw;
    cachedIdentity = raw ? parseDevIdentity(JSON.parse(raw)) : EMPTY_IDENTITY;
    return cachedIdentity;
  } catch {
    cachedRaw = null;
    cachedIdentity = EMPTY_IDENTITY;
    return EMPTY_IDENTITY;
  }
}

export function emptyStoredIdentity(): DevIdentity {
  return EMPTY_IDENTITY;
}

const listeners = new Set<() => void>();

function emitDevIdentity() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeDevIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function saveDevIdentity(identity: DevIdentity): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  sessionStorage.setItem(
    DEV_IDENTITY_STORAGE_KEY,
    JSON.stringify(parseDevIdentity(identity)),
  );
  emitDevIdentity();
}

export function clearDevIdentity(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  sessionStorage.removeItem(DEV_IDENTITY_STORAGE_KEY);
  emitDevIdentity();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
