/**
 * R7.2: Reshape membership/isolation off product chrome.
 *
 * Relates to #277 / Part of #233. Keep #277 open.
 *
 * Chloe UI only. Densify/reshape in place (D6). Inherit `R7_HARD_LINE`
 * from R7.1 — do not weaken ADV-021/024, host query display-only, no
 * second embed tree, issuer/frame-ancestor fail-closed.
 *
 * Terry #2 already demoted session chrome on product routes
 * (`product-session-chrome.ts`). This story demotes exercise-shaped
 * membership/isolation copy and placement the same way: they stay
 * ADV-024 grant-gated, but they stop looking like the product.
 * Settings may link carefully. Nav/search/Commands still omit
 * inaccessible capabilities. Isolation success remains a denial.
 * Do not retire the grant.
 *
 * Out of scope: weakening ADV-024, Portal DB share, inventing a
 * second admin app, seed/docs (R7.3), a11y extend (R7.4).
 *
 * jonny standby: no embed/ADV boundary moved.
 */

import { classifyIsolationResult } from "./isolation-exercises.ts";
import {
  ISOLATION_HREF,
  MEMBERSHIP_HREF,
  PRODUCT_SESSION_CHROME,
} from "./product-session-chrome.ts";
import {
  R7_HARD_LINE,
  rewriteEmbedAdv021Unchanged,
  rewriteEmbedAdv024Unchanged,
  rewriteEmbedFrameAncestorFailClosedUnchanged,
  rewriteEmbedHoldsR7HardLine,
  rewriteEmbedHostIssuerBindUnchanged,
} from "./rewrite-embed-mount.ts";
import {
  canSeeMembershipIsolationNav,
  editorWorkspaceNav,
  visibleWorkspaceNav,
} from "./workspace-nav.ts";

export const R72_STORY = 277;
export const R72_EPIC = 233;
export const R72_KEEP_STORY_OPEN = true;

export const MEMBERSHIP_ADMIN_HREF = MEMBERSHIP_HREF;
export const ISOLATION_CHECK_HREF = ISOLATION_HREF;

export const MEMBERSHIP_ISOLATION_CHROME = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  d6MigrateInPlace: true,
  offProductChrome: true,
  exerciseShapedCopyPlacementDemoted: true,
  settingsMayLinkCarefully: true,
  navSearchCommandsOmitInaccessible: true,
  isolationSuccessIsDenial: true,
  doNotRetireGrant: true,
  adv024StayGrantGated: true,
  doNotWeakenGrant: true,
  noSecondAdminApp: true,
  noPortalDbShare: true,
  noAppsApiChanges: true,
  exampleContextStaysLabeled: true,
  seedDocsAreR73: true,
  a11yExtendIsR74: true,
  terry2SessionChromePattern: true,
  jonnyStandbyOnlyIfBoundaryMoves: true,
  boundaryMoved: false,
} as const;

export const MEMBERSHIP_ISOLATION_CHROME_HELP =
  "Membership and isolation stay ADV-024 grant-gated. They are not product chrome. Settings may link when workspace.administer or platform.administer is present. Nav, search, and Commands omit them without that grant. Isolation success is a denial. Do not retire the grant.";

export const MEMBERSHIP_ADMIN_HELP =
  "Grant-gated workspace members, roles, and permission matrix. Not a product home. Isolation check is a separate page.";

export const ISOLATION_CHECK_HELP =
  "Negative cross-workspace check. Success is a denial — foreign ids must fail closed. Not a product surface.";

export const SETTINGS_ADMIN_LINKS_HELP =
  "Settings may link to members and the isolation check only when the ADV-024 grant is present. Do not treat those links as product destinations.";

export const JONNY_R72_NOTE =
  "No embed or ADV boundary moved. ADV-024 grant gating, ADV-021 session.embed, host-query display-only, CHIPS, host-issuer bind, and frame-ancestor fail-closed stay. Do not invent a second admin app or Portal DB share.";

export const MEMBERSHIP_ISOLATION_CHROME_SOURCES = [
  "src/lib/membership-isolation-chrome.ts",
  "src/lib/workspace-nav.ts",
  "src/lib/command-palette.ts",
  "src/lib/workspace-search.ts",
  "src/app/membership/page.tsx",
  "src/app/isolation/page.tsx",
  "src/app/settings/page.tsx",
  "src/components/settings/FoundationAdminLinks.tsx",
  "src/components/membership/MembershipOperator.tsx",
  "src/components/isolation/IsolationExercise.tsx",
  "src/components/OperatorNav.tsx",
] as const;

export const PRODUCT_CHROME_WITHOUT_MEMBERSHIP_ISOLATION = [
  "src/components/home/WorkflowHome.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/executions/ExecutionHistory.tsx",
] as const;

export function membershipIsolationGranted(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeMembershipIsolationNav(permissions);
}

export function settingsMayLinkMembershipIsolation(
  permissions: readonly string[] | null | undefined,
): boolean {
  return (
    MEMBERSHIP_ISOLATION_CHROME.settingsMayLinkCarefully &&
    membershipIsolationGranted(permissions)
  );
}

export function productNavOmitsMembershipIsolation(
  permissions: readonly string[] | null | undefined,
): boolean {
  return !visibleWorkspaceNav(permissions).some(
    (item) => item.id === "membership" || item.id === "isolation",
  );
}

export function embedProductNavOmitsMembershipIsolation(
  permissions: readonly string[] | null | undefined,
): boolean {
  return !editorWorkspaceNav(permissions, { embed: true }).some(
    (item) => item.id === "membership" || item.id === "isolation",
  );
}

export function isolationHeldIsSuccess(held: boolean): boolean {
  return MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial && held === true;
}

export function isolationStatusIsSuccess(
  statusCode: number,
  expectedOutcome: "fail-closed" | "scoped-list" = "fail-closed",
): boolean {
  return isolationHeldIsSuccess(
    classifyIsolationResult(statusCode, expectedOutcome).held,
  );
}

export function membershipIsolationHoldsR7HardLine(): boolean {
  return (
    MEMBERSHIP_ISOLATION_CHROME.inheritR7HardLine &&
    rewriteEmbedHoldsR7HardLine() &&
    rewriteEmbedAdv021Unchanged() &&
    rewriteEmbedAdv024Unchanged() &&
    rewriteEmbedHostIssuerBindUnchanged() &&
    rewriteEmbedFrameAncestorFailClosedUnchanged() &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated &&
    R7_HARD_LINE.adv024ReshapeIsR72DoNotWeakenGrant &&
    MEMBERSHIP_ISOLATION_CHROME.doNotWeakenGrant &&
    MEMBERSHIP_ISOLATION_CHROME.doNotRetireGrant
  );
}

export function membershipIsolationFollowsTerry2Pattern(): boolean {
  return (
    PRODUCT_SESSION_CHROME.fullIsolationIdentityPanelOnProductRoutes === false &&
    PRODUCT_SESSION_CHROME.sessionReachableViaChip &&
    MEMBERSHIP_ISOLATION_CHROME.terry2SessionChromePattern &&
    MEMBERSHIP_ISOLATION_CHROME.offProductChrome
  );
}

export function membershipIsolationBoundaryMoved(): boolean {
  return MEMBERSHIP_ISOLATION_CHROME.boundaryMoved;
}
