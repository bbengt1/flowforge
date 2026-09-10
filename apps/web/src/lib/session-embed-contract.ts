/**
 * ADV-021 embed-chrome adapter (Chloe UI) on jonny's #177 map.
 *
 * Thin UI retarget over `parseEmbedChromeFromSession` /
 * `EMBED_CHROME_FROM_SESSION`. EmbedChrome reads GET /session
 * `session.embed` only — not host query, catalog, peeked JWS, or
 * postMessage display. Do not change `apps/api`.
 *
 * Relates to #151 / Part of #130. Keep #151 open.
 */

import {
  EMBED_CHROME_FROM_SESSION,
  EMBED_CHROME_FROM_SESSION_HELP,
  EMBED_CHROME_FROM_SESSION_RULES,
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  parseEmbedChromeFromSession,
  type EmbedChromeFromSession,
  type EmbedHostDisplay,
} from "./embed-contract.ts";
import type { EmbedVerifiedWorkspace } from "./embed-tenancy-contract.ts";
import {
  SESSION_PATH,
  SESSION_REFRESH_PATH,
  sessionApiPath,
} from "./session-contract.ts";

export const SESSION_EMBED_STORY = 151;
export const SESSION_EMBED_EPIC = 130;
export const SESSION_EMBED_API_PR = 177;
export const SESSION_EMBED_ROUTE_MAP_SOURCE = "adv021-#177" as const;

export const SESSION_EMBED_GET_PATH = SESSION_PATH;
export const SESSION_EMBED_REFRESH_PATH = SESSION_REFRESH_PATH;

export {
  EMBED_CHROME_FROM_SESSION,
  EMBED_CHROME_FROM_SESSION_HELP,
  EMBED_CHROME_FROM_SESSION_RULES,
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  parseEmbedChromeFromSession,
};

/** Chrome bind is GET /session only. Exchange may set cookies; it is not chrome. */
export const SESSION_EMBED_CHROME_SOURCE = "get-session" as const;

export type SessionEmbedChromeSource = typeof SESSION_EMBED_CHROME_SOURCE;

export type SessionEmbedChrome = EmbedChromeFromSession & {
  source: SessionEmbedChromeSource;
};

export const SESSION_EMBED_RETARGET = {
  getSession: EMBED_CHROME_FROM_SESSION.path,
  embedShape:
    "session.embed {mode,sdk,tenantId,tenantSlug,tenantName,workbenchKey,workspaceId,workspaceName,capabilities} plus principal.display_name. #177 map.",
  parser: "parseEmbedChromeFromSession",
  notChrome: EMBED_CHROME_FROM_SESSION.doNotUse,
  refetch: EMBED_CHROME_FROM_SESSION.refetch,
  failClosed: EMBED_CHROME_FROM_SESSION.failClosed,
  capabilities: EMBED_CHROME_FROM_SESSION.fields.capabilities,
  routeMap: SESSION_EMBED_ROUTE_MAP_SOURCE,
} as const;

export const SESSION_EMBED_CHROME_RULES = {
  ...EMBED_CHROME_FROM_SESSION_RULES,
  driveFromGetSession: true,
  ignoreHostQuery: true,
  ignorePeekedAssertion: true,
  ignorePostMessageDisplay: true,
  exchangeSetsCookiesNotChrome: true,
} as const;

export const SESSION_EMBED_CHROME_HELP = EMBED_CHROME_FROM_SESSION_HELP;

export const SESSION_EMBED_WAITING_HELP =
  "Host identity is display-only until GET /session verifies session.embed.";

export const SESSION_EMBED_EXISTING_PATHS = [
  SESSION_PATH,
  SESSION_REFRESH_PATH,
] as const;

type SessionEmbedProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function eqSegments(segments: string[], expected: string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

/** Thin Next hop. GET /session is already on the identity allowlist. */
export const SESSION_EMBED_PROXY_ROUTES: readonly SessionEmbedProxyRoute[] = [
  { methods: ["GET"], match: (s) => eqSegments(s, ["session"]) },
  { methods: ["POST"], match: (s) => eqSegments(s, ["session", "refresh"]) },
];

export function isSessionEmbedProxySegments(segments: string[]): boolean {
  return SESSION_EMBED_PROXY_ROUTES.some((route) => route.match(segments));
}

/** Identity retarget — #177 did not remap GET /session. */
export function retargetSessionEmbedApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function sessionEmbedGetPath(): string {
  return sessionApiPath(SESSION_EMBED_GET_PATH);
}

export function isVerifiedSessionEmbedChrome(
  value: unknown,
): value is SessionEmbedChrome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const raw = value as SessionEmbedChrome;
  return (
    raw.source === SESSION_EMBED_CHROME_SOURCE &&
    raw.mode === "embed" &&
    Boolean(raw.tenantId?.trim()) &&
    Boolean(raw.workbenchKey?.trim())
  );
}

/** Embed mode is session.embed present (mode === "embed"), not pathname. */
export function isSessionEmbedMode(
  chrome: SessionEmbedChrome | null | undefined,
): chrome is SessionEmbedChrome {
  return isVerifiedSessionEmbedChrome(chrome);
}

/**
 * Parse chrome from GET /session (or refresh) via #177
 * `parseEmbedChromeFromSession`. Rejects host display, postMessage,
 * and peeked assertion shapes.
 */
export function parseSessionEmbedChrome(
  payload: unknown,
): SessionEmbedChrome | null {
  if (isPeekedAssertionChromeInput(payload) || isPostMessageDisplay(payload)) {
    return null;
  }
  if (isHostDisplayChromeInput(payload)) {
    return null;
  }
  const decision = parseEmbedChromeFromSession(payload);
  if (!decision.ok) {
    return null;
  }
  return { ...decision.chrome, source: SESSION_EMBED_CHROME_SOURCE };
}

export function sessionEmbedChromeFromPayload(
  payload: unknown,
): SessionEmbedChrome | null {
  return parseSessionEmbedChrome(payload);
}

/** Host query is never chrome. Always null. */
export function sessionEmbedChromeFromHostDisplay(
  _host: EmbedHostDisplay,
): null {
  void _host;
  return null;
}

/** Peeked JWS / assertion claims are never chrome. Always null. */
export function sessionEmbedChromeFromPeekedAssertion(
  _assertion: unknown,
): null {
  void _assertion;
  return null;
}

export function sessionEmbedChromeLabel(chrome: SessionEmbedChrome): string {
  const tenant = chrome.tenantSlug || chrome.tenantName || chrome.tenantId;
  return `${tenant} / ${chrome.workbenchKey}`;
}

export function sessionEmbedAsVerifiedWorkspace(
  chrome: SessionEmbedChrome,
): EmbedVerifiedWorkspace {
  return {
    audience: "flowforge",
    sdk: chrome.sdk.trim() || "embed.v1",
    tenantId: chrome.tenantId,
    tenantSlug: chrome.tenantSlug,
    workbenchKey: chrome.workbenchKey,
    workspaceId: chrome.workspaceId,
    workspaceName: chrome.workspaceName,
    capabilities: [...chrome.capabilities],
    source: "flowforge",
  };
}

export function capChromeCapabilities(
  granted: readonly string[] | null | undefined,
  chrome: SessionEmbedChrome | null,
): string[] | null {
  if (granted == null) {
    return null;
  }
  if (!chrome) {
    return null;
  }
  const allow = new Set(chrome.capabilities);
  return granted.filter((permission) => allow.has(permission));
}

function isHostDisplayChromeInput(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const raw = payload as Record<string, unknown>;
  if (raw.unverified === true) {
    return true;
  }
  if (raw.session || raw.embed) {
    return false;
  }
  const hostKeys = ["host", "tenant", "workbench", "displayName"];
  const hasHost = hostKeys.some((key) => typeof raw[key] === "string" && raw[key]);
  const hasSessionEmbedKeys =
    typeof raw.tenantId === "string" || typeof raw.workbenchKey === "string";
  return hasHost && !hasSessionEmbedKeys;
}

function isPostMessageDisplay(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const raw = payload as Record<string, unknown>;
  return raw.type === "flowforge.embed.assertion";
}

function isPeekedAssertionChromeInput(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const raw = payload as Record<string, unknown>;
  if (raw.session || raw.embed) {
    return false;
  }
  if (typeof raw.assertion === "string" && raw.assertion.includes(".")) {
    return true;
  }
  const claimKeys = ["iss", "aud", "jti", "nbf", "exp", "sub"];
  const claimHits = claimKeys.filter((key) => key in raw).length;
  return claimHits >= 2;
}
