/**
 * Temporary local-dev header identity flag.
 * Dual-gate: cookie session is preferred. This only opts into sending
 * X-FlowForge-Issuer/Subject until jonny's session API is the sole path.
 * The flag is not a secret and stores no bearer tokens.
 */

export const HEADER_FALLBACK_STORAGE_KEY = "flowforge.header-identity-fallback.v1";

let cachedEnabled = false;
let cachedKnown = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function loadHeaderFallback(): boolean {
  if (typeof sessionStorage === "undefined") {
    return false;
  }
  try {
    const raw = sessionStorage.getItem(HEADER_FALLBACK_STORAGE_KEY) === "1";
    cachedEnabled = raw;
    cachedKnown = true;
    return cachedEnabled;
  } catch {
    cachedEnabled = false;
    cachedKnown = true;
    return false;
  }
}

export function headerFallbackEnabled(): boolean {
  if (cachedKnown) {
    return cachedEnabled;
  }
  return loadHeaderFallback();
}

export function subscribeHeaderFallback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setHeaderFallback(enabled: boolean): void {
  cachedEnabled = enabled;
  cachedKnown = true;
  if (typeof sessionStorage !== "undefined") {
    if (enabled) {
      sessionStorage.setItem(HEADER_FALLBACK_STORAGE_KEY, "1");
    } else {
      sessionStorage.removeItem(HEADER_FALLBACK_STORAGE_KEY);
    }
  }
  emit();
}
