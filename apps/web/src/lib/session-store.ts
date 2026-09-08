import { emptyBrowserSession, type BrowserSession } from "./session.ts";

/**
 * In-memory browser session snapshot + CSRF token.
 * Never writes bearer tokens or session secrets to localStorage/URL.
 */

export type SessionSnapshot = {
  active: boolean;
  stale: boolean;
  session: BrowserSession;
};

const EMPTY_SNAPSHOT: SessionSnapshot = {
  active: false,
  stale: false,
  session: emptyBrowserSession(),
};

let snapshot: SessionSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getSessionSnapshot(): SessionSnapshot {
  return snapshot;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function rememberCsrfToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed || snapshot.session.csrfToken === trimmed) {
    return;
  }
  snapshot = {
    ...snapshot,
    session: { ...snapshot.session, csrfToken: trimmed },
  };
  emit();
}

export function setActiveSession(session: BrowserSession): void {
  snapshot = {
    active: Boolean(session.subject),
    stale: false,
    session,
  };
  emit();
}

export function markSessionStale(): void {
  snapshot = {
    active: false,
    stale: true,
    session: {
      ...emptyBrowserSession(),
      issuer: snapshot.session.issuer,
      subject: snapshot.session.subject,
      displayName: snapshot.session.displayName,
    },
  };
  emit();
}

export function clearSession(): void {
  snapshot = EMPTY_SNAPSHOT;
  emit();
}

export function getCsrfToken(): string {
  return snapshot.session.csrfToken;
}
