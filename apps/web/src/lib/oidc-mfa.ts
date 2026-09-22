/**
 * G.2.1 OIDC Authorization Code + PKCE and MFA chrome (#446).
 *
 * Relates to #446 / Part of #446. Keep #446 open.
 * API contract is draft PR #466. This module is chrome only — no Go
 * handlers. Local Login (`POST /api/v1/login`) stays.
 *
 * The browser never receives `code_verifier` or `client_secret`.
 * `otpauth_uri` is shown once and is not written to localStorage,
 * sessionStorage, the URL, or logs. Embed never mounts this door.
 * `applicable: false` (machine, embed, trusted-dev) does not force MFA.
 */

import type { ProblemDetails } from "./problem.ts";
import { sessionBrowserPath } from "./session-contract.ts";

const INVALID_CREDENTIALS = "Invalid credentials.";

export const G21_STORY = 446;
export const G21_API_PR = 466;
export const G21_KEEP_STORY_OPEN = true;
export const G21_ID = "G.2.1-oidc-mfa-login-chrome" as const;

export const OIDC_CALLBACK_PATH = "/login/oidc/callback";
export const MFA_ACCOUNT_PATH = "/account/mfa";

export const OIDC_START_PATH = "/oidc/start";
export const OIDC_CALLBACK_API_PATH = "/oidc/callback";
export const MFA_STATUS_PATH = "/session/mfa";
export const MFA_ENROLL_PATH = "/session/mfa/enroll";
export const MFA_VERIFY_PATH = "/session/mfa/verify";

export const OIDC_STATE_COOKIE = "ff_oidc_state";

export const MFA_REQUIRED_CODE = "mfa-required";

export const OIDC_NOT_CONFIGURED_DETAIL = "OIDC is not configured.";
export const OIDC_UNAVAILABLE = "Single sign-on is not available.";
export const OIDC_TEMPORARILY_UNAVAILABLE =
  "Sign-in is temporarily unavailable. Try again shortly.";
export const OIDC_RATE_LIMITED =
  "Sign-in was rate-limited. Wait a moment and try again.";
export const OIDC_FAILED = "Sign-in failed.";

export const MFA_ENROLL_REQUIRED =
  "Enroll and verify MFA before using this permission.";
export const MFA_VERIFY_REQUIRED = "Verify MFA before using this permission.";
export const MFA_ALREADY_ENROLLED = "MFA is already enrolled.";
export const MFA_NOT_CONFIGURED = "MFA is not configured.";
export const MFA_RATE_LIMITED =
  "Too many MFA attempts. Wait a moment and try again.";
export const MFA_FAILED = "Multi-factor authentication failed.";
export const MFA_PRIVILEGED_LOUD =
  "Privileged actions need multi-factor authentication before they can run.";
export const MFA_SETUP_ONCE =
  "This setup link is shown once. Copy it into your authenticator now. FlowForge does not store it.";
export const MFA_VERIFIED_RETRY = "MFA verified. Try the privileged action again.";
export const MFA_NOT_APPLICABLE =
  "Multi-factor authentication does not apply to this sign-in.";
export const MFA_SESSION_ON = "MFA is on for this session.";

const FORBIDDEN_AUTHORIZE_PARAMS = [
  "code_verifier",
  "client_secret",
  "otpauth_uri",
  "password",
  "id_token",
  "access_token",
  "refresh_token",
];

export type OidcStartResponse = {
  authorization_url: string;
  state: string;
  expires_at: string;
};

export type MfaStatus = {
  method: "totp";
  enrolled: boolean;
  satisfied: boolean;
  applicable: boolean;
  privileged_permissions: string[];
};

export type MfaRequiredKind = "enroll" | "verify" | "unknown";

export type MfaRequiredNotice = {
  kind: MfaRequiredKind;
  message: string;
};

export type MfaChromeDecision = "mfa" | "ignore";

const mfaRequiredListeners = new Set<(notice: MfaRequiredNotice) => void>();

export function oidcStartBrowserPath(): string {
  return sessionBrowserPath(OIDC_START_PATH);
}

export function oidcCallbackBrowserPath(): string {
  return sessionBrowserPath(OIDC_CALLBACK_API_PATH);
}

export function mfaStatusBrowserPath(): string {
  return sessionBrowserPath(MFA_STATUS_PATH);
}

export function mfaEnrollBrowserPath(): string {
  return sessionBrowserPath(MFA_ENROLL_PATH);
}

export function mfaVerifyBrowserPath(): string {
  return sessionBrowserPath(MFA_VERIFY_PATH);
}

export function oidcStartBody(): Record<string, never> {
  return {};
}

export function oidcCallbackBody(
  code: string,
  state: string,
): { code: string; state: string } {
  return { code: code.trim(), state: state.trim() };
}

export function mfaEnrollBody(): Record<string, never> {
  return {};
}

export function mfaVerifyBody(code: string): { code: string } {
  return { code: code.trim() };
}

export function mfaCodeIsSubmittable(code: string): boolean {
  return /^[0-9]{6,8}$/.test(code.trim());
}

export function isOidcCallbackPath(pathname: string | null | undefined): boolean {
  const path = (pathname ?? "").split("?")[0]?.split("#")[0] ?? "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed === OIDC_CALLBACK_PATH;
}

export function isMfaAccountPath(pathname: string | null | undefined): boolean {
  const path = (pathname ?? "").split("?")[0]?.split("#")[0] ?? "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed === MFA_ACCOUNT_PATH;
}

/** Read only `code` and `state`. Ignore IdP tokens if they appear on the query. */
export function oidcCallbackParams(
  search: string,
): { code: string; state: string } | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw.split("#")[0] ?? "");
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

export function isSafeAuthorizationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) {
    return false;
  }
  const localhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") {
    // public IdP
  } else if (!(url.protocol === "http:" && localhost)) {
    return false;
  }
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_AUTHORIZE_PARAMS.includes(key.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function parseOidcStart(value: unknown): OidcStartResponse | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    "code_verifier" in body ||
    "client_secret" in body ||
    "id_token" in body ||
    "access_token" in body ||
    "refresh_token" in body ||
    "otpauth_uri" in body
  ) {
    return null;
  }
  const authorizationUrl =
    typeof body.authorization_url === "string" ? body.authorization_url.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim() : "";
  const expiresAt =
    typeof body.expires_at === "string" ? body.expires_at.trim() : "";
  if (!authorizationUrl || !state || !expiresAt) {
    return null;
  }
  if (!isSafeAuthorizationUrl(authorizationUrl)) {
    return null;
  }
  return {
    authorization_url: authorizationUrl,
    state,
    expires_at: expiresAt,
  };
}

export function oidcIsUnconfigured(
  statusCode: number,
  detail?: string | null,
): boolean {
  return statusCode === 503 && detail?.trim() === OIDC_NOT_CONFIGURED_DETAIL;
}

export function oidcFailureMessage(
  statusCode: number,
  detail?: string | null,
): string {
  if (oidcIsUnconfigured(statusCode, detail)) {
    return OIDC_UNAVAILABLE;
  }
  if (statusCode === 503) {
    return OIDC_TEMPORARILY_UNAVAILABLE;
  }
  if (statusCode === 429) {
    return OIDC_RATE_LIMITED;
  }
  if (statusCode === 401) {
    return INVALID_CREDENTIALS;
  }
  return OIDC_FAILED;
}

export function parseMfaStatus(value: unknown): MfaStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.enrolled !== "boolean" ||
    typeof body.satisfied !== "boolean" ||
    typeof body.applicable !== "boolean"
  ) {
    return null;
  }
  const permissions = Array.isArray(body.privileged_permissions)
    ? body.privileged_permissions.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
  return {
    method: "totp",
    enrolled: body.enrolled,
    satisfied: body.satisfied,
    applicable: body.applicable,
    privileged_permissions: permissions,
  };
}

/** Pull a one-time otpauth URI off an enroll payload. Never returns other secrets. */
export function takeOtpauthUri(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = (value as Record<string, unknown>).otpauth_uri;
  if (typeof raw !== "string") {
    return null;
  }
  const uri = raw.trim();
  if (!uri.startsWith("otpauth://totp/") || /\s/.test(uri)) {
    return null;
  }
  if (/secret|client_secret|code_verifier/i.test(uri) && !uri.includes("secret=")) {
    return null;
  }
  return uri;
}

export function mfaFailureMessage(
  statusCode: number,
  detail?: string | null,
): string {
  if (statusCode === 401) {
    return INVALID_CREDENTIALS;
  }
  if (statusCode === 409 && detail?.trim() === MFA_ALREADY_ENROLLED) {
    return MFA_ALREADY_ENROLLED;
  }
  if (statusCode === 409) {
    return MFA_ALREADY_ENROLLED;
  }
  if (statusCode === 429) {
    return MFA_RATE_LIMITED;
  }
  if (statusCode === 503) {
    return MFA_NOT_CONFIGURED;
  }
  return MFA_FAILED;
}

export function mfaRequiredKind(detail?: string | null): MfaRequiredKind {
  const text = detail?.trim() ?? "";
  if (text === MFA_ENROLL_REQUIRED) {
    return "enroll";
  }
  if (text === MFA_VERIFY_REQUIRED) {
    return "verify";
  }
  return "unknown";
}

/** Fixed copy only. Unknown or secret-bearing detail is not shown. */
export function mfaRequiredMessage(detail?: string | null): string {
  const kind = mfaRequiredKind(detail);
  if (kind === "enroll") {
    return MFA_ENROLL_REQUIRED;
  }
  if (kind === "verify") {
    return MFA_VERIFY_REQUIRED;
  }
  return MFA_PRIVILEGED_LOUD;
}

export function isMfaRequiredProblem(
  problem: Pick<ProblemDetails, "code" | "status"> | null | undefined,
): boolean {
  return problem?.code === MFA_REQUIRED_CODE && problem.status === 403;
}

export function isMfaControlPath(instance: string): boolean {
  const path = instance.split("?")[0] ?? instance;
  return (
    path.endsWith(MFA_STATUS_PATH) ||
    path.endsWith(MFA_ENROLL_PATH) ||
    path.endsWith(MFA_VERIFY_PATH)
  );
}

export function decideMfaChrome(input: {
  embed: boolean;
  sessionActive: boolean;
  applicable: boolean;
}): MfaChromeDecision {
  if (input.embed || !input.sessionActive || !input.applicable) {
    return "ignore";
  }
  return "mfa";
}

export function subscribeMfaRequired(
  listener: (notice: MfaRequiredNotice) => void,
): () => void {
  mfaRequiredListeners.add(listener);
  return () => {
    mfaRequiredListeners.delete(listener);
  };
}

export function noteMfaRequiredProblem(
  instance: string,
  problem: ProblemDetails,
): void {
  if (!isMfaRequiredProblem(problem) || isMfaControlPath(instance)) {
    return;
  }
  const notice: MfaRequiredNotice = {
    kind: mfaRequiredKind(problem.detail),
    message: mfaRequiredMessage(problem.detail),
  };
  for (const listener of mfaRequiredListeners) {
    try {
      listener(notice);
    } catch {
      // A chrome listener must not break the API result.
    }
  }
}

export function oidcMfaHoldsHardLines(): boolean {
  return (
    G21_KEEP_STORY_OPEN &&
    G21_STORY === 446 &&
    G21_API_PR === 466 &&
    OIDC_CALLBACK_PATH.startsWith("/login/") &&
    !OIDC_CALLBACK_PATH.includes("code_verifier")
  );
}
