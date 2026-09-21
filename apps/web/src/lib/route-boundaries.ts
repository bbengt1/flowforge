/**
 * G.0.4: Web error / loading / not-found boundaries.
 *
 * Relates to #407 / Part of #402. Keep #402 open. Keep #401 open.
 * Finding F1 — S1. Chloe UI only.
 *
 * Root `global-error.tsx` + segment `error.tsx` with Try again.
 * `loading.tsx` and `not-found.tsx` on primary App Router segments.
 * Same files serve standalone and `/embed/v1` (rewrite) — no second tree.
 *
 * Hard lines: ADV-021 cold embed fail-closed unchanged (no Login /
 * wizard / Change-password on embed) · V.1 tokens · no second design
 * system · drafts never run · vault metadata-only.
 */

import { EMBED_CHROME_MISSING_SESSION_MESSAGE, EMBED_MOUNT_PREFIX } from "./embed-contract.ts";
import {
  R7_HARD_LINE,
  rewriteEmbedAdv021Unchanged,
  rewriteEmbedAdv024Unchanged,
} from "./rewrite-embed-mount.ts";
import {
  embedWorkflowsHomeHref,
  ROUTE_BOUNDARY_ACTION_CLASS,
  ROUTE_BOUNDARY_HEADING_CLASS,
  ROUTE_BOUNDARY_HELP_CLASS,
  ROUTE_BOUNDARY_PANEL_CLASS,
  ROUTE_BOUNDARY_SHELL_CLASS,
  ROUTE_ERROR_RETRY_LABEL,
  ROUTE_NOT_FOUND_HOME_HREF,
  routeNotFoundHomeHref,
} from "./route-boundary-chrome.ts";
import {
  n8nOrangePresent,
  secondThemeTreePresent,
  VISUAL_TOKENS,
} from "./visual-tokens.ts";

export {
  embedWorkflowsHomeHref,
  ROUTE_BOUNDARY_ACTION_CLASS,
  ROUTE_BOUNDARY_ATTR,
  ROUTE_BOUNDARY_ERROR_VALUE,
  ROUTE_BOUNDARY_HEADING_CLASS,
  ROUTE_BOUNDARY_HELP_CLASS,
  ROUTE_BOUNDARY_LOADING_VALUE,
  ROUTE_BOUNDARY_NOT_FOUND_VALUE,
  ROUTE_BOUNDARY_PANEL_CLASS,
  ROUTE_BOUNDARY_SHELL_CLASS,
  ROUTE_BOUNDARY_SKELETON_CLASS,
  ROUTE_ERROR_DIGEST_LABEL,
  ROUTE_ERROR_HEADING,
  ROUTE_ERROR_HELP,
  ROUTE_ERROR_RETRY_LABEL,
  ROUTE_LOADING_LABEL,
  ROUTE_NOT_FOUND_HEADING,
  ROUTE_NOT_FOUND_HELP,
  ROUTE_NOT_FOUND_HOME_HREF,
  ROUTE_NOT_FOUND_HOME_LABEL,
  routeErrorDigest,
  routeNotFoundHomeHref,
} from "./route-boundary-chrome.ts";

export const G04_STORY = 407;
export const G04_PHASE = 402;
export const G04_EPIC = 401;
export const G04_KEEP_PHASE_OPEN = true;
export const G04_KEEP_EPIC_OPEN = true;
export const G04_ID = "G.0.4-route-boundaries" as const;
export const G04_FINDING = "F1" as const;
export const G04_BRIEF = "docs/internal/claude-code-gap-analysis.md";

export const G04_HELP =
  "Root global-error.tsx and segment error.tsx offer Try again plus a digest. loading.tsx and not-found.tsx cover primary App Router segments. V.1 tokens only. /embed/v1 still fail-closes without session.embed. Login, the first-run wizard, and Change-password never mount on embed.";

export const ROUTE_BOUNDARIES = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  findingF1: true,
  rootGlobalError: true,
  segmentErrorWithRetry: true,
  loadingOnPrimarySegments: true,
  notFoundOnPrimarySegments: true,
  sameFilesStandaloneAndEmbed: true,
  noSecondEmbedTree: true,
  noSecondDesignSystem: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv021FailClosedUnchanged: true,
  noLoginOnEmbed: true,
  noWizardOnEmbed: true,
  noChangePasswordOnEmbed: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  noGreenfieldApis: true,
  noJonnyChange: true,
  keep402Open: true,
  keep401Open: true,
} as const;

/** Product folders that need their own loading + not-found (rewrite covers /embed/v1). */
export const PRIMARY_APP_SEGMENTS = [
  "workflows",
  "executions",
  "credentials",
  "approvals",
  "alerts",
  "config",
  "actions",
  "templates",
  "settings",
  "audit",
  "membership",
  "isolation",
] as const;

export type PrimaryAppSegment = (typeof PRIMARY_APP_SEGMENTS)[number];

export const ROOT_BOUNDARY_FILES = [
  "src/app/global-error.tsx",
  "src/app/error.tsx",
  "src/app/loading.tsx",
  "src/app/not-found.tsx",
] as const;

export const PRIMARY_SEGMENT_LOADING_FILES = PRIMARY_APP_SEGMENTS.map(
  (segment) => `src/app/${segment}/loading.tsx` as const,
);

export const PRIMARY_SEGMENT_NOT_FOUND_FILES = PRIMARY_APP_SEGMENTS.map(
  (segment) => `src/app/${segment}/not-found.tsx` as const,
);

export const ROUTE_BOUNDARY_FILES = [
  ...ROOT_BOUNDARY_FILES,
  ...PRIMARY_SEGMENT_LOADING_FILES,
  ...PRIMARY_SEGMENT_NOT_FOUND_FILES,
] as const;

export const ROUTE_BOUNDARY_CHROME_SOURCES = [
  "src/lib/route-boundaries.ts",
  "src/lib/route-boundary-chrome.ts",
  "src/components/chrome/RouteErrorPanel.tsx",
  "src/components/chrome/RouteLoadingFallback.tsx",
  "src/components/chrome/RouteNotFound.tsx",
  ...ROUTE_BOUNDARY_FILES,
] as const;

export const STANDALONE_ONLY_CHROME_TOKENS = [
  "LoginLanding",
  "LoginChrome",
  "FirstRunWizard",
  "ChangePasswordLanding",
  "ChangePasswordChrome",
  "MustChangePasswordGate",
  "SignedOutGate",
  'href="/login"',
  'href="/change-password"',
] as const;

export const INVENTED_EMBED_BOUNDARY_FILES = [
  "src/app/embed/error.tsx",
  "src/app/embed/loading.tsx",
  "src/app/embed/not-found.tsx",
  "src/app/embed/global-error.tsx",
  "src/app/embed/v1/page.tsx",
  "src/app/embed/v1/error.tsx",
  "src/app/embed/v1/loading.tsx",
  "src/app/embed/v1/not-found.tsx",
] as const;

export const ROUTE_BOUNDARY_AUTO_CLOSE_TOKENS = [
  "Fixes #402",
  "Closes #402",
  "Fixes #401",
  "Closes #401",
  "Resolve #402",
  "Resolve #401",
] as const;

export function boundaryOmitsStandaloneAuthChrome(source: string): boolean {
  return STANDALONE_ONLY_CHROME_TOKENS.every((token) => !source.includes(token));
}

export function boundaryWiresReset(source: string): boolean {
  return source.includes("reset") && source.includes("RouteErrorPanel");
}

export function boundaryHasRetry(source: string): boolean {
  return (
    source.includes("reset") &&
    source.includes(ROUTE_ERROR_RETRY_LABEL) &&
    /onClick=\{/.test(source)
  );
}

export function globalErrorDefinesDocument(source: string): boolean {
  return (
    source.includes("<html") &&
    source.includes("<body") &&
    source.includes("globals.css") &&
    source.includes("FF_SHELL_ROOT_CLASS") &&
    source.includes("FF_SHELL_ROOT_VALUE")
  );
}

export function boundaryUsesV1Tokens(source: string): boolean {
  const consumesTokens =
    source.includes("var(--ff-") ||
    source.includes("FF_SHELL_ROOT") ||
    source.includes("ff-shell") ||
    source.includes("ff-overview") ||
    source.includes("ROUTE_BOUNDARY_") ||
    source.includes("RouteErrorPanel") ||
    source.includes("RouteLoadingFallback") ||
    source.includes("AppRouteNotFound");
  return (
    consumesTokens &&
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source)
  );
}

export function routeBoundariesHoldHardLines(): boolean {
  return (
    ROUTE_BOUNDARIES.yamlIsSourceOfTruth &&
    ROUTE_BOUNDARIES.draftsNeverRun &&
    ROUTE_BOUNDARIES.vaultDisplayNameUuidOnly &&
    ROUTE_BOUNDARIES.adv021ChromeFromSessionEmbedOnly &&
    ROUTE_BOUNDARIES.adv021FailClosedUnchanged &&
    ROUTE_BOUNDARIES.noLoginOnEmbed &&
    ROUTE_BOUNDARIES.noWizardOnEmbed &&
    ROUTE_BOUNDARIES.noChangePasswordOnEmbed &&
    ROUTE_BOUNDARIES.noSecondEmbedTree &&
    ROUTE_BOUNDARIES.noSecondDesignSystem &&
    ROUTE_BOUNDARIES.inheritV1Tokens &&
    ROUTE_BOUNDARIES.keep402Open &&
    ROUTE_BOUNDARIES.keep401Open &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    rewriteEmbedAdv021Unchanged() &&
    rewriteEmbedAdv024Unchanged() &&
    EMBED_MOUNT_PREFIX === "/embed/v1" &&
    EMBED_CHROME_MISSING_SESSION_MESSAGE.includes("session.embed") &&
    ROUTE_BOUNDARY_SHELL_CLASS.includes("max-w-6xl") &&
    ROUTE_BOUNDARY_HEADING_CLASS.includes("text-3xl") &&
    ROUTE_BOUNDARY_HELP_CLASS.includes("ff-shell-muted") &&
    ROUTE_BOUNDARY_PANEL_CLASS.includes("ff-shell-panel") &&
    ROUTE_BOUNDARY_ACTION_CLASS.includes("ff-overview-create") &&
    routeNotFoundHomeHref(false) === ROUTE_NOT_FOUND_HOME_HREF &&
    routeNotFoundHomeHref(true) === embedWorkflowsHomeHref()
  );
}

export function routeBoundaryDocsHeld(frontend: string): boolean {
  return (
    frontend.includes("G.0.4") &&
    frontend.includes("#407") &&
    frontend.includes("keep #402 open") &&
    frontend.includes("global-error.tsx") &&
    frontend.includes("error.tsx") &&
    frontend.includes("loading.tsx") &&
    frontend.includes("not-found.tsx") &&
    frontend.includes("ADV-021") &&
    ROUTE_BOUNDARY_AUTO_CLOSE_TOKENS.every((token) => !frontend.includes(token))
  );
}
