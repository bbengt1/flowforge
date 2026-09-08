import { csrfRequiredProblem } from "./session.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  csrfRequiredFor,
} from "./session-contract.ts";
import { getCsrfToken, rememberCsrfToken } from "./session-store.ts";

export function readCsrfCookie(cookieHeader = ""): string {
  if (!cookieHeader) {
    return "";
  }
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    if (name === CSRF_COOKIE_NAME) {
      return decodeCookieValue(trimmed.slice(eq + 1));
    }
  }
  return "";
}

export function resolveCsrfToken(cookieHeader?: string): string {
  const remembered = getCsrfToken().trim();
  if (remembered) {
    return remembered;
  }
  const fromCookie = readCsrfCookie(cookieHeader ?? browserCookieHeader());
  if (fromCookie) {
    rememberCsrfToken(fromCookie);
  }
  return fromCookie;
}

export function captureCsrfFromResponse(
  headers: Headers,
  body: unknown,
): void {
  const headerToken = headers.get(CSRF_HEADER)?.trim();
  if (headerToken) {
    rememberCsrfToken(headerToken);
    return;
  }
  if (body && typeof body === "object") {
    const raw = body as Record<string, unknown>;
    const fromBody =
      (typeof raw.csrf_token === "string" && raw.csrf_token) ||
      (typeof raw.csrfToken === "string" && raw.csrfToken) ||
      "";
    if (fromBody.trim()) {
      rememberCsrfToken(fromBody);
    }
  }
}

export function attachCsrfHeader(
  headers: Record<string, string>,
  token: string,
): void {
  const value = token.trim();
  if (value) {
    headers[CSRF_HEADER] = value;
  }
}

export function missingCsrfProblem(instance: string, requestId: string) {
  return csrfRequiredProblem(instance, requestId);
}

export function shouldAttachCsrf(method: string, proxyPath: string): boolean {
  return csrfRequiredFor(method, proxyPath);
}

export function cookieHasSession(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) {
    return false;
  }
  for (const part of cookieHeader.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name === SESSION_COOKIE_NAME) {
      return Boolean(part.split("=")[1]?.trim());
    }
  }
  return false;
}

/**
 * Next-proxy fail-closed: a session cookie without a CSRF header on a
 * state-changing request is rejected before the Go API is called.
 */
export function proxyCsrfDenial(options: {
  method: string;
  proxyPath: string;
  cookieHeader: string | null;
  csrfHeader: string | null;
  requestId: string;
}): ReturnType<typeof csrfRequiredProblem> | null {
  if (!csrfRequiredFor(options.method, options.proxyPath)) {
    return null;
  }
  if (!cookieHasSession(options.cookieHeader)) {
    return null;
  }
  if (options.csrfHeader?.trim()) {
    return null;
  }
  return csrfRequiredProblem(options.proxyPath, options.requestId);
}

function browserCookieHeader(): string {
  if (typeof document === "undefined") {
    return "";
  }
  return document.cookie;
}

function decodeCookieValue(value: string): string {
  const trimmed = value.trim();
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}
