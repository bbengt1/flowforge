/**
 * SCIM workspace tokens admin (web side of `/workspace/scim-tokens`).
 *
 * A workspace token lets one identity provider add and remove people in
 * this workspace only. Every route needs `workspace.administer` plus MFA
 * step-up, and embed sessions are refused, so the web hides the surface
 * on `/embed/v1` and never calls it there.
 *
 * The plaintext token appears once, in the create response. The web
 * keeps it only in the create dialog's own React state while that dialog
 * is open: never in the query cache, a mutation result, browser storage,
 * a URL, or a log. Records read from the API never carry it.
 *
 * Field errors are placed by `errors[].path` only, never by message text.
 */

import { sanitizeDestructiveImpact, type DestructiveImpactItem } from "./confirm-destructive.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import { WORKSPACE_ADMIN_PERMISSION } from "./workspace-nav.ts";

export const SCIM_TOKENS_API_PATH = "/workspace/scim-tokens";
export const SCIM_TOKENS_HREF = "/scim-tokens";

/** The fixed, non-secret prefix every workspace token starts with. */
export const SCIM_TOKEN_PREFIX = "ffscim_";
export const SCIM_TOKEN_NAME_MAX_CHARS = 128;
/** Used only until the list answers; the server's `maxActive` wins. */
export const SCIM_TOKENS_DEFAULT_MAX_ACTIVE = 2;

const SCIM_TOKEN_PLAINTEXT = /^ffscim_[A-Za-z0-9_-]{43}$/;

export const SCIM_TOKEN_LIMIT_CODE = "scim_token_limit";
export const SCIM_NOT_CONFIGURED_CODE = "scim_not_configured";

export type ScimTokenCreator = {
  id: string;
  displayName: string;
};

/** One active token as listed. Never holds the plaintext or its hash. */
export type ScimToken = {
  id: string;
  displayName: string;
  prefix: string;
  createdBy: ScimTokenCreator | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export type ScimTokenList = {
  items: ScimToken[];
  maxActive: number;
  configured: boolean;
};

/* ---------- copy ---------- */

export const SCIM_TOKENS_TITLE = "SCIM tokens";

export const SCIM_TOKENS_HELP =
  "A SCIM token lets your identity provider add and remove people in this workspace. It only reaches this workspace. Give each identity provider its own token so you can revoke one without stopping the others.";

export const SCIM_TOKENS_LINK_HELP =
  "Connect an identity provider so it can add and remove people in this workspace.";

export const SCIM_TOKENS_EMPTY_HEADING = "No SCIM tokens yet";

export const SCIM_TOKENS_EMPTY_HELP =
  "Create a token, then paste it into your identity provider's SCIM settings.";

export const SCIM_TOKENS_FORBIDDEN =
  "Only workspace administrators can manage SCIM tokens.";

export const SCIM_TOKENS_EMBED_UNAVAILABLE =
  "SCIM tokens are managed in the full FlowForge app. They are not available in an embedded view.";

export const SCIM_TOKENS_MFA_REQUIRED =
  "Verify multi-factor authentication to manage SCIM tokens, then try again.";

export const SCIM_TOKENS_NOT_AVAILABLE =
  "SCIM tokens aren't available on this server yet.";

export const SCIM_TOKENS_NOT_CONFIGURED =
  "SCIM isn't set up on this instance, so new tokens can't be created. A platform operator needs to configure it first.";

export const SCIM_TOKENS_LOAD_FAILED = "SCIM tokens could not be loaded.";

export const SCIM_TOKEN_UNKNOWN_CREATOR = "Unknown";

export const SCIM_TOKEN_NEVER_USED = "Never used";

export const SCIM_TOKEN_NAME_LABEL = "Token name";

export const SCIM_TOKEN_NAME_HINT =
  "Name it after the identity provider that will use it, for example \u201cOkta production\u201d. 1 to 128 characters.";

export const SCIM_TOKEN_NAME_REQUIRED_MESSAGE = "Enter a token name.";

export const SCIM_TOKEN_NAME_TOO_LONG_MESSAGE = `Use ${SCIM_TOKEN_NAME_MAX_CHARS} characters or fewer.`;

export const SCIM_TOKEN_NAME_INVALID_MESSAGE =
  "This name can't be used. Enter 1 to 128 characters without control characters.";

export const SCIM_TOKEN_REVEAL_LABEL = "New SCIM token";

export const SCIM_TOKEN_REVEAL_WARNING =
  "Copy this token now and paste it into your identity provider. It won't be shown again. If you lose it, revoke it and create a new one.";

export const SCIM_TOKEN_COPIED = "Copied to the clipboard.";

export const SCIM_TOKEN_COPY_FAILED =
  "Copying didn't work. Select the token and copy it yourself.";

export const SCIM_TOKEN_UNREADABLE =
  "The token was created, but it couldn't be shown. Revoke it and create a new one.";

export const SCIM_TOKEN_REVOKE_DESCRIPTION =
  "The identity provider using this token stops syncing right away: every request it sends with this token is refused. People it already added stay in the workspace with their roles. To reconnect, create a new token and paste it into the identity provider.";

export const SCIM_TOKEN_ALREADY_REVOKED = "That token was already revoked.";

export const SCIM_TOKEN_REVOKED = "Token revoked.";

export function scimTokenLimitMessage(maxActive: number): string {
  const max = normalizeMaxActive(maxActive);
  return `This workspace already has ${max} active SCIM ${
    max === 1 ? "token" : "tokens"
  }, the most it can have. Revoke one before creating another.`;
}

/* ---------- gating ---------- */

/**
 * Admin-only and never in embed. Unknown permissions (null) hide the
 * surface so it never flashes for a non-admin. The API still decides.
 */
export function canManageScimTokens(
  permissions: readonly string[] | null | undefined,
  options: { embed?: boolean } = {},
): boolean {
  if (options.embed) {
    return false;
  }
  if (permissions == null) {
    return false;
  }
  return permissions.includes(WORKSPACE_ADMIN_PERMISSION);
}

export function scimTokenApiPath(tokenId: string): string {
  return `${SCIM_TOKENS_API_PATH}/${encodeURIComponent(tokenId)}`;
}

/* ---------- reading responses ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMaxActive(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : SCIM_TOKENS_DEFAULT_MAX_ACTIVE;
}

function readCreator(value: unknown): ScimTokenCreator | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || !isResourceId(value.id)) {
    return null;
  }
  return {
    id: value.id,
    displayName: typeof value.displayName === "string" ? value.displayName : "",
  };
}

/**
 * Builds a fresh object from known fields only, so a `token` (or any
 * other extra field) on the wire can never ride along into the cache.
 */
export function readScimToken(value: unknown): ScimToken | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || !isResourceId(value.id)) {
    return null;
  }
  if (typeof value.displayName !== "string") {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    prefix: SCIM_TOKEN_PREFIX,
    createdBy: readCreator(value.createdBy),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    lastUsedAt:
      typeof value.lastUsedAt === "string" && value.lastUsedAt.trim()
        ? value.lastUsedAt
        : null,
  };
}

/**
 * `configured` is true only when the server says exactly `true`, so a
 * missing flag never offers a create that would fail.
 */
export function readScimTokenList(value: unknown): ScimTokenList {
  const raw = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  const items: ScimToken[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const token = readScimToken(entry);
    if (token && !seen.has(token.id)) {
      seen.add(token.id);
      items.push(token);
    }
  }
  return {
    items,
    maxActive: normalizeMaxActive(isRecord(value) ? value.maxActive : undefined),
    configured: isRecord(value) && value.configured === true,
  };
}

export type ScimTokenCreatedRead = {
  record: ScimToken | null;
  /** Null when the plaintext is missing or not token-shaped. */
  plaintext: string | null;
};

/**
 * Splits a create response into the record (safe to cache) and the
 * plaintext (for the reveal panel only). A malformed plaintext is not
 * shown, so nothing that isn't a workspace token lands on screen.
 */
export function readScimTokenCreated(value: unknown): ScimTokenCreatedRead {
  const record = readScimToken(value);
  const raw = isRecord(value) ? value.token : undefined;
  const plaintext =
    typeof raw === "string" && SCIM_TOKEN_PLAINTEXT.test(raw) ? raw : null;
  return { record, plaintext };
}

/* ---------- names ---------- */

export function normalizeScimTokenName(raw: string): string {
  return raw.trim();
}

/** Code points, the same count the API uses for the 128 limit. */
export function scimTokenNameLength(name: string): number {
  return [...name].length;
}

/** Client-side hint only. The server stays the authority. */
export function scimTokenNameClientError(raw: string): string | null {
  const name = normalizeScimTokenName(raw);
  if (!name) {
    return SCIM_TOKEN_NAME_REQUIRED_MESSAGE;
  }
  if (scimTokenNameLength(name) > SCIM_TOKEN_NAME_MAX_CHARS) {
    return SCIM_TOKEN_NAME_TOO_LONG_MESSAGE;
  }
  return null;
}

/* ---------- labels ---------- */

export function scimTokenCreatorLabel(createdBy: ScimTokenCreator | null): string {
  const name = createdBy?.displayName.trim() ?? "";
  return name || SCIM_TOKEN_UNKNOWN_CREATOR;
}

export function formatScimTokenTime(
  iso: string | null | undefined,
  options: { timeZone?: string } = {},
): string {
  if (!iso) {
    return "";
  }
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return "";
  }
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(new Date(ts));
}

export function scimTokenLastUsedLabel(
  lastUsedAt: string | null,
  options: { timeZone?: string } = {},
): string {
  return formatScimTokenTime(lastUsedAt, options) || SCIM_TOKEN_NEVER_USED;
}

/** The prefix hint shown on each row. The rest of the token is never known. */
export function scimTokenPrefixHint(token: Pick<ScimToken, "prefix">): string {
  return `${token.prefix || SCIM_TOKEN_PREFIX}\u2026`;
}

export function scimTokenActiveCountLabel(count: number, maxActive: number): string {
  return `${Math.max(0, count)} of ${normalizeMaxActive(maxActive)} active`;
}

/* ---------- problems and page state ---------- */

export type ScimTokenProblemKind =
  | "mfa-required"
  | "forbidden"
  | "not-available"
  | "not-configured"
  | "limit"
  | "not-found"
  | "field"
  | "banner";

function problemPathHit(
  problem: Pick<ProblemDetails, "errors">,
  path: string,
): boolean {
  return (problem.errors ?? []).some((error) => error?.path === path);
}

/**
 * One plain treatment per problem. The code picks the sentence; the
 * server's detail text is never shown in place of it.
 */
export function scimTokenProblemKind(
  problem: Pick<ProblemDetails, "status" | "code" | "errors"> | null | undefined,
): ScimTokenProblemKind | null {
  if (!problem) {
    return null;
  }
  if (problem.status === 403 && problem.code === "mfa-required") {
    return "mfa-required";
  }
  if (problem.status === 401 || problem.status === 403) {
    return "forbidden";
  }
  if (problem.status === 501) {
    return "not-available";
  }
  if (problem.code === SCIM_NOT_CONFIGURED_CODE) {
    return "not-configured";
  }
  if (problem.code === SCIM_TOKEN_LIMIT_CODE) {
    return "limit";
  }
  if (problem.status === 404) {
    return "not-found";
  }
  if (problem.status === 400 && problemPathHit(problem, "displayName")) {
    return "field";
  }
  return "banner";
}

/** Sentence for the name field, or null when the problem goes elsewhere. */
export function scimTokenNameFieldError(
  problem: Pick<ProblemDetails, "status" | "code" | "errors"> | null | undefined,
): string | null {
  return scimTokenProblemKind(problem) === "field" ? SCIM_TOKEN_NAME_INVALID_MESSAGE : null;
}

/** Plain sentence for kinds that replace the raw problem. */
export function scimTokenProblemSentence(
  kind: ScimTokenProblemKind | null,
  maxActive = SCIM_TOKENS_DEFAULT_MAX_ACTIVE,
): string | null {
  switch (kind) {
    case "mfa-required":
      return SCIM_TOKENS_MFA_REQUIRED;
    case "forbidden":
      return SCIM_TOKENS_FORBIDDEN;
    case "not-available":
      return SCIM_TOKENS_NOT_AVAILABLE;
    case "not-configured":
      return SCIM_TOKENS_NOT_CONFIGURED;
    case "limit":
      return scimTokenLimitMessage(maxActive);
    default:
      return null;
  }
}

/** Terminal list problems are not retried: retrying can't change them. */
export function scimTokenListProblemIsTerminal(
  problem: Pick<ProblemDetails, "status" | "code" | "errors"> | null | undefined,
): boolean {
  const kind = scimTokenProblemKind(problem);
  return kind !== null && kind !== "banner";
}

export type ScimTokensView =
  | { kind: "loading" }
  | { kind: "blocked"; reason: "mfa-required" | "forbidden" | "not-available"; message: string }
  | { kind: "error"; problem: ProblemDetails }
  | { kind: "ready"; list: ScimTokenList };

/** What the page body shows for the list query's current result. */
export function scimTokensView(input: {
  list: ScimTokenList | null;
  problem: ProblemDetails | null;
}): ScimTokensView {
  // A fresh problem wins over an older list: the session may have lost
  // step-up or the admin role since the list loaded.
  if (input.problem) {
    const kind = scimTokenProblemKind(input.problem);
    if (kind === "mfa-required" || kind === "forbidden" || kind === "not-available") {
      return {
        kind: "blocked",
        reason: kind,
        message: scimTokenProblemSentence(kind) ?? SCIM_TOKENS_LOAD_FAILED,
      };
    }
    if (!input.list) {
      return { kind: "error", problem: input.problem };
    }
  }
  if (!input.list) {
    return { kind: "loading" };
  }
  return { kind: "ready", list: input.list };
}

export type ScimTokenCreateAvailability =
  | { allowed: true; reason: null; message: null }
  | { allowed: false; reason: "not-configured" | "limit"; message: string };

/** Create is offered only below `maxActive` on a configured instance. */
export function scimTokenCreateAvailability(list: ScimTokenList): ScimTokenCreateAvailability {
  if (!list.configured) {
    return { allowed: false, reason: "not-configured", message: SCIM_TOKENS_NOT_CONFIGURED };
  }
  if (list.items.length >= list.maxActive) {
    return { allowed: false, reason: "limit", message: scimTokenLimitMessage(list.maxActive) };
  }
  return { allowed: true, reason: null, message: null };
}

export type ScimTokenCreateFailure =
  | { placement: "field"; message: string }
  | {
      placement: "notice";
      kind: "mfa-required" | "forbidden" | "not-available" | "not-configured" | "limit";
      message: string;
    }
  | { placement: "banner"; problem: ProblemDetails };

/** Where a failed create shows up in the dialog. */
export function scimTokenCreateFailure(
  problem: ProblemDetails,
  maxActive = SCIM_TOKENS_DEFAULT_MAX_ACTIVE,
): ScimTokenCreateFailure {
  const kind = scimTokenProblemKind(problem);
  if (kind === "field") {
    return { placement: "field", message: SCIM_TOKEN_NAME_INVALID_MESSAGE };
  }
  if (
    kind === "mfa-required" ||
    kind === "forbidden" ||
    kind === "not-available" ||
    kind === "not-configured" ||
    kind === "limit"
  ) {
    return {
      placement: "notice",
      kind,
      message: scimTokenProblemSentence(kind, maxActive) ?? SCIM_TOKENS_LOAD_FAILED,
    };
  }
  return { placement: "banner", problem };
}

/* ---------- destructive impact ---------- */

/** Impact rows for the revoke confirm. Ids avoid secret markers on purpose. */
export function scimTokenRevokeImpact(
  token: Pick<ScimToken, "displayName" | "createdAt" | "lastUsedAt">,
  options: { timeZone?: string } = {},
): DestructiveImpactItem[] {
  return sanitizeDestructiveImpact([
    { id: "scim-connection", label: "Token", detail: token.displayName },
    { id: "created", label: "Created", detail: formatScimTokenTime(token.createdAt, options) },
    { id: "last-used", label: "Last used", detail: scimTokenLastUsedLabel(token.lastUsedAt, options) },
  ]);
}
