/**
 * R7.3: Local seed + ops docs still correct.
 *
 * Relates to #278 / Part of #233. Keep #278 open.
 *
 * Chloe UI/docs. Inherit `R7_HARD_LINE` from R7.1 — do not weaken
 * ADV-021/024, host query display-only, no second embed tree, issuer /
 * frame-ancestor fail-closed. jonny docs/harness only if a boundary
 * moved (it should not).
 *
 * Acceptance:
 * - Local seed Example context stays labeled and local-only
 *   (`https://idp.example` / `admin-1` / `local` / `default`).
 * - Operator-admin + frontend-ui + deployment seed docs still match
 *   rewrite IA after R2–R6 (and R7.1–R7.2).
 * - Trusted-dev header fallback is never promoted as rewrite login.
 *
 * Out of scope: changing seed crypto/defaults product-wide, Portal
 * harness unless a boundary moved, a11y extend (R7.4 / #279).
 */

import {
  LOCAL_SEED_EXAMPLE_IDENTITY,
  LOCAL_SEED_ISSUER,
  LOCAL_SEED_SUBJECT,
  LOCAL_SEED_TENANT_SLUG,
  LOCAL_SEED_WORKBENCH_KEY,
} from "./local-seed-example.ts";
import { MEMBERSHIP_ISOLATION_CHROME } from "./membership-isolation-chrome.ts";
import {
  R7_HARD_LINE,
  rewriteEmbedAdv021Unchanged,
  rewriteEmbedAdv024Unchanged,
  rewriteEmbedFrameAncestorFailClosedUnchanged,
  rewriteEmbedHoldsR7HardLine,
  rewriteEmbedHostIssuerBindUnchanged,
} from "./rewrite-embed-mount.ts";

export const R73_STORY = 278;
export const R73_EPIC = 233;
export const R73_KEEP_STORY_OPEN = true;

export const LOCAL_SEED_OPS = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  exampleContextLabeled: true,
  exampleContextLocalOnly: true,
  exampleContextNotProductionSettingsCopy: true,
  exampleIssuer: LOCAL_SEED_ISSUER,
  exampleSubject: LOCAL_SEED_SUBJECT,
  exampleTenantSlug: LOCAL_SEED_TENANT_SLUG,
  exampleWorkbenchKey: LOCAL_SEED_WORKBENCH_KEY,
  trustedDevHeaderFallbackNeverRewriteLogin: true,
  trustedDevPostSessionNeverRewriteLogin: true,
  cookieSessionIsThePath: true,
  seedCryptoUnchanged: true,
  portalHarnessUnchanged: true,
  noAppsApiChanges: true,
  a11yExtendIsR74: true,
  jonnyOnlyIfBoundaryMoves: true,
  boundaryMoved: false,
} as const;

export const LOCAL_SEED_OPS_HELP =
  "Labeled Example context stays local-only for issuer https://idp.example, subject admin-1, tenant local, workbench default. Do not promote it into production Settings copy. Trusted-dev POST /session and identity-header fallback are never rewrite login. Cookie session (embed exchange in production) remains the path.";

export const JONNY_R73_NOTE =
  "No embed or ADV boundary moved. ADV-021 session.embed, ADV-024 grant gating, host-query display-only, CHIPS, host-issuer bind, and frame-ancestor fail-closed stay. Seed crypto/defaults and Portal harness are unchanged. Do not treat trusted-dev headers as rewrite login.";

export const LOCAL_SEED_OPS_DOCS = {
  operatorAdmin: "docs/guides/operator-admin.md",
  frontendUi: "docs/reference/frontend-ui.md",
  deployment: "docs/deployment.md",
  operationsIndex: "docs/operations/index.md",
  rewriteUiSurfaces: "docs/reference/rewrite-ui-surfaces.md",
} as const;

export const LOCAL_SEED_OPS_SOURCES = [
  "src/lib/local-seed-ops.ts",
  "src/lib/local-seed-example.ts",
  "src/app/membership/page.tsx",
  "src/components/membership/IdentityBootstrap.tsx",
  "src/components/membership/MembershipOperator.tsx",
  "src/components/isolation/IsolationIdentityPanel.tsx",
  "src/components/session/SessionPanel.tsx",
] as const;

export function localSeedExampleIdentityMatchesLocalseed(): boolean {
  return (
    LOCAL_SEED_OPS.exampleIssuer === "https://idp.example" &&
    LOCAL_SEED_OPS.exampleSubject === "admin-1" &&
    LOCAL_SEED_OPS.exampleTenantSlug === "local" &&
    LOCAL_SEED_OPS.exampleWorkbenchKey === "default" &&
    LOCAL_SEED_EXAMPLE_IDENTITY.issuer === LOCAL_SEED_OPS.exampleIssuer &&
    LOCAL_SEED_EXAMPLE_IDENTITY.subject === LOCAL_SEED_OPS.exampleSubject &&
    LOCAL_SEED_EXAMPLE_IDENTITY.tenantSlug === LOCAL_SEED_OPS.exampleTenantSlug &&
    LOCAL_SEED_EXAMPLE_IDENTITY.workbenchKey === LOCAL_SEED_OPS.exampleWorkbenchKey
  );
}

export function localSeedOpsHoldsR7HardLine(): boolean {
  return (
    LOCAL_SEED_OPS.inheritR7HardLine &&
    rewriteEmbedHoldsR7HardLine() &&
    rewriteEmbedAdv021Unchanged() &&
    rewriteEmbedAdv024Unchanged() &&
    rewriteEmbedHostIssuerBindUnchanged() &&
    rewriteEmbedFrameAncestorFailClosedUnchanged() &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated &&
    MEMBERSHIP_ISOLATION_CHROME.exampleContextStaysLabeled &&
    MEMBERSHIP_ISOLATION_CHROME.seedDocsAreR73
  );
}

export function localSeedOpsBoundaryMoved(): boolean {
  return LOCAL_SEED_OPS.boundaryMoved;
}

export function trustedDevIsNeverRewriteLogin(): boolean {
  return (
    LOCAL_SEED_OPS.trustedDevHeaderFallbackNeverRewriteLogin &&
    LOCAL_SEED_OPS.trustedDevPostSessionNeverRewriteLogin &&
    LOCAL_SEED_OPS.cookieSessionIsThePath
  );
}
