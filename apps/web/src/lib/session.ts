import type { ProblemDetails } from "./problem.ts";
import { SESSION_PROBLEM_CODES } from "./session-contract.ts";

export const SESSION_WARNING_MS = 5 * 60 * 1000;

export type BrowserSession = {
  issuer: string;
  subject: string;
  displayName: string;
  sessionId: string;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string | null;
  csrfToken: string;
};

export type SessionExpiryState = "ok" | "warning" | "expired" | "unknown";

export function emptyBrowserSession(): BrowserSession {
  return {
    issuer: "",
    subject: "",
    displayName: "",
    sessionId: "",
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    csrfToken: "",
  };
}

export function parseBrowserSession(value: unknown): BrowserSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const principal = isRecord(value.principal) ? value.principal : value;
  const session = isRecord(value.session) ? value.session : value;
  const subject = readString(principal.external_subject ?? principal.subject);
  if (!subject) {
    return null;
  }
  return {
    issuer: readString(principal.issuer),
    subject,
    displayName: readString(principal.display_name ?? principal.displayName),
    sessionId: readString(session.id),
    idleExpiresAt: readTime(session.idle_expires_at ?? session.idleExpiresAt),
    absoluteExpiresAt: readTime(
      session.absolute_expires_at ?? session.absoluteExpiresAt,
    ),
    csrfToken: readString(value.csrf_token ?? value.csrfToken),
  };
}

/** Countdown uses the sooner of idle (30m) and absolute (12h) expiry. */
export function effectiveExpiresAt(session: {
  idleExpiresAt: string | null;
  absoluteExpiresAt: string | null;
}): string | null {
  const idle = remainingSessionMs(session.idleExpiresAt);
  const absolute = remainingSessionMs(session.absoluteExpiresAt);
  if (idle === null && absolute === null) {
    return null;
  }
  if (idle === null) {
    return session.absoluteExpiresAt;
  }
  if (absolute === null) {
    return session.idleExpiresAt;
  }
  return idle <= absolute ? session.idleExpiresAt : session.absoluteExpiresAt;
}

export function remainingSessionMs(
  expiresAt: string | null,
  now = Date.now(),
): number | null {
  if (!expiresAt) {
    return null;
  }
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed - now;
}

export function sessionExpiryState(
  expiresAt: string | null,
  now = Date.now(),
): SessionExpiryState {
  const remaining = remainingSessionMs(expiresAt, now);
  if (remaining === null) {
    return "unknown";
  }
  if (remaining <= 0) {
    return "expired";
  }
  if (remaining <= SESSION_WARNING_MS) {
    return "warning";
  }
  return "ok";
}

export type SessionChromeSnapshot = {
  active: boolean;
  stale: boolean;
  session: BrowserSession;
};

export type SessionExpiryBannerState =
  | { visible: false }
  | {
      visible: true;
      title: "Stale session" | "Session expired" | "Session expiring soon";
      role: "alert" | "status";
      kind: "stale" | "expired" | "warning";
    };

/**
 * Existing SessionExpiryBanner copy. 401 latch → stale chrome.
 * Do not invent a second expired/revoked surface.
 */
export function sessionExpiryBannerState(
  snapshot: SessionChromeSnapshot,
  now = Date.now(),
): SessionExpiryBannerState {
  if (snapshot.stale) {
    return {
      visible: true,
      title: "Stale session",
      role: "alert",
      kind: "stale",
    };
  }
  if (!snapshot.active) {
    return { visible: false };
  }
  const expiresAt = effectiveExpiresAt(snapshot.session);
  const state = sessionExpiryState(expiresAt, now);
  if (state === "expired") {
    return {
      visible: true,
      title: "Session expired",
      role: "status",
      kind: "expired",
    };
  }
  if (state === "warning") {
    return {
      visible: true,
      title: "Session expiring soon",
      role: "status",
      kind: "warning",
    };
  }
  return { visible: false };
}

/** Existing SessionStatusChip label. */
export function sessionStatusChipLabel(
  snapshot: SessionChromeSnapshot,
  now = Date.now(),
): string {
  if (snapshot.stale) {
    return "Session stale";
  }
  if (!snapshot.active) {
    return "No session";
  }
  const expiresAt = effectiveExpiresAt(snapshot.session);
  return `${snapshot.session.subject} · ${formatSessionCountdown(expiresAt, now)}`;
}

export function formatSessionCountdown(
  expiresAt: string | null,
  now = Date.now(),
): string {
  const remaining = remainingSessionMs(expiresAt, now);
  if (remaining === null) {
    return "Expiry unknown";
  }
  if (remaining <= 0) {
    return "Session expired";
  }
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `Expires in ${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `Expires in ${minutes}m ${seconds}s`;
  }
  return `Expires in ${seconds}s`;
}

export function isUnauthenticatedProblem(problem: ProblemDetails): boolean {
  return (
    problem.status === 401 &&
    (problem.code === SESSION_PROBLEM_CODES.unauthenticated ||
      problem.code === SESSION_PROBLEM_CODES.staleSession)
  );
}

export function isStaleSessionProblem(problem: ProblemDetails): boolean {
  if (problem.code === SESSION_PROBLEM_CODES.staleSession) {
    return true;
  }
  return (
    problem.status === 401 &&
    problem.code === SESSION_PROBLEM_CODES.unauthenticated
  );
}

export function isCsrfProblem(problem: ProblemDetails): boolean {
  if (
    problem.code === SESSION_PROBLEM_CODES.csrfRequired ||
    problem.code === SESSION_PROBLEM_CODES.csrfInvalid
  ) {
    return true;
  }
  if (problem.status !== 403) {
    return false;
  }
  const haystack = `${problem.title} ${problem.detail} ${problem.code}`.toLowerCase();
  return haystack.includes("csrf");
}

export function csrfRequiredProblem(
  instance: string,
  requestId: string,
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:csrf-required",
    title: "CSRF Token Required",
    status: 403,
    detail:
      "A CSRF token is required for this state-changing request. The request was not sent.",
    instance,
    code: SESSION_PROBLEM_CODES.csrfRequired,
    request_id: requestId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTime(value: unknown): string | null {
  const text = readString(value);
  return text || null;
}
