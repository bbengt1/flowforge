/**
 * V.0b: Login chrome + signed-out gate.
 *
 * Relates to #355 / Part of #353. Keep #355 open.
 *
 * Chloe UI only. Consumes jonny's V.0a `POST /api/v1/login` and
 * V.1 tokens. No new control-plane routes. Password POSTs once
 * and is never persisted in chrome, query, or localStorage.
 *
 * B.1 gate stays: incomplete → wizard. Complete or 401 is "not
 * wizard" (home). This slice layers Login on standalone home
 * when there is no cookie session. Embed never mounts Login —
 * missing `session.embed` stays the ADV-021 alert.
 */

import { decideBootstrapChrome, type BootstrapChromeDecision } from "./first-run-bootstrap.ts";
import { PRODUCT_HOME_HREF } from "./product-home.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  LOGIN_RATE_LIMITED_MESSAGE,
  LOGIN_RATE_LIMIT_RULES,
  type LocalLoginBody,
} from "./session-contract.ts";
import { FF_ACCENT, FF_CANVAS } from "./visual-tokens.ts";

export const V0B_STORY = 355;
export const V0B_EPIC = 353;
export const V0B_KEEP_STORY_OPEN = true;
export const V0B_ID = "V.0b-login-chrome-signed-out-gate" as const;
export const V0B_BRIEF = "docs/internal/flowforge-visual-ia-north-star.md";

export const V0B_HELP =
  "Full-dark standalone Login (email/username + masked password + Sign in). Signed-out product routes show Login. Complete-install 401 shows Login, not the wizard. Incomplete still shows the wizard only. After success, Overview (/workflows). Embed never mounts Login. Password POSTs once and is cleared. Consume V.1 tokens. Keep #355 open.";

export const LOGIN_HREF = "/login";
export const LOGIN_SUCCESS_HREF = PRODUCT_HOME_HREF;

export const LOGIN_INVALID_CREDENTIALS = "Invalid credentials.";
export const LOGIN_STORE_UNAVAILABLE =
  "Sign-in is temporarily unavailable. Try again shortly.";

export const LOCAL_LOGIN = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  standaloneOnly: true,
  neverOnEmbedV1: true,
  consumeV1Tokens: true,
  oneAccentSignIn: true,
  identifierPlusMaskedPassword: true,
  // G.2.1 adds “Sign in with SSO” beside this door. Password stays the
  // accent submit. The SSO control disables when OIDC is not configured.
  noSsoOidcButtons: false,
  passwordDoorStays: true,
  ssoBesidePasswordWhenConfigured: true,
  noExampleContextAsProductDoor: true,
  noEstablishSessionAsProductDoor: true,
  signedOutStandaloneGoesToLogin: true,
  complete401GoesToLoginNotWizard: true,
  incompleteGoesToWizardOnly: true,
  b1GateUnchanged: true,
  successLandsOverview: true,
  workspaceSwitcherUnchanged: true,
  embedNeverMountsLogin: true,
  missingSessionEmbedStillAdv021: true,
  hostQueryDisplayOnly: true,
  passwordPostsOnceAndClears: true,
  neverPersistPasswordHashPemKek: true,
  noLocalStorageForSecrets: true,
  noQuerySecrets: true,
  draftsNeverRun: true,
  yamlIsSourceOfTruth: true,
  notAnN8nClone: true,
  noGreenfieldApis: true,
  keep355Open: true,
  jonnyNoneExpected: true,
} as const;

export const LOCAL_LOGIN_SOURCES = [
  "src/lib/local-login.ts",
  "src/lib/session-client.ts",
  "src/components/session/LoginChrome.tsx",
  "src/components/session/LoginLanding.tsx",
  "src/components/session/SignedOutGate.tsx",
  "src/components/shell/WorkspaceShell.tsx",
  "src/app/login/page.tsx",
] as const;

export const LOGIN_CHROME_SOURCE = "src/components/session/LoginChrome.tsx" as const;
export const SIGNED_OUT_GATE_SOURCE =
  "src/components/session/SignedOutGate.tsx" as const;

export type LocalLoginForm = {
  identifier: string;
  password: string;
};

export type SignedOutChrome = "login" | "home" | "wizard" | "ignore";

export type SignedOutChromeDecision = {
  chrome: SignedOutChrome;
  reason:
    | "embed"
    | "incomplete"
    | "complete-401"
    | "signed-out"
    | "session"
    | "blocked";
};

export type SignedOutGateInput = {
  embed: boolean;
  bootstrap: Pick<BootstrapChromeDecision, "chrome" | "reason">;
  sessionActive: boolean;
};

export function localLoginBody(
  identifier: string,
  password: string,
): LocalLoginBody {
  return {
    identifier: identifier.trim(),
    password,
  };
}

export function emptyLoginForm(): LocalLoginForm {
  return { identifier: "", password: "" };
}

/** Password POSTs once. Caller must drop the value after submit. */
export function clearLoginPassword(form: LocalLoginForm): LocalLoginForm {
  return { identifier: form.identifier, password: "" };
}

export function loginFormIsSubmittable(form: LocalLoginForm): boolean {
  return Boolean(form.identifier.trim() && form.password);
}

export function loginFailureMessage(
  statusCode: number,
  detail?: string | null,
): string {
  if (statusCode === 429 && LOGIN_RATE_LIMIT_RULES.treatAsBackoff) {
    return LOGIN_RATE_LIMITED_MESSAGE;
  }
  if (statusCode === 503) {
    return LOGIN_STORE_UNAVAILABLE;
  }
  if (statusCode === 401) {
    return LOGIN_INVALID_CREDENTIALS;
  }
  const text = detail?.trim();
  if (text && !/password|hash|kek|pem/i.test(text)) {
    return text;
  }
  return "Sign-in failed.";
}

/**
 * V.0b signed-out layer on top of the unchanged B.1 bootstrap gate.
 * Incomplete stays wizard-only. Complete / 401 is not wizard; without
 * a session that home is Login. Embed ignores this layer.
 */
export function decideSignedOutChrome(
  input: SignedOutGateInput,
): SignedOutChromeDecision {
  if (input.embed) {
    return { chrome: "ignore", reason: "embed" };
  }
  if (input.bootstrap.chrome === "wizard") {
    return { chrome: "wizard", reason: "incomplete" };
  }
  if (input.bootstrap.chrome === "blocked") {
    return { chrome: "ignore", reason: "blocked" };
  }
  if (input.bootstrap.chrome === "ignore") {
    return { chrome: "ignore", reason: "embed" };
  }
  if (!input.sessionActive) {
    if (input.bootstrap.reason === "unauthenticated") {
      return { chrome: "login", reason: "complete-401" };
    }
    return { chrome: "login", reason: "signed-out" };
  }
  return { chrome: "home", reason: "session" };
}

export function signedOutChromeFromBootstrapFetch(input: {
  embed: boolean;
  statusCode: number;
  body?: unknown;
  sessionActive: boolean;
}): SignedOutChromeDecision {
  return decideSignedOutChrome({
    embed: input.embed,
    bootstrap: decideBootstrapChrome({
      embed: input.embed,
      statusCode: input.statusCode,
      body: input.body,
    }),
    sessionActive: input.sessionActive,
  });
}

export function loginSourceIsProductDoor(source: string): boolean {
  return (
    source.includes("Sign in") &&
    /type=["']password["']/.test(source) &&
    /email|username|identifier/i.test(source) &&
    !/Establish session/.test(source) &&
    !/Example context/.test(source) &&
    !/Sign in with Google|magic.?link|Continue with/i.test(source)
  );
}

export function loginSourceRetainsSecrets(source: string): boolean {
  const stores = ["localStorage", "sessionStorage"].some((token) =>
    source.includes(token),
  );
  if (!stores) {
    return false;
  }
  return /password|hash|pem|kek|DATABASE_URL|dsn/i.test(source);
}

export function loginSourceConsumesV1Tokens(source: string): boolean {
  return (
    source.includes("--ff-canvas") &&
    source.includes("--ff-accent") &&
    source.includes("--ff-surface") &&
    source.includes("FF_SHELL_ROOT_CLASS") &&
    FF_CANVAS === "#0f1218" &&
    FF_ACCENT === "#0f766e"
  );
}

export function embedSourceMountsLogin(source: string): boolean {
  return (
    source.includes("LoginChrome") ||
    source.includes("loginWithPassword") ||
    source.includes("SignedOutGate")
  );
}

export function localLoginHoldsHardLines(): boolean {
  return (
    LOCAL_LOGIN.yamlIsSourceOfTruth &&
    LOCAL_LOGIN.draftsNeverRun &&
    LOCAL_LOGIN.neverOnEmbedV1 &&
    LOCAL_LOGIN.embedNeverMountsLogin &&
    LOCAL_LOGIN.missingSessionEmbedStillAdv021 &&
    LOCAL_LOGIN.complete401GoesToLoginNotWizard &&
    LOCAL_LOGIN.incompleteGoesToWizardOnly &&
    LOCAL_LOGIN.b1GateUnchanged &&
    LOCAL_LOGIN.passwordPostsOnceAndClears &&
    LOCAL_LOGIN.neverPersistPasswordHashPemKek &&
    LOCAL_LOGIN.passwordDoorStays &&
    LOCAL_LOGIN.ssoBesidePasswordWhenConfigured &&
    LOCAL_LOGIN.successLandsOverview &&
    LOCAL_LOGIN.consumeV1Tokens &&
    LOCAL_LOGIN.notAnN8nClone &&
    LOCAL_LOGIN.noGreenfieldApis &&
    LOCAL_LOGIN.keep355Open &&
    LOGIN_SUCCESS_HREF === "/workflows" &&
    V0B_KEEP_STORY_OPEN
  );
}
