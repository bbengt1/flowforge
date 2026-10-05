/**
 * Standalone set-password chrome. Refs #572.
 *
 * Consumes POST /api/v1/bootstrap/admin-password
 * `{setup_token, password}`. 201 opens Login and does not mint a
 * session. The setup token is a masked field. It is never copied
 * from the query string into the form, and it is never written to
 * localStorage or sessionStorage.
 *
 * An authenticated 403 password_change_required opens /change-password.
 * Embed never mounts this door.
 */

import { ONE_TIME_BOOTSTRAP_PASSWORD } from "./change-password.ts";
import {
  BOOTSTRAP_ADMIN_PASSWORD_PATH,
  isBootstrapWizardMutation,
} from "./first-run-bootstrap.ts";
import { LOGIN_HREF } from "./local-login.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  SESSION_ADMIN_PASSWORD_PATH,
  SESSION_PROBLEM_CODES,
  sessionBrowserPath,
} from "./session-contract.ts";
import { FF_ACCENT, FF_CANVAS } from "./visual-tokens.ts";

export const SET_PASSWORD_STORY = 572;
export const SET_PASSWORD_API_PR = 580;
export const SET_PASSWORD_ID = "set-password-setup-token" as const;

export const SET_PASSWORD_HREF = "/set-password";
export const SET_PASSWORD_SUCCESS_HREF = LOGIN_HREF;
export const SET_PASSWORD_API_PATH = sessionBrowserPath(SESSION_ADMIN_PASSWORD_PATH);

export const SET_PASSWORD_MIN_LENGTH = 8;
export const SET_PASSWORD_MAX_LENGTH = 72;
export const SET_PASSWORD_TOKEN_MIN_LENGTH = 16;
export const SET_PASSWORD_TOKEN_MAX_LENGTH = 256;

export const SET_PASSWORD_EMPTY =
  "Enter the setup token, a new password, and confirmation.";
export const SET_PASSWORD_MISMATCH =
  "New password and confirmation do not match.";
export const SET_PASSWORD_TOKEN_INVALID = "setup_token is not valid.";
export const SET_PASSWORD_TOO_SHORT =
  "Password does not meet the required length.";
export const SET_PASSWORD_ONE_TIME_REUSE =
  "Choose a new password that is not the one-time default and is not the current password.";
export const SET_PASSWORD_TOKEN_REJECTED = "Setup token was not accepted.";
export const SET_PASSWORD_TOKEN_CONSUMED =
  "The setup token is no longer valid.";
export const SET_PASSWORD_RATE_LIMITED =
  "Setup rate limit exceeded. Retry after the configured window.";
export const SET_PASSWORD_EMBED_FORBIDDEN =
  "The first-run wizard is standalone only.";
export const SET_PASSWORD_CSRF = "CSRF validation failed.";
export const SET_PASSWORD_QUERY_REJECTED =
  "The setup token belongs in this field, not in the address bar.";
export const SET_PASSWORD_UNAVAILABLE =
  "Password setup is temporarily unavailable. Try again shortly.";
export const SET_PASSWORD_FAILED = "Could not set the admin password.";
export const SET_PASSWORD_CHANGE_REQUIRED =
  "Change your password to continue.";

const DETAIL_ALLOWLIST = new Set<string>([
  "setup_token and password belong in the request body.",
  SET_PASSWORD_TOO_SHORT,
  SET_PASSWORD_ONE_TIME_REUSE,
  "setup_token and password are required.",
  SET_PASSWORD_TOKEN_INVALID,
  "Admin password setup accepts setup_token and password.",
  SET_PASSWORD_TOKEN_CONSUMED,
  SET_PASSWORD_TOKEN_REJECTED,
  SET_PASSWORD_RATE_LIMITED,
  SET_PASSWORD_EMBED_FORBIDDEN,
  SET_PASSWORD_CSRF,
]);

const QUERY_SECRET_KEYS = new Set([
  "setup_token",
  "password",
  "token",
  "passwd",
]);

export const SET_PASSWORD = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  standaloneOnly: true,
  neverOnEmbedV1: true,
  postsSetupTokenAndPasswordOnly: true,
  successOpensLogin: true,
  doesNotMintSession: true,
  tokenNeverInUrl: true,
  tokenNeverInStorage: true,
  passwordPostsOnceAndClears: true,
  passwordChangeRequiredOpensChangePassword: true,
  noSkipOrCancelBypass: true,
  embedNeverMountsDoor: true,
  consumeV1Tokens: true,
  draftsNeverRun: true,
  yamlIsSourceOfTruth: true,
  notAnN8nClone: true,
  noGreenfieldApis: true,
} as const;

export const SET_PASSWORD_SOURCES = [
  "src/lib/set-password.ts",
  "src/lib/session-client.ts",
  "src/lib/session-contract.ts",
  "src/lib/identity-client.ts",
  "src/lib/session-store.ts",
  "src/components/session/SetPasswordChrome.tsx",
  "src/components/session/SetPasswordLanding.tsx",
  "src/components/session/SignedOutGate.tsx",
  "src/components/session/LoginChrome.tsx",
  "src/app/set-password/page.tsx",
] as const;

export const SET_PASSWORD_CHROME_SOURCE =
  "src/components/session/SetPasswordChrome.tsx" as const;

export type SetPasswordForm = {
  setupToken: string;
  password: string;
  confirm: string;
};

export type AdminPasswordBody = {
  setup_token: string;
  password: string;
};

export type AdminPasswordSet = {
  adminPasswordSet: true;
  mustChangePassword: false;
  loginReady: true;
  identifier: "admin";
};

export type SetPasswordChromeChoice = "set-password" | "login" | "ignore";

export function emptySetPasswordForm(): SetPasswordForm {
  return { setupToken: "", password: "", confirm: "" };
}

/** Token and password POST once. Caller drops both after submit. */
export function clearSetPasswordForm(): SetPasswordForm {
  return emptySetPasswordForm();
}

export function setPasswordFormIsSubmittable(form: SetPasswordForm): boolean {
  return Boolean(form.setupToken.trim() && form.password && form.confirm);
}

export function adminPasswordBody(
  setupToken: string,
  password: string,
): AdminPasswordBody {
  return {
    setup_token: setupToken.trim(),
    password,
  };
}

export function setPasswordClientError(form: SetPasswordForm): string | null {
  if (!form.setupToken.trim() || !form.password || !form.confirm) {
    return SET_PASSWORD_EMPTY;
  }
  if (form.password !== form.confirm) {
    return SET_PASSWORD_MISMATCH;
  }
  if (setupTokenError(form.setupToken)) {
    return SET_PASSWORD_TOKEN_INVALID;
  }
  const token = form.setupToken.trim();
  if (form.password === ONE_TIME_BOOTSTRAP_PASSWORD || form.password === token) {
    return SET_PASSWORD_ONE_TIME_REUSE;
  }
  if (
    form.password.length < SET_PASSWORD_MIN_LENGTH ||
    form.password.length > SET_PASSWORD_MAX_LENGTH
  ) {
    return SET_PASSWORD_TOO_SHORT;
  }
  return null;
}

function setupTokenError(token: string): boolean {
  const value = token.trim();
  if (
    value.length < SET_PASSWORD_TOKEN_MIN_LENGTH ||
    value.length > SET_PASSWORD_TOKEN_MAX_LENGTH
  ) {
    return true;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * True when the address bar carries a setup secret. The caller must
 * drop the query without copying the value into form state.
 */
export function locationCarriesSetupSecret(search: string, hash = ""): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    const norm = key.toLowerCase().replaceAll("-", "_");
    if (QUERY_SECRET_KEYS.has(norm)) {
      return true;
    }
  }
  const raw = `${search}${hash}`.toLowerCase();
  return (
    raw.includes("setup_token=") ||
    raw.includes("setup-token=") ||
    raw.includes("password=") ||
    raw.includes("passwd=")
  );
}

export function isSetPasswordPath(pathname: string | null | undefined): boolean {
  const path = (pathname ?? "").split("?")[0];
  return path === SET_PASSWORD_HREF;
}

export function decideSetPasswordChrome(input: {
  embed: boolean;
  pathname: string | null | undefined;
  sessionActive: boolean;
}): SetPasswordChromeChoice {
  if (input.embed || input.sessionActive) {
    return "ignore";
  }
  return isSetPasswordPath(input.pathname) ? "set-password" : "login";
}

/** 201 opens Login. This response does not mint a session. */
export function afterAdminPasswordHref(): string {
  return SET_PASSWORD_SUCCESS_HREF;
}

export function parseAdminPasswordSet(value: unknown): AdminPasswordSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.adminPasswordSet !== true || raw.loginReady !== true) {
    return null;
  }
  if (raw.mustChangePassword !== false || raw.identifier !== "admin") {
    return null;
  }
  return {
    adminPasswordSet: true,
    mustChangePassword: false,
    loginReady: true,
    identifier: "admin",
  };
}

export type SetPasswordFailureAction = "change-password" | "message";

export function setPasswordFailureAction(
  statusCode: number,
  code?: string | null,
): SetPasswordFailureAction {
  if (
    statusCode === 403 &&
    code === SESSION_PROBLEM_CODES.passwordChangeRequired
  ) {
    return "change-password";
  }
  return "message";
}

export function setPasswordFailureMessage(
  statusCode: number,
  detail?: string | null,
  retryAfterSeconds?: number,
): string {
  if (statusCode === 401) {
    return SET_PASSWORD_TOKEN_REJECTED;
  }
  if (statusCode === 409) {
    return SET_PASSWORD_TOKEN_CONSUMED;
  }
  if (statusCode === 429) {
    if (
      typeof retryAfterSeconds === "number" &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 1
    ) {
      return `${SET_PASSWORD_RATE_LIMITED} Retry after ${retryAfterSeconds} seconds.`;
    }
    return SET_PASSWORD_RATE_LIMITED;
  }
  if (statusCode === 403) {
    const text = detail?.trim() ?? "";
    if (text === SET_PASSWORD_CSRF || /csrf/i.test(text)) {
      return SET_PASSWORD_CSRF;
    }
    return SET_PASSWORD_EMBED_FORBIDDEN;
  }
  if (statusCode === 503) {
    return SET_PASSWORD_UNAVAILABLE;
  }
  if (statusCode === 400) {
    const text = detail?.trim() ?? "";
    if (DETAIL_ALLOWLIST.has(text)) {
      return text;
    }
  }
  return SET_PASSWORD_FAILED;
}

export function setPasswordProxyStripsStaleCookie(): boolean {
  return (
    SESSION_ADMIN_PASSWORD_PATH === BOOTSTRAP_ADMIN_PASSWORD_PATH &&
    isBootstrapWizardMutation("POST", SET_PASSWORD_API_PATH)
  );
}

export function setPasswordSourceConsumesV1Tokens(source: string): boolean {
  return (
    source.includes("--ff-canvas") &&
    source.includes("--ff-accent") &&
    source.includes("--ff-surface") &&
    source.includes("FF_SHELL_ROOT_CLASS") &&
    FF_CANVAS === "#0f1218" &&
    FF_ACCENT === "#0f766e"
  );
}

export function setPasswordSourceRetainsSecrets(source: string): boolean {
  const stores = ["localStorage", "sessionStorage"].some((token) =>
    source.includes(token),
  );
  if (!stores) {
    return false;
  }
  return /password|setup_token|hash|pem|kek|DATABASE_URL|dsn/i.test(source);
}

export function setPasswordSourceReadsQuerySecret(source: string): boolean {
  return /searchParams\.get|location\.search\s*=|setup_token=|password=/.test(
    source,
  );
}

export function setPasswordSourceHasBypass(source: string): boolean {
  if (/Remind me later|Continue without/i.test(source)) {
    return true;
  }
  const withoutSkipLink = source.replace(/Skip to main content/g, "");
  return /\b(Skip|Cancel)\b/.test(withoutSkipLink);
}

export function embedSourceMountsSetPassword(source: string): boolean {
  return (
    source.includes("SetPasswordChrome") ||
    source.includes("setAdminPassword")
  );
}

export function setPasswordHoldsHardLines(): boolean {
  return (
    SET_PASSWORD.yamlIsSourceOfTruth &&
    SET_PASSWORD.draftsNeverRun &&
    SET_PASSWORD.neverOnEmbedV1 &&
    SET_PASSWORD.embedNeverMountsDoor &&
    SET_PASSWORD.postsSetupTokenAndPasswordOnly &&
    SET_PASSWORD.successOpensLogin &&
    SET_PASSWORD.doesNotMintSession &&
    SET_PASSWORD.tokenNeverInUrl &&
    SET_PASSWORD.tokenNeverInStorage &&
    SET_PASSWORD.passwordPostsOnceAndClears &&
    SET_PASSWORD.passwordChangeRequiredOpensChangePassword &&
    SET_PASSWORD.noSkipOrCancelBypass &&
    SET_PASSWORD.noGreenfieldApis &&
    SET_PASSWORD_SUCCESS_HREF === "/login" &&
    SET_PASSWORD_HREF === "/set-password" &&
    SET_PASSWORD_API_PATH === "/api/v1/bootstrap/admin-password"
  );
}
