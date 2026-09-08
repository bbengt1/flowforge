import {
  emptyDevIdentity,
  type DevIdentity,
} from "./identity-headers";

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

export function loadDevIdentity(): DevIdentity {
  if (typeof sessionStorage === "undefined") {
    return emptyDevIdentity();
  }
  try {
    const raw = sessionStorage.getItem(DEV_IDENTITY_STORAGE_KEY);
    if (!raw) {
      return emptyDevIdentity();
    }
    return parseDevIdentity(JSON.parse(raw));
  } catch {
    return emptyDevIdentity();
  }
}

export function saveDevIdentity(identity: DevIdentity): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  sessionStorage.setItem(
    DEV_IDENTITY_STORAGE_KEY,
    JSON.stringify(parseDevIdentity(identity)),
  );
}

export function clearDevIdentity(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  sessionStorage.removeItem(DEV_IDENTITY_STORAGE_KEY);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
