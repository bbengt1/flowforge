/**
 * B.6 / B.7: First-run wizard chrome + Settings handoff + Skip TLS.
 *
 * Relates to #339 / #347 / Part of #333. Keep #339 and #347 open.
 *
 * Chloe UI only. Consumes jonny's B.1–B.5 / B.7 status-only APIs
 * (`docs/architecture/flowforge-first-run-bootstrap.md`). No new
 * control-plane routes. Mutations go through the same-origin proxy
 * with CSRF when a session cookie is present.
 *
 * Gate: standalone `GET /api/control-plane/bootstrap` only.
 * `200` + `incomplete` → wizard. `200` + `complete` or `401` →
 * product home. Never invent a second gate. Embed ignores the
 * payload (ADV-021 `session.embed` only).
 *
 * TLS offers Create / Upload / Skip for now. Skip POSTs
 * `{action:"skip"}` only — no PEM — and is a first-class exit,
 * not a silent default. After complete the wizard never remounts.
 * URL / TLS / users / persistence edits live in Settings and link
 * out. Settings `#tls` surfaces `skipped` (HTTP until enable later).
 */

import { PRODUCT_HOME_HREF, SETTINGS_HREF } from "./product-home.ts";
import { MEMBERSHIP_HREF } from "./product-session-chrome.ts";
import type { ProblemDetails } from "./problem.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

export const B6_STORY = 339;
export const B6_EPIC = 333;
export const B6_KEEP_STORY_OPEN = true;
export const B6_ID = "B.6-wizard-chrome-settings-handoff" as const;

export const B7_STORY = 347;
export const B7_EPIC = 333;
export const B7_KEEP_STORY_OPEN = true;
export const B7_ID = "B.7-skip-tls-wizard-chrome" as const;

export const FIRST_RUN_BOOTSTRAP_BRIEF =
  "docs/architecture/flowforge-first-run-bootstrap.md";

export const BOOTSTRAP_STATUS_PATH = "/bootstrap";
export const BOOTSTRAP_PERSISTENCE_PATH = "/bootstrap/persistence";
export const BOOTSTRAP_ADMINS_PATH = "/bootstrap/admins";
export const BOOTSTRAP_PUBLIC_URL_PATH = "/bootstrap/public-url";
export const BOOTSTRAP_TLS_PATH = "/bootstrap/tls";

export const SETTINGS_BOOTSTRAP_HREF = `${SETTINGS_HREF}#bootstrap`;
export const SETTINGS_PERSISTENCE_HREF = `${SETTINGS_HREF}#persistence`;
export const SETTINGS_PUBLIC_URL_HREF = `${SETTINGS_HREF}#public-url`;
export const SETTINGS_TLS_HREF = `${SETTINGS_HREF}#tls`;
export const SETTINGS_USERS_HANDOFF_HREF = MEMBERSHIP_HREF;

export const FIRST_RUN_WIZARD_COMPLETE_HREF = PRODUCT_HOME_HREF;

export const BOOTSTRAP_STEPS = [
  "persistence",
  "firstAdmin",
  "publicUrl",
  "tls",
] as const;

export type BootstrapStepId = (typeof BOOTSTRAP_STEPS)[number];

export type BootstrapTlsMode =
  | "none"
  | "self_signed"
  | "uploaded"
  | "local_http"
  | "skipped";

export type BootstrapStep = {
  ready: boolean;
  mode?: BootstrapTlsMode;
};

export type BootstrapStatus = {
  complete: boolean;
  incomplete: boolean;
  skipped: boolean;
  standaloneOnly: true;
  steps: {
    persistence: BootstrapStep;
    firstAdmin: BootstrapStep;
    publicUrl: BootstrapStep;
    tls: BootstrapStep;
  };
};

export type BootstrapChrome = "ignore" | "wizard" | "home" | "blocked";

export type BootstrapChromeDecision = {
  chrome: BootstrapChrome;
  status: BootstrapStatus | null;
  reason:
    | "embed"
    | "incomplete"
    | "complete"
    | "unauthenticated"
    | "blocked";
};

export type BootstrapTlsAction = "create-self-signed" | "upload" | "skip";

export const DEFAULT_BOOTSTRAP_TLS_ACTION: BootstrapTlsAction =
  "create-self-signed";

export type BootstrapAdminInput = {
  issuer: string;
  external_subject: string;
  display_name?: string;
};

export type BootstrapPersistenceInput = {
  confirm: true;
};

export type BootstrapPublicUrlInput = {
  publicBaseUrl: string;
};

export type BootstrapTlsInput =
  | { action: "create-self-signed" }
  | { action: "upload"; certPem: string; keyPem: string }
  | { action: "skip" };

export const FIRST_RUN_BOOTSTRAP = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  standaloneOnly: true,
  neverOnEmbedV1: true,
  ignoreBootstrapPayloadOnEmbed: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  callGetBootstrapFromStandaloneShellOnly: true,
  incompleteShowsWizard: true,
  completeGoesHome: true,
  unauthenticated401IsHome: true,
  neverInventSecondGate: true,
  failClosedStepOrder: true,
  doNotSkipAhead: true,
  wizardNeverReappearsAfterComplete: true,
  settingsHandoffAfterComplete: true,
  settingsLinkOutDoNotRemountWizard: true,
  noBrowserHeldSecrets: true,
  noLocalStorageForPasswordsPemsKek: true,
  noPasswordFieldUntilLocalLogin: true,
  neverEchoPublicUrl: true,
  pemPostOnce: true,
  skipTlsPostsActionOnly: true,
  skipTlsNeverIncludesPem: true,
  skipTlsIsFirstClassExit: true,
  skipTlsNotSilentDefault: true,
  skipTlsOnlyWhenPublicUrlReady: true,
  skipTlsLeavesWizardOnComplete: true,
  httpUntilTlsInSettings: true,
  settingsSurfacesSkippedTls: true,
  acmeOutOfScope: true,
  csrfWhenSessionPresent: true,
  sameOriginProxyOnly: true,
  noNewApi: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  notAnN8nClone: true,
} as const;

export const FIRST_RUN_BOOTSTRAP_HELP =
  "Standalone first-run wizard (persistence → first admin → public URL → TLS). TLS offers Create / Upload / Skip for now. Skip POSTs {action:\"skip\"} only and leaves the instance on HTTP until TLS is enabled in Settings. Incomplete GET shows the wizard; complete or 401 goes to product home. Never on /embed/v1. After complete, Settings links out — the wizard does not remount. Passwords, PEMs, and KEK are never stored in the browser.";

export const FIRST_RUN_BOOTSTRAP_SOURCES = [
  "src/lib/first-run-bootstrap.ts",
  "src/lib/first-run-bootstrap-client.ts",
  "src/components/bootstrap/BootstrapGate.tsx",
  "src/components/bootstrap/FirstRunWizard.tsx",
  "src/components/settings/BootstrapSettings.tsx",
  "src/components/shell/WorkspaceShell.tsx",
  "src/app/settings/page.tsx",
] as const;

export const BOOTSTRAP_STEP_LABELS = {
  persistence: "Persistence",
  firstAdmin: "First admin",
  publicUrl: "Public URL",
  tls: "TLS",
} as const satisfies Record<BootstrapStepId, string>;

export const BOOTSTRAP_STEP_HELP = {
  persistence:
    "Confirm that process PostgreSQL is reachable. Do not enter a DSN, password, or DATABASE_URL — the server already uses its environment.",
  firstAdmin:
    "Create the first admin from an identity issuer and external subject. Local login has not landed — there is no password field. Include this issuer|subject on PLATFORM_ADMINS for platform.administer.",
  publicUrl:
    "Public origin only (https://host[:port]). HTTPS is preferred; HTTP is allowed for local installs. No userinfo, query, fragment, or path. The URL is never echoed on status.",
  tls:
    "Enable TLS by creating a self-signed certificate or uploading a PEM pair once, or choose Skip for now. Skip is a first-class exit — not a silent default — and is only offered after the public URL is ready. This instance stays on HTTP until you enable TLS in Settings. ACME / Let’s Encrypt is out of scope. Private keys POST once and are never stored in the browser.",
} as const satisfies Record<BootstrapStepId, string>;

export const BOOTSTRAP_TLS_SKIP_LABEL = "Skip for now";

export const BOOTSTRAP_TLS_SKIP_WARNING =
  "This instance will stay on HTTP until you enable TLS in Settings. Skip for now finishes first-run setup and opens product home. You can create a self-signed certificate or upload a PEM pair later under Settings → TLS.";

export const BOOTSTRAP_TLS_SKIP_SETTINGS_COPY =
  "Skipped — this instance stays on HTTP until you enable TLS here. Create a self-signed certificate or upload a PEM pair later. Skip is not a lockout.";

export const BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER =
  "TLS was skipped on first-run. This instance stays on HTTP until you enable TLS under Settings → TLS.";

export const BOOTSTRAP_TLS_SKIP_PENDING = "Skipping TLS…";

export const BOOTSTRAP_TLS_SKIP_SUCCESS =
  "TLS skipped. This instance stays on HTTP until Settings. Opening workflows…";

export const BOOTSTRAP_SECRET_KEYS = [
  "password",
  "passwd",
  "certPem",
  "cert_pem",
  "keyPem",
  "key_pem",
  "privateKey",
  "private_key",
  "pem",
  "kek",
  "CREDENTIAL_KEK",
  "credentialKek",
  "publicBaseUrl",
  "public_base_url",
  "DATABASE_URL",
  "database_url",
  "databaseUrl",
  "dsn",
  "hash",
  "ciphertext",
  "token",
  "secret",
  "secrets",
] as const;

export const BOOTSTRAP_SECRET_STORAGE_TOKENS = [
  "localStorage.setItem",
  "localStorage.setItem(",
  "sessionStorage.setItem",
] as const;

export const BOOTSTRAP_PASSWORD_FIELD_TOKENS = [
  'name="password"',
  "name='password'",
  'type="password"',
  "type='password'",
] as const;

export const BOOTSTRAP_WIZARD_REMOUNT_TOKENS = [
  "FirstRunWizard",
  "confirmBootstrapPersistence",
  "createBootstrapAdmin",
  "setBootstrapPublicUrl",
  "setBootstrapTls",
] as const;

export const TLS_MODE_LABELS = {
  none: "Not configured",
  self_signed: "Self-signed",
  uploaded: "Uploaded certificate",
  local_http: "Local HTTP",
  skipped: "Skipped",
} as const satisfies Record<BootstrapTlsMode, string>;

const TLS_MODES = new Set<BootstrapTlsMode>([
  "none",
  "self_signed",
  "uploaded",
  "local_http",
  "skipped",
]);

export function emptyBootstrapStatus(): BootstrapStatus {
  return {
    complete: false,
    incomplete: true,
    skipped: false,
    standaloneOnly: true,
    steps: {
      persistence: { ready: false },
      firstAdmin: { ready: false },
      publicUrl: { ready: false },
      tls: { ready: false },
    },
  };
}

export function shouldFetchBootstrapGate(embed: boolean): boolean {
  return !embed;
}

export function parseBootstrapStatus(value: unknown): BootstrapStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.complete !== "boolean" || typeof raw.incomplete !== "boolean") {
    return null;
  }
  if (typeof raw.skipped !== "boolean" || raw.standaloneOnly !== true) {
    return null;
  }
  const stepsRaw = raw.steps;
  if (!stepsRaw || typeof stepsRaw !== "object" || Array.isArray(stepsRaw)) {
    return null;
  }
  const steps = stepsRaw as Record<string, unknown>;
  const persistence = parseBootstrapStep(steps.persistence);
  const firstAdmin = parseBootstrapStep(steps.firstAdmin);
  const publicUrl = parseBootstrapStep(steps.publicUrl);
  const tls = parseBootstrapStep(steps.tls);
  if (!persistence || !firstAdmin || !publicUrl || !tls) {
    return null;
  }
  return {
    complete: raw.complete,
    incomplete: raw.incomplete,
    skipped: raw.skipped,
    standaloneOnly: true,
    steps: { persistence, firstAdmin, publicUrl, tls },
  };
}

function parseBootstrapStep(value: unknown): BootstrapStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.ready !== "boolean") {
    return null;
  }
  const step: BootstrapStep = { ready: raw.ready };
  if (typeof raw.mode === "string" && TLS_MODES.has(raw.mode as BootstrapTlsMode)) {
    step.mode = raw.mode as BootstrapTlsMode;
  }
  return step;
}

export function bootstrapStatusRetainsSecrets(value: unknown): boolean {
  return collectForbiddenKeys(value).length > 0;
}

export function collectForbiddenKeys(
  value: unknown,
  found: string[] = [],
): string[] {
  if (!value || typeof value !== "object") {
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectForbiddenKeys(item, found);
    }
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const norm = key.replace(/-/g, "_");
    if (
      (BOOTSTRAP_SECRET_KEYS as readonly string[]).some(
        (secret) => secret.toLowerCase() === key.toLowerCase() || secret === norm,
      )
    ) {
      found.push(key);
    }
    collectForbiddenKeys(child, found);
  }
  return found;
}

export function decideBootstrapChrome(input: {
  embed: boolean;
  statusCode: number;
  body?: unknown;
}): BootstrapChromeDecision {
  if (input.embed) {
    return { chrome: "ignore", status: null, reason: "embed" };
  }
  if (input.statusCode === 401) {
    return { chrome: "home", status: null, reason: "unauthenticated" };
  }
  if (input.statusCode !== 200 && input.statusCode !== 201) {
    return { chrome: "blocked", status: null, reason: "blocked" };
  }
  const status = parseBootstrapStatus(input.body);
  if (!status) {
    return { chrome: "blocked", status: null, reason: "blocked" };
  }
  if (status.complete && !status.incomplete) {
    return { chrome: "home", status, reason: "complete" };
  }
  if (status.incomplete && !status.complete) {
    return { chrome: "wizard", status, reason: "incomplete" };
  }
  return { chrome: "blocked", status, reason: "blocked" };
}

export function currentBootstrapStep(
  status: BootstrapStatus,
): BootstrapStepId | "done" {
  if (status.complete || !status.incomplete) {
    return "done";
  }
  for (const step of BOOTSTRAP_STEPS) {
    if (!status.steps[step].ready) {
      return step;
    }
  }
  return "tls";
}

export function bootstrapStepIndex(step: BootstrapStepId | "done"): number {
  if (step === "done") {
    return BOOTSTRAP_STEPS.length;
  }
  return BOOTSTRAP_STEPS.indexOf(step);
}

export function canOpenBootstrapStep(
  status: BootstrapStatus,
  step: BootstrapStepId,
): boolean {
  return currentBootstrapStep(status) === step;
}

export function bootstrapStepIsAhead(
  status: BootstrapStatus,
  step: BootstrapStepId,
): boolean {
  const current = currentBootstrapStep(status);
  if (current === "done") {
    return false;
  }
  return bootstrapStepIndex(step) > bootstrapStepIndex(current);
}

export function settingsHandoffAfterComplete(status: BootstrapStatus): boolean {
  return status.complete && !status.incomplete;
}

export function shouldRemountWizard(input: {
  embed: boolean;
  complete: boolean;
  settingsSurface: boolean;
}): boolean {
  if (input.embed || input.complete || input.settingsSurface) {
    return false;
  }
  return true;
}

export function normalizePublicBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!parsed.host) {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function bootstrapAdminBody(
  input: BootstrapAdminInput,
): BootstrapAdminInput {
  const body: BootstrapAdminInput = {
    issuer: input.issuer.trim(),
    external_subject: input.external_subject.trim(),
  };
  const display = input.display_name?.trim();
  if (display) {
    body.display_name = display;
  }
  return body;
}

export function bootstrapTlsCreateBody(): BootstrapTlsInput {
  return { action: "create-self-signed" };
}

export function bootstrapTlsSkipBody(): { action: "skip" } {
  return { action: "skip" };
}

export function tlsSkipBodyIsActionOnly(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const keys = Object.keys(body);
  return keys.length === 1 && (body as { action?: string }).action === "skip";
}

export function wizardTlsInput(
  action: BootstrapTlsAction,
  draft: { certPem: string; keyPem: string },
): BootstrapTlsInput | null {
  if (action === "skip") {
    return bootstrapTlsSkipBody();
  }
  if (action === "create-self-signed") {
    return bootstrapTlsCreateBody();
  }
  return bootstrapTlsUploadBody(draft.certPem, draft.keyPem);
}

export function tlsStepIsSkipped(step: BootstrapStep): boolean {
  return step.mode === "skipped";
}

export function tlsSettingsDescription(step: BootstrapStep): string {
  if (tlsStepIsSkipped(step)) {
    return BOOTSTRAP_TLS_SKIP_SETTINGS_COPY;
  }
  if (step.ready) {
    return `Ready — ${tlsModeLabel(step.mode)}.`;
  }
  return `Not ready — ${tlsModeLabel(step.mode)}. Local HTTP skips stay Settings-only.`;
}

export function bootstrapTlsUploadBody(
  certPem: string,
  keyPem: string,
): BootstrapTlsInput | null {
  const cert = certPem.trim();
  const key = keyPem.trim();
  if (!cert || !key) {
    return null;
  }
  return { action: "upload", certPem: cert, keyPem: key };
}

export function emptyTlsUploadDraft(): { certPem: string; keyPem: string } {
  return { certPem: "", keyPem: "" };
}

export function wizardSourceRetainsSecrets(source: string): boolean {
  const stores = BOOTSTRAP_SECRET_STORAGE_TOKENS.some((token) =>
    source.includes(token),
  );
  if (!stores) {
    return false;
  }
  return /password|certPem|keyPem|kek|pem|DATABASE_URL|dsn/i.test(source);
}

export function wizardSourceHasPasswordField(source: string): boolean {
  return BOOTSTRAP_PASSWORD_FIELD_TOKENS.some((token) => source.includes(token));
}

export function settingsSourceRemountsWizard(source: string): boolean {
  return BOOTSTRAP_WIZARD_REMOUNT_TOKENS.some((token) => source.includes(token));
}

export function bootstrapProblemMessage(
  statusCode: number,
  problem?: Pick<ProblemDetails, "detail" | "title" | "code"> | null,
): string {
  const detail = problem?.detail?.trim();
  if (statusCode === 409) {
    return (
      detail ||
      "This step cannot run now. Finish the previous step, or edit this in Settings after setup is complete."
    );
  }
  if (statusCode === 403) {
    return (
      detail ||
      "This first-run step is standalone only and is not available from an embed session."
    );
  }
  if (statusCode === 400) {
    return (
      detail ||
      "The request was rejected. Check the fields — passwords are not accepted, and the public URL must be an origin."
    );
  }
  if (statusCode === 503) {
    return (
      detail ||
      "A required dependency is unavailable (PostgreSQL, TLS files, or the bootstrap store)."
    );
  }
  if (statusCode === 401) {
    return "Setup is complete. Sign in to open product home.";
  }
  return detail || problem?.title || `Request failed (${statusCode}).`;
}

export function mutationConflictIsComplete(
  statusCode: number,
  problem?: Pick<ProblemDetails, "detail"> | null,
): boolean {
  if (statusCode !== 409) {
    return false;
  }
  return /already complete/i.test(problem?.detail ?? "");
}

export function tlsModeLabel(mode?: BootstrapTlsMode): string {
  return TLS_MODE_LABELS[mode ?? "none"];
}

export function firstRunBootstrapHoldsHardLines(): boolean {
  return (
    FIRST_RUN_BOOTSTRAP.neverOnEmbedV1 &&
    FIRST_RUN_BOOTSTRAP.ignoreBootstrapPayloadOnEmbed &&
    FIRST_RUN_BOOTSTRAP.adv021ChromeFromSessionEmbedOnly &&
    FIRST_RUN_BOOTSTRAP.adv024MembershipIsolationStayGrantGated &&
    FIRST_RUN_BOOTSTRAP.noBrowserHeldSecrets &&
    FIRST_RUN_BOOTSTRAP.noLocalStorageForPasswordsPemsKek &&
    FIRST_RUN_BOOTSTRAP.wizardNeverReappearsAfterComplete &&
    FIRST_RUN_BOOTSTRAP.settingsHandoffAfterComplete &&
    FIRST_RUN_BOOTSTRAP.failClosedStepOrder &&
    FIRST_RUN_BOOTSTRAP.yamlIsSourceOfTruth &&
    FIRST_RUN_BOOTSTRAP.draftsNeverRun &&
    FIRST_RUN_BOOTSTRAP.notAnN8nClone &&
    FIRST_RUN_BOOTSTRAP.noNewApi &&
    FIRST_RUN_BOOTSTRAP.neverInventSecondGate &&
    FIRST_RUN_BOOTSTRAP.skipTlsPostsActionOnly &&
    FIRST_RUN_BOOTSTRAP.skipTlsNeverIncludesPem &&
    FIRST_RUN_BOOTSTRAP.skipTlsIsFirstClassExit &&
    FIRST_RUN_BOOTSTRAP.skipTlsNotSilentDefault &&
    FIRST_RUN_BOOTSTRAP.httpUntilTlsInSettings &&
    FIRST_RUN_BOOTSTRAP.settingsSurfacesSkippedTls &&
    R7_HARD_LINE.adv021ChromeFromSessionEmbedOnly
  );
}
