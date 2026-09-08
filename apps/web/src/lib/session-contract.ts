/**
 * E2.3 browser session contract adapter (Chloe UI).
 *
 * Aligned to jonny's API PR #22. Paths, cookie names, and the CSRF
 * header live here so they stay in one place.
 *
 * Merge order: #22 (API) then #21 (this UI).
 */

export const SESSION_API_PREFIX = "/api/v1";

/** Browser session fetches use /api/v1 so Path=/api/v1 cookies are sent. */
export const SESSION_BROWSER_PREFIX = "/api/v1";

/** Next.js route that forwards to the Go API (also rewritten from /api/v1/*). */
export const SESSION_PROXY_PREFIX = "/api/control-plane";

export const SESSION_PATH = "/session";
export const SESSION_REFRESH_PATH = "/session/refresh";
export const SESSION_LOGOUT_PATH = "/session/logout";
export const SESSION_AUDIT_PATH = "/session/audit-events";

/** HttpOnly session cookie issued by the API. Never read from JS. */
export const SESSION_COOKIE_NAME = "ff_session";

/** Double-submit CSRF cookie. Readable; not a bearer secret. */
export const CSRF_COOKIE_NAME = "ff_csrf";

/** Header the API expects on mutating requests when a session cookie is present. */
export const CSRF_HEADER = "X-CSRF-Token";

/** Must match the API Set-Cookie Path so the browser sends ff_* cookies. */
export const SESSION_COOKIE_PATH = "/api/v1";

export const STATE_CHANGING_METHODS = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export const SESSION_PROBLEM_CODES = {
  unauthenticated: "unauthenticated",
  staleSession: "stale-session",
  csrfRequired: "csrf-required",
  csrfInvalid: "csrf-invalid",
} as const;

export type SessionEstablishBody = {
  issuer: string;
  external_subject: string;
  display_name?: string;
};

export type SessionView = {
  id: string;
  created_at?: string;
  last_seen_at?: string;
  idle_expires_at?: string;
  absolute_expires_at?: string;
};

export type SessionPrincipal = {
  id?: string;
  issuer: string;
  external_subject: string;
  display_name?: string;
  status?: string;
};

export type SessionPayload = {
  session?: SessionView;
  principal?: SessionPrincipal;
  csrf_token?: string;
};

export type SessionAuditEvent = {
  id: string;
  user_id?: string;
  session_id?: string;
  event_type: string;
  outcome: string;
  reason: string;
  request_id?: string;
  created_at: string;
};

export function sessionApiPath(suffix = SESSION_PATH): string {
  return `${SESSION_API_PREFIX}${suffix}`;
}

export function sessionBrowserPath(suffix = SESSION_PATH): string {
  return `${SESSION_BROWSER_PREFIX}${suffix}`;
}

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.includes(
    method.toUpperCase() as (typeof STATE_CHANGING_METHODS)[number],
  );
}

export function normalizeApiPath(path: string): string {
  const noQuery = (path.split("?")[0] ?? path).trim();
  if (noQuery.startsWith(SESSION_PROXY_PREFIX)) {
    return noQuery.slice(SESSION_PROXY_PREFIX.length) || "/";
  }
  if (noQuery.startsWith(SESSION_API_PREFIX)) {
    return noQuery.slice(SESSION_API_PREFIX.length) || "/";
  }
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
}

/**
 * CSRF is required on mutations when a cookie session is present.
 * POST /session (create) is exempt so bootstrap can set the first cookies.
 * Header-only callers (no ff_session) skip CSRF — the proxy enforces that.
 */
export function csrfRequiredFor(method: string, proxyPath: string): boolean {
  if (!isStateChangingMethod(method)) {
    return false;
  }
  const normalized = normalizeApiPath(proxyPath);
  if (method.toUpperCase() === "POST" && normalized === SESSION_PATH) {
    return false;
  }
  return true;
}

/** Browser session fetches stay on same-origin /api/v1 — never a foreign API origin. */
export function sameOriginProxyUrl(path: string): string | null {
  if (!path || path.includes("://") || path.startsWith("//")) {
    return null;
  }
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  if (withSlash.includes("://")) {
    return null;
  }
  if (
    withSlash.startsWith(SESSION_API_PREFIX) ||
    withSlash.startsWith(SESSION_PROXY_PREFIX)
  ) {
    return withSlash;
  }
  return `${SESSION_BROWSER_PREFIX}${withSlash}`;
}
