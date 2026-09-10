import type { SessionEmbedChrome } from "./session-embed-contract.ts";
import { emptyBrowserSession, type BrowserSession } from "./session.ts";

/**
 * In-memory browser session snapshot + CSRF token.
 * Never writes bearer tokens or session secrets to localStorage/URL.
 *
 * embedChrome is GET /session (or refresh) only — ADV-021. Exchange
 * cookies do not populate it.
 */

export type SessionSnapshot = {
  active: boolean;
  stale: boolean;
  session: BrowserSession;
  embedChrome: SessionEmbedChrome | null;
};

const EMPTY_SNAPSHOT: SessionSnapshot = {
  active: false,
  stale: false,
  session: emptyBrowserSession(),
  embedChrome: null,
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

export function setActiveSession(
  session: BrowserSession,
  embedChrome: SessionEmbedChrome | null = null,
): void {
  snapshot = {
    active: Boolean(session.subject),
    stale: false,
    session,
    embedChrome,
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
    embedChrome: null,
  };
  emit();
}

export function getSessionEmbedChrome(): SessionEmbedChrome | null {
  return snapshot.embedChrome;
}

export function clearSession(): void {
  snapshot = EMPTY_SNAPSHOT;
  emit();
}

export function getCsrfToken(): string {
  return snapshot.session.csrfToken;
}
