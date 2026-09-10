/**
 * ADV-013 cross-origin Portal adapter checklist (Chloe + harness).
 *
 * Relates to #144 / Part of #130. Keep #144 open until evidence is reviewed.
 *
 * This is the CI-encoded checklist for a real two-origin run:
 * Portal host origin ≠ embed origin, shared ADV-011 allowlist,
 * body-only exchange, ADV-007 CHIPS, fail-closed negatives.
 * Product authz is unchanged — this file does not weaken CHIPS,
 * SameSite, or allowlists.
 */

import {
  EMBED_CHIPS_RULES,
  EMBED_CHIPS_SET_COOKIE,
  EMBED_COOKIE_CREDENTIALS,
  EMBED_EXCHANGE_PATH,
  EMBED_HOST_ALLOWLIST_RULES,
  EMBED_MOUNT_PREFIX,
  EMBED_SDK,
  assertionFromURL,
  embedHostAllowlist,
  frameAncestorsForPath,
  isAllowedEmbedMessageOrigin,
} from "./embed-contract.ts";
import {
  PORTAL_MINT_PATH,
  buildCrossOriginPortalEmbedSrc,
  isDistinctOriginPair,
  normalizeExactOrigin,
  portalHostDisplay,
  portalUrlContainsAssertion,
} from "./portal-adapter-contract.ts";

export const ADV013_STORY = 144;
export const ADV013_EPIC = 130;
export const ADV013_ID = "ADV-013" as const;

/** Documented local HTTPS pair (eTLD+1 differs: portal.test vs embed.test). */
export const ADV013_PORTAL_ORIGIN = "https://portal.test:8443";
export const ADV013_EMBED_ORIGIN = "https://embed.test:8444";
export const ADV013_EVIL_ORIGIN = "https://evil.test:8445";

export const ADV013_HARNESS = {
  composeOverlay: "deploy/adv013/docker-compose.yml",
  script: "scripts/adv013-cross-origin.sh",
  portalHost: "deploy/adv013/portal-host",
  evidenceDir: "docs/reference/adv-013-evidence",
  docs: "docs/reference/portal-adapter.md",
} as const;

export const ADV013_CHECKLIST = [
  "distinct-https-origins",
  "portal-entry",
  "mint-via-adapter",
  "frame-embed-v1-allowlisted-ancestors",
  "body-only-exchange",
  "chips-credentials-include",
  "postmessage-allowlisted-only",
  "hostile-ancestor-blocked",
  "assertion-in-url-rejected",
  "empty-allowlist-fail-closed",
] as const;

export type Adv013CheckId = (typeof ADV013_CHECKLIST)[number];

/** In-repo /portal/workflows is same-origin. Production Portal is not. */
export const ADV013_CHLOE_GAPS = [
  {
    id: "same-origin-demo",
    surface: "/portal/workflows",
    gap: "PortalHost iframes a relative /embed/v1 src and postMessages window.location.origin. That is same-origin only.",
    do: "On a real Portal host, iframe the absolute embed origin and call deliverCrossOriginPortalAssertion({embedOrigin, portalOrigin, allowlist}).",
  },
  {
    id: "shared-allowlist-on-both-processes",
    surface: "WEB_PORTAL_FRAME_ANCESTORS / PORTAL_FRAME_ANCESTORS",
    gap: "Catalog frameAncestors comes from the API process; Next CSP comes from the web process.",
    do: "Set the same Portal HTTPS origin on API and web. Do not use NEXT_PUBLIC_EMBED_FRAME_ANCESTORS.",
  },
  {
    id: "explicit-exchange-click",
    surface: "EmbedExchangeGate",
    gap: "Allowlisted postMessage fills the assertion field; exchange is still an explicit POST /embed/exchange (body only).",
    do: "Keep credentials:include. Auto-exchange is optional host UX — do not put the JWS in the URL.",
  },
  {
    id: "chips-https",
    surface: "CHIPS ff_session / ff_csrf",
    gap: "SameSite=None; Secure; Partitioned requires two HTTPS origins and a Partitioned-capable browser.",
    do: "Terminate TLS in front of the embed origin. Do not drop Secure or Partitioned. Cookie not sent is 401/403.",
  },
] as const;

export const ADV013_RULES = {
  portalOriginNotEmbedOrigin: true,
  httpsRequired: true,
  sharedAllowlistWithAdv011: true,
  nextPublicIsNotASource: EMBED_HOST_ALLOWLIST_RULES.nextPublicIsNotASource,
  bodyOnlyExchange: true,
  assertionNotInUrl: true,
  chipsSameSiteNoneSecurePartitioned: true,
  credentialsInclude: true,
  emptyAllowlistFailsClosed: true,
  hostileAncestorBlocked: true,
  keep144Open: true,
} as const;

export function adv013Origins(): {
  portal: string;
  embed: string;
  evil: string;
  distinct: boolean;
} {
  return {
    portal: ADV013_PORTAL_ORIGIN,
    embed: ADV013_EMBED_ORIGIN,
    evil: ADV013_EVIL_ORIGIN,
    distinct: isDistinctOriginPair(ADV013_PORTAL_ORIGIN, ADV013_EMBED_ORIGIN),
  };
}

export function adv013HostEnv(portalOrigin: string = ADV013_PORTAL_ORIGIN): {
  WEB_PORTAL_FRAME_ANCESTORS: string;
  PORTAL_FRAME_ANCESTORS: string;
} {
  const origin = normalizeExactOrigin(portalOrigin);
  return {
    WEB_PORTAL_FRAME_ANCESTORS: origin,
    PORTAL_FRAME_ANCESTORS: origin,
  };
}

export function adv013FrameAncestors(env = adv013HostEnv()): string {
  return frameAncestorsForPath(EMBED_MOUNT_PREFIX, env);
}

export function adv013HostileAncestorBlocked(
  env = adv013HostEnv(),
  evil: string = ADV013_EVIL_ORIGIN,
): boolean {
  const allow = embedHostAllowlist(env);
  return (
    !isAllowedEmbedMessageOrigin(evil, allow, { selfOrigin: evil }) &&
    !adv013FrameAncestors(env).includes(evil)
  );
}

export function adv013EmptyAllowlistFailsClosed(): boolean {
  const empty = embedHostAllowlist({});
  return (
    empty.length === 0 &&
    frameAncestorsForPath(EMBED_MOUNT_PREFIX, {}) === "'none'" &&
    isAllowedEmbedMessageOrigin(ADV013_PORTAL_ORIGIN, empty) === false &&
    isAllowedEmbedMessageOrigin(ADV013_EMBED_ORIGIN, empty) === false
  );
}

export function adv013CrossOriginIframeSrc(input?: {
  embedOrigin?: string;
  leakedSearch?: string;
}): { src: string; rejectedAssertion: boolean; displayOnly: true } {
  return buildCrossOriginPortalEmbedSrc({
    embedOrigin: input?.embedOrigin ?? ADV013_EMBED_ORIGIN,
    routeId: "workflows",
    display: portalHostDisplay({
      host: "ADV-013 Portal",
      tenant: "acme",
      workbench: "ops",
    }),
    leakedSearch: input?.leakedSearch,
  });
}

export const ADV013_PATHS = {
  mint: `/api/v1${PORTAL_MINT_PATH}`,
  exchange: `/api/v1${EMBED_EXCHANGE_PATH}`,
  mount: `${EMBED_MOUNT_PREFIX}/workflows`,
  catalog: "/api/v1/portal/adapter",
  embedCatalog: "/api/v1/embed/catalog",
} as const;

export const ADV013_EXCHANGE_BODY = {
  sdk: EMBED_SDK,
  assertionIn: "body" as const,
  assertionInUrl: false,
};

export const ADV013_CHIPS = {
  credentials: EMBED_COOKIE_CREDENTIALS,
  setCookie: EMBED_CHIPS_SET_COOKIE,
  partitioned: EMBED_CHIPS_RULES.partitioned,
  secure: EMBED_CHIPS_RULES.secure,
  sameSite: EMBED_CHIPS_RULES.sameSite,
} as const;

export function adv013AssertionFromUrlIsRejected(url: string): boolean {
  return assertionFromURL(url) === null && portalUrlContainsAssertion(url);
}
