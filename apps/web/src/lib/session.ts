import type { ProblemDetails } from "./problem.ts";
import {
  SESSION_PROBLEM_CODES,
  type SessionPayload,
} from "./session-contract.ts";

export const SESSION_WARNING_MS = 5 * 60 * 1000;

export type BrowserSession = {
  issuer: string;
  subject: string;
  displayName: string;
  expiresAt: string | null;
  csrfToken: string;
};

export type SessionExpiryState = "ok" | "warning" | "expired" | "unknown";

export function emptyBrowserSession(): BrowserSession {
  return {
    issuer: "",
    subject: "",
    displayName: "",
    expiresAt: null,
    csrfToken: "",
  };
}

export function parseBrowserSession(value: unknown): BrowserSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as SessionPayload & Record<string, unknown>;
  const subject = readString(raw.subject);
  if (!subject) {
    return null;
  }
  const expiresAt = readString(raw.expires_at || raw.expiresAt);
  return {
    issuer: readString(raw.issuer),
    subject,
    displayName: readString(raw.display_name || raw.displayName),
    expiresAt: expiresAt || null,
    csrfToken: readString(raw.csrf_token || raw.csrfToken),
  };
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
