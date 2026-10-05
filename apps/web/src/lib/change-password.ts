/**
 * #376 Change-password chrome (Chloe). API half is on main via #377.
 *
 * Standalone only. When GET /session (or login) has
 * must_change_password, product chrome is blocked until
 * POST /api/v1/session/password succeeds. Embed never mounts this
 * door. B.* wizard stays outside and wins over this gate.
 *
 * Password POSTs once and is never persisted in chrome, query, or
 * localStorage. Do not treat trusted-dev / PLATFORM_ADMINS as this
 * local Login door.
 */

import { LOGIN_SUCCESS_HREF } from "./local-login.ts";
import { PASSWORD_CHANGE_WRONG_CURRENT_DETAIL } from "./session.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import { FF_ACCENT, FF_CANVAS } from "./visual-tokens.ts";

export const CHANGE_PASSWORD_STORY = 376;
export const CHANGE_PASSWORD_API_PR = 377;
export const CHANGE_PASSWORD_ID = "change-password-chrome-must-change-gate" as const;

export const CHANGE_PASSWORD_HREF = "/change-password";
export const CHANGE_PASSWORD_SUCCESS_HREF = LOGIN_SUCCESS_HREF;

/** Documented first-run one-time default. Never persist or log. */
export const ONE_TIME_BOOTSTRAP_PASSWORD = "admin";

/** Matches apps/api localauth.MinPasswordLength. */
export const CHANGE_PASSWORD_MIN_LENGTH = 8;

export const CHANGE_PASSWORD_EMPTY = "Enter a new password and confirm it.";
export const CHANGE_PASSWORD_MISMATCH =
  "New password and confirmation do not match.";
export const CHANGE_PASSWORD_ONE_TIME_REUSE =
  "Choose a new password that is not the one-time default.";
export const CHANGE_PASSWORD_TOO_SHORT =
  "Password does not meet the required length.";
export const CHANGE_PASSWORD_UNAVAILABLE =
  "Password change is temporarily unavailable. Try again shortly.";
export const CHANGE_PASSWORD_UNAUTHENTICATED =
  "Sign-in is required to change this password.";
/** Voluntary change-password help. No one-time bootstrap wording. */
export const CHANGE_PASSWORD_VOLUNTARY_HELP = "Change your password.";
/** Forced reset (`must_change_password`). The gate cannot be skipped. */
export const CHANGE_PASSWORD_FORCED_HELP =
  "A one-time bootstrap password must be changed before you can continue. This cannot be skipped.";
export const CHANGE_PASSWORD_CURRENT_REQUIRED = "Enter your current password.";
/** Matches POST /session/password 401 when the current secret is wrong. */
export const CHANGE_PASSWORD_CURRENT_REJECTED =
  PASSWORD_CHANGE_WRONG_CURRENT_DETAIL;
export const CHANGE_PASSWORD_EMBED_FORBIDDEN =
  "This password cannot be changed from an embed session.";
export const CHANGE_PASSWORD_FAILED = "Could not change password.";

export const CHANGE_PASSWORD = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  standaloneOnly: true,
  neverOnEmbedV1: true,
  consumeV1Tokens: true,
  oneAccentSubmit: true,
  newPlusConfirmMasked: true,
  noSkipOrCancelBypass: true,
  noPrefillOneTimePassword: true,
  incompleteWizardWins: true,
  productRoutesFailClosed: true,
  successLandsOverview: true,
  embedNeverMountsDoor: true,
  trustedDevStaysSeparate: true,
  passwordPostsOnceAndClears: true,
  neverPersistPasswordHashPemKek: true,
  noLocalStorageForSecrets: true,
  noQuerySecrets: true,
  draftsNeverRun: true,
  yamlIsSourceOfTruth: true,
  notAnN8nClone: true,
  noGreenfieldApis: true,
  apiAlreadyOnMain: true,
} as const;

export const CHANGE_PASSWORD_SOURCES = [
  "src/lib/change-password.ts",
  "src/lib/session-client.ts",
  "src/components/session/ChangePasswordChrome.tsx",
  "src/components/session/ChangePasswordLanding.tsx",
  "src/components/session/ChangePasswordAccountLink.tsx",
  "src/components/session/MustChangePasswordGate.tsx",
  "src/components/session/LoginChrome.tsx",
  "src/components/session/LoginLanding.tsx",
  "src/components/session/SignedOutGate.tsx",
  "src/components/shell/WorkspaceShell.tsx",
  "src/app/change-password/page.tsx",
] as const;

export const CHANGE_PASSWORD_CHROME_SOURCE =
  "src/components/session/ChangePasswordChrome.tsx" as const;
export const MUST_CHANGE_GATE_SOURCE =
  "src/components/session/MustChangePasswordGate.tsx" as const;

export type ChangePasswordForm = {
  currentPassword: string;
  password: string;
  confirm: string;
};

export type ChangePasswordRequestBody = {
  password: string;
  current_password?: string;
};

export type MustChangeChrome = "change-password" | "home" | "ignore";

export type MustChangeChromeDecision = {
  chrome: MustChangeChrome;
  reason: "embed" | "signed-out" | "must-change" | "session";
};

export type MustChangeGateInput = {
  embed: boolean;
  sessionActive: boolean;
  mustChangePassword: boolean;
};

export function emptyChangePasswordForm(): ChangePasswordForm {
  return { currentPassword: "", password: "", confirm: "" };
}

/** Voluntary change proves the current secret. A forced reset omits it. */
export function changePasswordRequiresCurrentPassword(
  mustChangePassword: boolean,
): boolean {
  return mustChangePassword !== true;
}

/** Password POSTs once. Caller must drop both fields after submit. */
export function clearChangePasswordForm(): ChangePasswordForm {
  return emptyChangePasswordForm();
}

export function changePasswordFormIsSubmittable(
  form: ChangePasswordForm,
  requireCurrentPassword = false,
): boolean {
  if (requireCurrentPassword && form.currentPassword.trim() === "") {
    return false;
  }
  return Boolean(form.password && form.confirm);
}

/**
 * JSON body for POST /session/password. `current_password` is included
 * only when the caller supplied a value. A forced reset omits the field.
 */
export function changePasswordRequestBody(
  password: string,
  currentPassword?: string,
): ChangePasswordRequestBody {
  const body: ChangePasswordRequestBody = { password };
  if (currentPassword != null && currentPassword !== "") {
    body.current_password = currentPassword;
  }
  return body;
}

export function isOneTimeBootstrapPassword(password: string): boolean {
  return password === ONE_TIME_BOOTSTRAP_PASSWORD;
}

/**
 * Cheap client checks before POST. Server 4xx still wins.
 * The current password lives in form state only until submit clears it.
 */
export function changePasswordClientError(
  form: ChangePasswordForm,
  options?: { requireCurrentPassword?: boolean },
): string | null {
  if (
    options?.requireCurrentPassword === true &&
    form.currentPassword.trim() === ""
  ) {
    return CHANGE_PASSWORD_CURRENT_REQUIRED;
  }
  if (!form.password || !form.confirm) {
    return CHANGE_PASSWORD_EMPTY;
  }
  if (form.password !== form.confirm) {
    return CHANGE_PASSWORD_MISMATCH;
  }
  if (isOneTimeBootstrapPassword(form.password)) {
    return CHANGE_PASSWORD_ONE_TIME_REUSE;
  }
  if (form.password.length < CHANGE_PASSWORD_MIN_LENGTH) {
    return CHANGE_PASSWORD_TOO_SHORT;
  }
  return null;
}

export function changePasswordFailureMessage(
  statusCode: number,
  detail?: string | null,
): string {
  if (statusCode === 401) {
    if (detail === CHANGE_PASSWORD_CURRENT_REJECTED) {
      return CHANGE_PASSWORD_CURRENT_REJECTED;
    }
    return CHANGE_PASSWORD_UNAUTHENTICATED;
  }
  if (statusCode === 403) {
    return CHANGE_PASSWORD_EMBED_FORBIDDEN;
  }
  if (statusCode === 503) {
    return CHANGE_PASSWORD_UNAVAILABLE;
  }
  const text = detail?.trim();
  if (text && !/hash|kek|\bpem\b|DATABASE_URL|dsn/i.test(text)) {
    return text;
  }
  return CHANGE_PASSWORD_FAILED;
}

export function afterLocalLoginHref(mustChangePassword: boolean): string {
  return mustChangePassword ? CHANGE_PASSWORD_HREF : CHANGE_PASSWORD_SUCCESS_HREF;
}

export function isChangePasswordPath(pathname: string | null | undefined): boolean {
  const path = (pathname ?? "").split("?")[0];
  return path === CHANGE_PASSWORD_HREF;
}

/**
 * Fail-closed product gate. Embed ignores. Signed-out is Login's job.
 * Incomplete install is BootstrapGate's job (mounts outside this gate).
 */
export function decideMustChangeChrome(
  input: MustChangeGateInput,
): MustChangeChromeDecision {
  if (input.embed) {
    return { chrome: "ignore", reason: "embed" };
  }
  if (!input.sessionActive) {
    return { chrome: "ignore", reason: "signed-out" };
  }
  if (input.mustChangePassword) {
    return { chrome: "change-password", reason: "must-change" };
  }
  return { chrome: "home", reason: "session" };
}

export function mustChangePasswordBlocksProduct(input: MustChangeGateInput): boolean {
  return decideMustChangeChrome(input).chrome === "change-password";
}

export function changePasswordSourceConsumesV1Tokens(source: string): boolean {
  return (
    source.includes("--ff-canvas") &&
    source.includes("--ff-accent") &&
    source.includes("--ff-surface") &&
    source.includes("FF_SHELL_ROOT_CLASS") &&
    FF_CANVAS === "#0f1218" &&
    FF_ACCENT === "#0f766e"
  );
}

export function changePasswordSourceRetainsSecrets(source: string): boolean {
  const stores = ["localStorage", "sessionStorage"].some((token) =>
    source.includes(token),
  );
  if (!stores) {
    return false;
  }
  return /password|hash|pem|kek|DATABASE_URL|dsn/i.test(source);
}

export function changePasswordSourceHasBypass(source: string): boolean {
  if (/Remind me later|Continue without/i.test(source)) {
    return true;
  }
  // Allow the a11y skip link; reject Skip/Cancel actions that leave the gate.
  const withoutSkipLink = source.replace(/Skip to main content/g, "");
  return /\b(Skip|Cancel)\b/.test(withoutSkipLink);
}

export function embedSourceMountsChangePassword(source: string): boolean {
  return (
    source.includes("ChangePasswordChrome") ||
    source.includes("MustChangePasswordGate") ||
    source.includes("changeLocalPassword")
  );
}

export function changePasswordHoldsHardLines(): boolean {
  return (
    CHANGE_PASSWORD.yamlIsSourceOfTruth &&
    CHANGE_PASSWORD.draftsNeverRun &&
    CHANGE_PASSWORD.neverOnEmbedV1 &&
    CHANGE_PASSWORD.embedNeverMountsDoor &&
    CHANGE_PASSWORD.noSkipOrCancelBypass &&
    CHANGE_PASSWORD.incompleteWizardWins &&
    CHANGE_PASSWORD.productRoutesFailClosed &&
    CHANGE_PASSWORD.passwordPostsOnceAndClears &&
    CHANGE_PASSWORD.neverPersistPasswordHashPemKek &&
    CHANGE_PASSWORD.successLandsOverview &&
    CHANGE_PASSWORD.consumeV1Tokens &&
    CHANGE_PASSWORD.notAnN8nClone &&
    CHANGE_PASSWORD.noGreenfieldApis &&
    CHANGE_PASSWORD.apiAlreadyOnMain &&
    CHANGE_PASSWORD_SUCCESS_HREF === "/workflows" &&
    CHANGE_PASSWORD_HREF === "/change-password"
  );
}
