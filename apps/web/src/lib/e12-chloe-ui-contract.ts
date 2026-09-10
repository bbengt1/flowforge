/**
 * E12.1 Chloe UI/embed verification checklist.
 *
 * Relates to #182 / Part of #181. Keep #182 open.
 *
 * Encodes the three Hit surfaces from
 * docs/reference/e12-security-verification.md § Chloe map:
 *   1. Embed exchange + replay in a real iframe (`/embed/v1` · EmbedExchangeGate)
 *   2. Session chrome (EmbedChrome, SessionStatusChip, SessionExpiryBanner)
 *   3. Expired approval banner (`/approvals` · ApprovalValidityBanner + Decide)
 *
 * Product chrome is unchanged — this file composes existing parsers,
 * ProblemBanner headings, and ADV-021 GET /session chrome. Do not
 * invent operator screens (SSRF, fencing, provider, provenance).
 */

import {
  approvalDecideControlsState,
  approvalValidityBannerState,
  type ApprovalDecideControlsState,
  type ApprovalValidityBannerState,
} from "./approval.ts";
import type { ApprovalRequest } from "./approval-types.ts";
import {
  ADV013_EMBED_ORIGIN,
  ADV013_PORTAL_ORIGIN,
  adv013CrossOriginIframeSrc,
} from "./adv013-cross-origin-contract.ts";
import {
  EMBED_ASSERTION_MESSAGE_TYPE,
  EMBED_ASSERTION_MESSAGE_VERSION,
  EMBED_COOKIE_CREDENTIALS,
  EMBED_EXCHANGE_PATH,
  EMBED_MOUNT_PREFIX,
  EMBED_PROBLEM_CODES,
  EMBED_REPLAY_MESSAGE,
  EMBED_SDK,
  assertionFromURL,
  buildEmbedExchangeBody,
  embedAuthFailureMessage,
  isAllowedEmbedMessageOrigin,
  parseEmbedAssertionMessage,
  parseEmbedHostDisplay,
} from "./embed-contract.ts";
import { problemBannerHeading } from "./problem.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  sessionExpiryBannerState,
  sessionStatusChipLabel,
  type SessionChromeSnapshot,
  type SessionExpiryBannerState,
} from "./session.ts";
import {
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  SESSION_EMBED_CHROME_SOURCE,
  embedChromeChipLabel,
  isSessionEmbedMode,
  parseSessionEmbedChrome,
  sessionEmbedChromeFromHostDisplay,
  type SessionEmbedChrome,
} from "./session-embed-contract.ts";

export const E12_CHLOE_STORY = 182;
export const E12_CHLOE_EPIC = 181;
export const E12_CHLOE_ID = "E12.1-chloe-ui" as const;

export const E12_CHLOE_RULES = {
  keep182Open: true,
  bodyOnlyExchange: true,
  assertionNotInUrl: true,
  replayIs409: true,
  chromeFromGetSession: true,
  ignoreHostQuery: true,
  existingExpiredChromeOnly: true,
  noNewOperatorScreens: true,
} as const;

export const E12_CHLOE_HARNESS = {
  evidenceDir: "docs/reference/e12-security-evidence",
  notes: "docs/reference/e12-security-evidence/chloe-ui.md",
  lastRun: "docs/reference/e12-security-evidence/chloe-ui-last-run.json",
  map: "docs/reference/e12-security-verification.md",
  tests: "apps/web/src/lib/e12-chloe-ui-contract.test.ts",
} as const;

export const E12_CHLOE_CHECKLIST = [
  "iframe-embed-v1-body-only-exchange",
  "postmessage-or-form-assertion",
  "replay-same-assertion-409",
  "session-chrome-from-get-session",
  "host-query-not-chrome",
  "existing-expired-revoked-session-chrome",
  "expired-approval-banner-decide-disabled",
] as const;

export type E12ChloeCheckId = (typeof E12_CHLOE_CHECKLIST)[number];

export const E12_CHLOE_HITS = [
  {
    id: "embed-exchange-replay",
    surface: "/embed/v1 · EmbedExchangeGate",
    route: EMBED_MOUNT_PREFIX,
    components: ["EmbedExchangeGate"],
    why: "Body-only assertion, replay 409, ADV-021 chrome from GET /session.",
    checkIds: [
      "iframe-embed-v1-body-only-exchange",
      "postmessage-or-form-assertion",
      "replay-same-assertion-409",
      "session-chrome-from-get-session",
      "host-query-not-chrome",
    ],
  },
  {
    id: "session-chrome",
    surface: "EmbedChrome, SessionStatusChip, SessionExpiryBanner",
    route: EMBED_MOUNT_PREFIX,
    components: ["EmbedChrome", "SessionStatusChip", "SessionExpiryBanner"],
    why: "Idle/absolute expiry and workspace-delete revoke are 401 → existing chrome.",
    checkIds: ["existing-expired-revoked-session-chrome"],
  },
  {
    id: "expired-approval",
    surface: "/approvals · ApprovalValidityBanner, ApprovalDecideControls",
    route: "/approvals",
    components: ["ApprovalValidityBanner", "ApprovalDecideControls"],
    why: "Expired approval cannot decide; banner + disabled controls.",
    checkIds: ["expired-approval-banner-decide-disabled"],
  },
] as const;

export const E12_CHLOE_SKIP = [
  "credentials",
  "script-revoke",
  "artifacts",
  "isolation",
  "webhook",
  "ssrf",
  "fencing",
  "provider",
  "provenance",
] as const;

const SAMPLE_JWS = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";

export function e12ChloeSampleAssertion(): string {
  return SAMPLE_JWS;
}

export function e12ChloeIframeSrc(input?: {
  embedOrigin?: string;
  leakedSearch?: string;
}): {
  src: string;
  mount: typeof EMBED_MOUNT_PREFIX;
  rejectedAssertion: boolean;
  displayOnly: true;
  assertionFromUrl: null;
} {
  const framed = adv013CrossOriginIframeSrc({
    embedOrigin: input?.embedOrigin ?? ADV013_EMBED_ORIGIN,
    leakedSearch: input?.leakedSearch,
  });
  return {
    src: framed.src,
    mount: EMBED_MOUNT_PREFIX,
    rejectedAssertion: framed.rejectedAssertion,
    displayOnly: true,
    assertionFromUrl: assertionFromURL(framed.src),
  };
}

export function e12ChloeHostAssertionMessage(
  assertion: string = SAMPLE_JWS,
): {
  type: typeof EMBED_ASSERTION_MESSAGE_TYPE;
  version: typeof EMBED_ASSERTION_MESSAGE_VERSION;
  assertion: string;
} {
  return {
    type: EMBED_ASSERTION_MESSAGE_TYPE,
    version: EMBED_ASSERTION_MESSAGE_VERSION,
    assertion,
  };
}

export function e12ChloeAcceptHostAssertion(
  data: unknown,
  origin: string,
  allowlist: readonly string[],
  selfOrigin?: string,
):
  | { accepted: false; via: null; assertion: "" }
  | { accepted: true; via: "postMessage"; assertion: string } {
  const parsed = parseEmbedAssertionMessage(data);
  if (!parsed) {
    return { accepted: false, via: null, assertion: "" };
  }
  if (
    !isAllowedEmbedMessageOrigin(origin, allowlist, {
      selfOrigin: selfOrigin ?? ADV013_EMBED_ORIGIN,
    })
  ) {
    return { accepted: false, via: null, assertion: "" };
  }
  return {
    accepted: true,
    via: "postMessage",
    assertion: parsed.assertion,
  };
}

export function e12ChloeFormAssertion(assertion: string): {
  via: "form";
  body: ReturnType<typeof buildEmbedExchangeBody>;
} {
  return {
    via: "form",
    body: buildEmbedExchangeBody(assertion),
  };
}

export function e12ChloeExchangeBody(assertion: string) {
  const body = buildEmbedExchangeBody(assertion);
  return {
    path: EMBED_EXCHANGE_PATH,
    credentials: EMBED_COOKIE_CREDENTIALS,
    sdk: EMBED_SDK,
    assertionIn: "body" as const,
    assertionInUrl: false,
    body,
  };
}

export function e12ChloeReplayProblem(requestId = "req-embed-replay"): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${EMBED_PROBLEM_CODES.replay}`,
    title: "Conflict",
    status: 409,
    detail: EMBED_REPLAY_MESSAGE,
    instance: EMBED_EXCHANGE_PATH,
    code: EMBED_PROBLEM_CODES.replay,
    request_id: requestId,
  };
}

export function e12ChloeReplayBanner(problem: ProblemDetails = e12ChloeReplayProblem()): {
  heading: string;
  detail: string;
  status: 409;
  role: "alert";
} {
  return {
    heading: problemBannerHeading(problem),
    detail: embedAuthFailureMessage(problem) || problem.detail,
    status: 409,
    role: "alert",
  };
}

export function e12ChloeSessionChrome(payload: unknown): {
  chrome: SessionEmbedChrome | null;
  source: typeof SESSION_EMBED_CHROME_SOURCE | null;
  chip: string | null;
  fromHostQuery: false;
} {
  const chrome = parseSessionEmbedChrome(payload);
  return {
    chrome,
    source: chrome?.source ?? null,
    chip: chrome && isSessionEmbedMode(chrome) ? embedChromeChipLabel(chrome) : null,
    fromHostQuery: false,
  };
}

export function e12ChloeHostQueryIsNotChrome(search: string): boolean {
  const display = parseEmbedHostDisplay(
    new URLSearchParams(search.replace(/^\?/, "")),
  );
  return sessionEmbedChromeFromHostDisplay(display) === null;
}

export function e12ChloeMissingSessionChromeMessage(): string {
  return EMBED_CHROME_MISSING_SESSION_MESSAGE;
}

export function e12ChloeSessionExpiryBanner(
  snapshot: SessionChromeSnapshot,
  now?: number,
): SessionExpiryBannerState {
  return sessionExpiryBannerState(snapshot, now);
}

export function e12ChloeSessionChip(
  snapshot: SessionChromeSnapshot,
  now?: number,
): string {
  return sessionStatusChipLabel(snapshot, now);
}

export function e12ChloeApprovalBanner(
  approval: ApprovalRequest,
  now?: number,
): ApprovalValidityBannerState {
  return approvalValidityBannerState(approval, now);
}

export function e12ChloeApprovalDecide(
  approval: ApprovalRequest,
  actorUserId: string,
  permissions?: string[] | null,
  now?: number,
): ApprovalDecideControlsState {
  return approvalDecideControlsState(approval, actorUserId, permissions, now);
}

export {
  ADV013_EMBED_ORIGIN,
  ADV013_PORTAL_ORIGIN,
  EMBED_MOUNT_PREFIX,
  EMBED_REPLAY_MESSAGE,
  SESSION_EMBED_CHROME_SOURCE,
};
