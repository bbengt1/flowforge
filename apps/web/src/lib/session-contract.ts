/**
 * E2.3 browser session contract adapter (Chloe UI).
 *
 * Jonny owns the Go session store, Set-Cookie issuance, and server
 * CSRF/CORS/CSP policy. This module is the single place to retarget
 * paths and header/cookie names when that OpenAPI lands.
 *
 * Status: provisional until jonny's E2.3 PR merges. See PR body.
 */

export const SESSION_API_PREFIX = "/api/v1";
export const SESSION_PROXY_PREFIX = "/api/control-plane";

/** Relative to /api/v1 and /api/control-plane. */
export const SESSION_PATH = "/session";
export const SESSION_SEGMENTS = ["session"] as const;
export const SESSION_METHODS = ["GET", "POST", "DELETE"] as const;

/** HttpOnly session cookie issued by the API. Never read from JS. */
export const SESSION_COOKIE_NAME = "flowforge_session";

/** Double-submit CSRF cookie. Readable; not a bearer secret. */
export const CSRF_COOKIE_NAME = "flowforge_csrf";

/** Header the API expects on state-changing browser requests. */
export const CSRF_HEADER = "X-CSRF-Token";

export const STATE_CHANGING_METHODS = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export type SessionProblemCode =
  | "unauthenticated"
  | "stale-session"
  | "csrf-required"
  | "csrf-invalid";

export const SESSION_PROBLEM_CODES = {
  unauthenticated: "unauthenticated",
  staleSession: "stale-session",
  csrfRequired: "csrf-required",
  csrfInvalid: "csrf-invalid",
} as const;

export type SessionEstablishBody = {
  issuer: string;
  subject: string;
  display_name?: string;
};

export type SessionPayload = {
  issuer: string;
  subject: string;
  display_name?: string;
  expires_at?: string;
  csrf_token?: string;
};

export function sessionApiPath(): string {
  return `${SESSION_API_PREFIX}${SESSION_PATH}`;
}

export function sessionProxyPath(): string {
  return `${SESSION_PROXY_PREFIX}${SESSION_PATH}`;
}

export function isSessionSegments(segments: readonly string[]): boolean {
  return (
    segments.length === SESSION_SEGMENTS.length &&
    SESSION_SEGMENTS.every((part, index) => segments[index] === part)
  );
}

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.includes(
    method.toUpperCase() as (typeof STATE_CHANGING_METHODS)[number],
  );
}

/**
 * POST /session may run before a CSRF cookie exists (bootstrap).
 * The client still sends CSRF when it already has a token.
 * DELETE /session always requires CSRF once a session exists.
 */
export function csrfRequiredFor(method: string, proxyPath: string): boolean {
  if (!isStateChangingMethod(method)) {
    return false;
  }
  const normalized = proxyPath.split("?")[0] ?? proxyPath;
  if (
    method.toUpperCase() === "POST" &&
    (normalized === SESSION_PATH || normalized === sessionProxyPath())
  ) {
    return false;
  }
  return true;
}

/** Browser session fetches stay on same-origin Next proxies — never the API origin. */
export function sameOriginProxyUrl(path: string): string | null {
  if (!path || path.includes("://") || path.startsWith("//")) {
    return null;
  }
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  if (withSlash.includes("://")) {
    return null;
  }
  return `${SESSION_PROXY_PREFIX}${withSlash}`;
}
