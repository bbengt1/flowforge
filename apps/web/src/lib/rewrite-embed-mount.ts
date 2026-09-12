/**
 * R7.1: Rewrite chrome on /embed/v1 + session.embed.
 *
 * Relates to #276 / Part of #233. Keep #276 open.
 *
 * Chloe UI only. Densify the existing embed shell in place (D6).
 * R2–R6 rewrite chrome mounts on the same `/embed/v1` rewrite as
 * standalone — no second embed tree, no Portal DB share, no new origin.
 *
 * ADV-021: chrome waits for GET /session `session.embed` and fail-closes
 * on `/embed/v1` without it. Host `?tenant=` / `?workbench=` is never
 * authorization. CHIPS (`SameSite=None; Secure; Partitioned`) and
 * host-issuer bind stay intact. ADV-024 grant gating is not weakened
 * (R7.2 owns membership reshape).
 *
 * jonny standby: no embed boundary moved. Document gaps; do not invent
 * contracts.
 */

import { canvasHistoryEmbedUnchanged } from "./editor-canvas-history.ts";
import { canvasLayoutEmbedUnchanged } from "./editor-canvas-layout.ts";
import { canvasPrimitivesEmbedUnchanged } from "./editor-canvas-primitives.ts";
import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import { credentialEmbedRoutesUnchanged } from "./editor-credential.ts";
import { actionsEmbedRouteUnchanged } from "./editor-library.ts";
import { ndvEmbedPathUnchanged } from "./editor-ndv.ts";
import { ndvMappingEmbedUnchanged } from "./editor-ndv-mapping.ts";
import { ndvParametersEmbedUnchanged } from "./editor-ndv-parameters.ts";
import { ndvRunIoEmbedRoutesUnchanged } from "./editor-ndv-run-io.ts";
import { ndvValidationEmbedUnchanged } from "./editor-ndv-validation.ts";
import { editorRunsEmbedRoutesUnchanged } from "./editor-runs.ts";
import { credentialNdvEmbedUnchanged } from "./credential-ndv-add.ts";
import { credentialDetailEmbedUnchanged } from "./credential-detail.ts";
import { credentialVaultEmbedUnchanged } from "./credential-vault.ts";
import {
  EMBED_CATALOG_MEMBERSHIP_ISOLATION,
  EMBED_CATALOG_MEMBERSHIP_ISOLATION_RULES,
  EMBED_CHIPS_RULES,
  EMBED_CHIPS_SET_COOKIE,
  EMBED_CHROME_FROM_SESSION_RULES,
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  EMBED_HOST_ALLOWLIST_RULES,
  EMBED_HOST_ISSUER_RULES,
  EMBED_MEMBERSHIP_ISOLATION_GRANT_CAPS,
  EMBED_MOUNT_PREFIX,
  EMBED_ROUTES,
  catalogRoutesForGrant,
  frameAncestorsForPath,
  grantsMembershipIsolationCatalog,
} from "./embed-contract.ts";
import { executionInboxEmbedUnchanged } from "./execution-inbox.ts";
import { homeActivationEmbedUnchanged } from "./home-activation.ts";
import {
  isSessionEmbedMode,
  parseSessionEmbedChrome,
  sessionEmbedChromeFromHostDisplay,
  sessionEmbedChromeFromPeekedAssertion,
  type SessionEmbedChrome,
} from "./session-embed-contract.ts";
import { editorWorkspaceNav } from "./workspace-nav.ts";

export const R71_STORY = 276;
export const R71_EPIC = 233;
export const R71_KEEP_STORY_OPEN = true;

export const REWRITE_EMBED_MOUNT_PREFIX = EMBED_MOUNT_PREFIX;
export const REWRITE_EMBED_MOUNT_ATTR = "data-rewrite-embed-mount";
export const REWRITE_EMBED_TOOLS_ATTR = "data-rewrite-embed-tools";

export const REWRITE_EMBED_MOUNT_HELP =
  "R2–R6 rewrite chrome mounts on this /embed/v1 tree after GET /session session.embed. Same pages as standalone — no second embed tree. Host query is never authorization.";

export const REWRITE_EMBED_FAIL_CLOSED_HELP = EMBED_CHROME_MISSING_SESSION_MESSAGE;

export const JONNY_R71_NOTE =
  "No embed boundary moved. CHIPS, host-issuer bind, ADV-021 session.embed, and ADV-024 grant gating stay. Chrome migrates in place on the existing /embed/v1 rewrite. Do not invent a second tree, Portal cookie, or host-query authz.";

/**
 * Gracie + jonny R7 hard line — bake into R7.1 / #276.
 * Inherit on R7.2 / #277, R7.3 / #278, and R7.4 / #279. Do not weaken.
 */
export const R7_HARD_LINE = {
  adv021ChromeFromSessionEmbedOnly: true,
  adv021FailClosedWithoutSessionEmbedOnEmbedV1: true,
  adv024MembershipIsolationStayGrantGated: true,
  adv024ReshapeIsR72DoNotWeakenGrant: true,
  hostQueryDisplayOnlyNeverAuthorization: true,
  noSecondEmbedTreeSameMountsAsStandalone: true,
  doNotWeakenIssuerFailClosed: true,
  doNotWeakenFrameAncestorFailClosed: true,
  jonnyOnlyIfBoundaryMoves: true,
  boundaryMustNotMove: true,
} as const;

export const R7_HARD_LINE_HELP =
  "ADV-021: embed chrome from session.embed only — fail closed without it on /embed/v1. ADV-024: membership/isolation stay grant-gated (reshape is R7.2; do not weaken the grant). Host query (?tenant= / ?workbench=) is display-only — never authorization. No second embed tree — same /embed/v1 mounts as standalone. Do not weaken issuer / frame-ancestor fail-closed. Ping jonny only if an embed/ADV boundary actually moves — it should not.";

/**
 * Later R7 stories inherit the hard line. Do not pull them into this mount.
 */
export const R7_LATER_STORY_NOTES = {
  r72: "R7.2 / #277: membership reshape. Inherit R7 hard line — ADV-024 stays grant-gated; do not weaken the grant.",
  r73: "R7.3 / #278: local seed and ops docs. Inherit R7 hard line. Out of scope for this mount.",
  r74: "R7.4 / #279: E12.3 a11y extend. Inherit R7 hard line. Out of scope for this mount.",
} as const;

export const REWRITE_EMBED_MOUNT = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  d6MigrateInPlace: true,
  sameMountsAsStandalone: true,
  noSecondEmbedTree: true,
  noNewEmbedOrigin: true,
  noPortalDbShare: true,
  noAppsApiChanges: true,
  adv021WaitForSessionEmbed: true,
  adv021FailClosedWithoutSessionEmbed: true,
  hostQueryNeverAuthorization: true,
  hostTenantWorkbenchNeverAuthorization: true,
  chipsSameSiteNoneSecurePartitioned: true,
  chipsUnchanged: true,
  hostIssuerBindUnchanged: true,
  frameAncestorFailClosedUnchanged: true,
  adv024GrantGatingUnchanged: true,
  adv024ReshapeIsR72: true,
  mountSearchAndCommandsAfterSessionEmbed: true,
  productPagesAreCanonicalRewrite: true,
  jonnyStandbyOnlyIfBoundaryMoves: true,
  boundaryMoved: false,
  doNotInventContracts: true,
} as const;

export const REWRITE_EMBED_SHELL_TOOLS = ["search", "commands"] as const;

export const INVENTED_EMBED_TREES = [
  "/studio",
  "/embed/v2",
  "/embed/rewrite",
  "/embed/r7",
  "/n8n",
] as const;

export const REWRITE_EMBED_SURFACES = [
  { id: "r2.1-library", routeId: "workflow", check: "actionsEmbedRouteUnchanged" },
  { id: "r2.2-inspector", routeId: "workflow", check: "ndvEmbedPathUnchanged" },
  { id: "r2.3-undo-redo", routeId: "workflow", check: "canvasHistoryEmbedUnchanged" },
  { id: "r2.4-fit-snap", routeId: "workflow", check: "canvasPrimitivesEmbedUnchanged" },
  { id: "r2.5-layout", routeId: "workflow", check: "canvasLayoutEmbedUnchanged" },
  { id: "r3.1-ndv-parameters", routeId: "workflow", check: "ndvParametersEmbedUnchanged" },
  { id: "r3.2-ndv-mapping", routeId: "workflow", check: "ndvMappingEmbedUnchanged" },
  { id: "r3.3-ndv-validation", routeId: "workflow", check: "ndvValidationEmbedUnchanged" },
  { id: "r4.1-executions-inbox", routeId: "executions", check: "executionInboxEmbedUnchanged" },
  { id: "r4.2-runs-overlay", routeId: "workflow", check: "editorRunsEmbedRoutesUnchanged" },
  { id: "r4.3-ndv-run-io", routeId: "workflow", check: "ndvRunIoEmbedRoutesUnchanged" },
  { id: "r5.1-vault-find", routeId: "credentials", check: "credentialVaultEmbedUnchanged" },
  { id: "r5.2-credential-detail", routeId: "credential", check: "credentialDetailEmbedUnchanged" },
  { id: "r5.3-ndv-add-credential", routeId: "credentialNew", check: "credentialNdvEmbedUnchanged" },
  { id: "r6.1-editor-activation", routeId: "workflow", check: "editorEmbedRouteUnchanged" },
  { id: "r6.2-home-activation", routeId: "workflows", check: "homeActivationEmbedUnchanged" },
  { id: "r6.3-test-run", routeId: "workflow", check: "editorEmbedRouteUnchanged" },
] as const;

export const REWRITE_EMBED_MOUNT_SOURCES = [
  "src/lib/rewrite-embed-mount.ts",
  "src/components/embed/EmbedChrome.tsx",
  "src/components/shell/WorkspaceShell.tsx",
  "next.config.ts",
] as const;

export type RewriteEmbedMountState = "waiting" | "closed" | "open";

export type RewriteEmbedProductState =
  | "waiting"
  | "exchange"
  | "mismatch"
  | "mount";

export function rewriteEmbedMountState(input: {
  sessionChecked: boolean;
  sessionActive: boolean;
  sessionEmbed: SessionEmbedChrome | null;
}): RewriteEmbedMountState {
  if (!input.sessionChecked) {
    return "waiting";
  }
  if (input.sessionActive && isSessionEmbedMode(input.sessionEmbed)) {
    return "open";
  }
  return "closed";
}

export function rewriteEmbedProductChildrenState(input: {
  sessionChecked: boolean;
  sessionActive: boolean;
  sessionEmbed: SessionEmbedChrome | null;
  verified: boolean;
  tenancyMismatch?: boolean;
}): RewriteEmbedProductState {
  if (!input.sessionChecked) {
    return "waiting";
  }
  if (
    input.sessionActive &&
    isSessionEmbedMode(input.sessionEmbed) &&
    input.verified
  ) {
    return input.tenancyMismatch ? "mismatch" : "mount";
  }
  return "exchange";
}

export function rewriteEmbedShellToolsVisible(
  state: RewriteEmbedMountState,
): boolean {
  return state === "open";
}

export function rewriteEmbedChromeMayMount(
  sessionEmbed: SessionEmbedChrome | null,
): boolean {
  return isSessionEmbedMode(sessionEmbed);
}

export function rewriteEmbedHostQueryNeverAuthorizes(host: unknown): boolean {
  return (
    sessionEmbedChromeFromHostDisplay(
      host as Parameters<typeof sessionEmbedChromeFromHostDisplay>[0],
    ) === null && parseSessionEmbedChrome(host) === null
  );
}

export function rewriteEmbedPeekedAssertionNeverAuthorizes(peeked: {
  iss?: string;
  tenant_id?: string;
  workbench_key?: string;
  capabilities?: string[];
}): boolean {
  return sessionEmbedChromeFromPeekedAssertion(peeked) === null;
}

export function rewriteEmbedChipsUnchanged(): boolean {
  return (
    EMBED_CHIPS_SET_COOKIE === "SameSite=None; Secure; Partitioned" &&
    EMBED_CHIPS_RULES.partitioned &&
    EMBED_CHIPS_RULES.secure &&
    EMBED_CHIPS_RULES.sameSite === "None" &&
    EMBED_CHIPS_RULES.neverDropSecure &&
    EMBED_CHIPS_RULES.neverSameSiteNoneWithoutPartitioned &&
    EMBED_CHIPS_RULES.neverWeakenTopLevelSameSite &&
    REWRITE_EMBED_MOUNT.chipsUnchanged
  );
}

export function rewriteEmbedHostIssuerBindUnchanged(): boolean {
  return (
    EMBED_HOST_ISSUER_RULES.bindIssToMintingHost &&
    EMBED_HOST_ISSUER_RULES.neverPeekIssFromAssertion &&
    EMBED_HOST_ISSUER_RULES.headersAreOptionalConsistency &&
    EMBED_HOST_ISSUER_RULES.wrongIssuerForHostIs403 &&
    EMBED_HOST_ISSUER_RULES.nextPublicIsNotASource &&
    R7_HARD_LINE.doNotWeakenIssuerFailClosed &&
    REWRITE_EMBED_MOUNT.hostIssuerBindUnchanged
  );
}

export function rewriteEmbedFrameAncestorFailClosedUnchanged(): boolean {
  return (
    EMBED_HOST_ALLOWLIST_RULES.emptyFailsClosed &&
    EMBED_HOST_ALLOWLIST_RULES.noWildcard &&
    EMBED_HOST_ALLOWLIST_RULES.nextPublicIsNotASource &&
    frameAncestorsForPath("/embed/v1", {}) === "'none'" &&
    frameAncestorsForPath("/workflows", {
      WEB_EMBED_FRAME_ANCESTORS: "https://evil.example",
    }) === "'none'" &&
    R7_HARD_LINE.doNotWeakenFrameAncestorFailClosed &&
    REWRITE_EMBED_MOUNT.frameAncestorFailClosedUnchanged
  );
}

export function rewriteEmbedHoldsR7HardLine(): boolean {
  return (
    REWRITE_EMBED_MOUNT.inheritR7HardLine &&
    R7_HARD_LINE.adv021ChromeFromSessionEmbedOnly &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated &&
    R7_HARD_LINE.adv024ReshapeIsR72DoNotWeakenGrant &&
    R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization &&
    R7_HARD_LINE.noSecondEmbedTreeSameMountsAsStandalone &&
    R7_HARD_LINE.doNotWeakenIssuerFailClosed &&
    R7_HARD_LINE.doNotWeakenFrameAncestorFailClosed &&
    R7_HARD_LINE.jonnyOnlyIfBoundaryMoves &&
    R7_HARD_LINE.boundaryMustNotMove
  );
}

export function rewriteEmbedAdv021Unchanged(): boolean {
  return (
    EMBED_CHROME_FROM_SESSION_RULES.sessionIsAuthority &&
    EMBED_CHROME_FROM_SESSION_RULES.failClosedWithoutEmbedBinding &&
    EMBED_CHROME_FROM_SESSION_RULES.noHostQueryAuthority &&
    REWRITE_EMBED_MOUNT.adv021WaitForSessionEmbed &&
    REWRITE_EMBED_MOUNT.adv021FailClosedWithoutSessionEmbed
  );
}

export function rewriteEmbedAdv024Unchanged(): boolean {
  return (
    EMBED_CATALOG_MEMBERSHIP_ISOLATION_RULES.failClosedWithoutGrant &&
    EMBED_CATALOG_MEMBERSHIP_ISOLATION.frameAncestorsAlwaysPublished &&
    EMBED_MEMBERSHIP_ISOLATION_GRANT_CAPS.includes("workspace.administer") &&
    EMBED_MEMBERSHIP_ISOLATION_GRANT_CAPS.includes("platform.administer") &&
    !grantsMembershipIsolationCatalog(["workflow.view"]) &&
    grantsMembershipIsolationCatalog(["workspace.administer"]) &&
    catalogRoutesForGrant(false).every((route) => route.grant !== "membership-isolation") &&
    catalogRoutesForGrant(true).some((route) => route.id === "membership") &&
    REWRITE_EMBED_MOUNT.adv024GrantGatingUnchanged
  );
}

export function rewriteEmbedNavOmitsAdv024WithoutGrant(): boolean {
  const denied = editorWorkspaceNav(["workflow.view"], { embed: true });
  const granted = editorWorkspaceNav(
    ["workflow.view", "workspace.administer"],
    { embed: true },
  );
  return (
    !denied.some((item) => item.id === "membership" || item.id === "isolation") &&
    !granted.some((item) => item.id === "membership" || item.id === "isolation") &&
    grantsMembershipIsolationCatalog(["workspace.administer"]) &&
    catalogRoutesForGrant(true).some((route) => route.id === "membership") &&
    catalogRoutesForGrant(true).some(
      (route) => route.id === "isolation" && route.embed === `${EMBED_MOUNT_PREFIX}/isolation`,
    )
  );
}

export function rewriteEmbedSameTreeAsStandalone(): boolean {
  return (
    EMBED_ROUTES.every(
      (route) =>
        route.embed ===
          (route.standalone === "/"
            ? EMBED_MOUNT_PREFIX
            : `${EMBED_MOUNT_PREFIX}${route.standalone}`) &&
        !INVENTED_EMBED_TREES.some(
          (tree) =>
            route.standalone.startsWith(tree) || route.embed.startsWith(tree),
        ),
    ) && REWRITE_EMBED_MOUNT.noSecondEmbedTree
  );
}

export function rewriteEmbedInventedTree(source: string): boolean {
  return INVENTED_EMBED_TREES.some((tree) => source.includes(`"${tree}"`));
}

export function rewriteEmbedR2R6PathsUnchanged(): boolean {
  return (
    editorEmbedRouteUnchanged() &&
    actionsEmbedRouteUnchanged() &&
    ndvEmbedPathUnchanged() &&
    canvasHistoryEmbedUnchanged() &&
    canvasPrimitivesEmbedUnchanged() &&
    canvasLayoutEmbedUnchanged() &&
    ndvParametersEmbedUnchanged() &&
    ndvMappingEmbedUnchanged() &&
    ndvValidationEmbedUnchanged() &&
    executionInboxEmbedUnchanged() &&
    editorRunsEmbedRoutesUnchanged() &&
    ndvRunIoEmbedRoutesUnchanged() &&
    credentialEmbedRoutesUnchanged() &&
    credentialVaultEmbedUnchanged() &&
    credentialDetailEmbedUnchanged() &&
    credentialNdvEmbedUnchanged() &&
    homeActivationEmbedUnchanged()
  );
}

export function rewriteEmbedBoundaryMoved(): boolean {
  return REWRITE_EMBED_MOUNT.boundaryMoved;
}

export function rewriteEmbedLeavesLaterStories(): boolean {
  return (
    REWRITE_EMBED_MOUNT.adv024ReshapeIsR72 &&
    R7_LATER_STORY_NOTES.r72.includes("#277") &&
    R7_LATER_STORY_NOTES.r73.includes("#278") &&
    R7_LATER_STORY_NOTES.r74.includes("#279")
  );
}
