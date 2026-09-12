import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  JONNY_R73_NOTE,
  LOCAL_SEED_OPS,
  LOCAL_SEED_OPS_DOCS,
  LOCAL_SEED_OPS_HELP,
  LOCAL_SEED_OPS_SOURCES,
  R73_EPIC,
  R73_KEEP_STORY_OPEN,
  R73_STORY,
  localSeedExampleIdentityMatchesLocalseed,
  localSeedOpsBoundaryMoved,
  localSeedOpsHoldsR7HardLine,
  trustedDevIsNeverRewriteLogin,
} from "./local-seed-ops.ts";
import {
  LOCAL_SEED_ISSUER,
  LOCAL_SEED_SUBJECT,
  LOCAL_SEED_TENANT_SLUG,
  LOCAL_SEED_WORKBENCH_KEY,
} from "./local-seed-example.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");
const repoRoot = join(webRoot, "..", "..");

function webSource(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

describe("R7.3 local seed + ops docs", () => {
  it("keeps #278 open and stays on epic #233", () => {
    assert.equal(R73_STORY, 278);
    assert.equal(R73_EPIC, 233);
    assert.equal(R73_KEEP_STORY_OPEN, true);
    assert.match(LOCAL_SEED_OPS_HELP, /Example context/);
    assert.match(LOCAL_SEED_OPS_HELP, /never rewrite login/);
    assert.match(JONNY_R73_NOTE, /No embed or ADV boundary moved/);
  });

  it("keeps Example context labeled and local-only on the compose localseed", () => {
    assert.equal(localSeedExampleIdentityMatchesLocalseed(), true);
    assert.equal(LOCAL_SEED_OPS.exampleContextLabeled, true);
    assert.equal(LOCAL_SEED_OPS.exampleContextLocalOnly, true);
    assert.equal(LOCAL_SEED_OPS.exampleContextNotProductionSettingsCopy, true);
    assert.equal(LOCAL_SEED_ISSUER, "https://idp.example");
    assert.equal(LOCAL_SEED_SUBJECT, "admin-1");
    assert.equal(LOCAL_SEED_TENANT_SLUG, "local");
    assert.equal(LOCAL_SEED_WORKBENCH_KEY, "default");
    assert.equal(LOCAL_SEED_OPS.exampleIssuer, "https://idp.example");
    assert.equal(LOCAL_SEED_OPS.exampleSubject, "admin-1");
    assert.equal(LOCAL_SEED_OPS.exampleTenantSlug, "local");
    assert.equal(LOCAL_SEED_OPS.exampleWorkbenchKey, "default");

    const bootstrap = webSource("src/components/membership/IdentityBootstrap.tsx");
    assert.match(bootstrap, /Example context/);
    assert.match(bootstrap, /Local-only/);
    assert.match(bootstrap, /https:\/\/idp\.example/);
    assert.match(bootstrap, /admin-1/);
    assert.match(bootstrap, /Temporary local-dev header identity \(not for production\)/);

    const membershipPage = webSource("src/app/membership/page.tsx");
    assert.match(membershipPage, /never rewrite login/);

    const membership = webSource(
      "src/components/membership/MembershipOperator.tsx",
    );
    assert.match(membership, /LOCAL_SEED_EXAMPLE_IDENTITY/);

    const isolation = webSource(
      "src/components/isolation/IsolationIdentityPanel.tsx",
    );
    assert.match(isolation, /LOCAL_SEED_EXAMPLE_IDENTITY/);
  });

  it("never promotes trusted-dev header fallback as rewrite login", () => {
    assert.equal(trustedDevIsNeverRewriteLogin(), true);
    assert.equal(LOCAL_SEED_OPS.trustedDevHeaderFallbackNeverRewriteLogin, true);
    assert.equal(LOCAL_SEED_OPS.trustedDevPostSessionNeverRewriteLogin, true);
    assert.equal(LOCAL_SEED_OPS.cookieSessionIsThePath, true);
    assert.equal(LOCAL_SEED_OPS.seedCryptoUnchanged, true);
    assert.equal(LOCAL_SEED_OPS.portalHarnessUnchanged, true);
    assert.equal(LOCAL_SEED_OPS.noAppsApiChanges, true);

    const session = webSource("src/components/session/SessionPanel.tsx");
    assert.match(session, /never rewrite login/);
    assert.match(session, /POST \/embed\/exchange/);
    assert.match(session, /LOCAL_SEED_ISSUER|LOCAL_SEED_SUBJECT/);

    const bootstrap = webSource("src/components/membership/IdentityBootstrap.tsx");
    assert.match(bootstrap, /not for production/);
    assert.match(bootstrap, /never rewrite login/);
  });

  it("inherits the R7 hard line and does not move a boundary", () => {
    assert.equal(localSeedOpsHoldsR7HardLine(), true);
    assert.equal(LOCAL_SEED_OPS.inheritR7HardLine, true);
    assert.equal(R7_HARD_LINE.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(R7_HARD_LINE.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization, true);
    assert.equal(R7_HARD_LINE.noSecondEmbedTreeSameMountsAsStandalone, true);
    assert.equal(localSeedOpsBoundaryMoved(), false);
    assert.equal(LOCAL_SEED_OPS.jonnyOnlyIfBoundaryMoves, true);
  });

  it("keeps operator-admin, frontend-ui, and deployment seed docs on rewrite IA", () => {
    assert.deepEqual(LOCAL_SEED_OPS_DOCS, {
      operatorAdmin: "docs/guides/operator-admin.md",
      frontendUi: "docs/reference/frontend-ui.md",
      deployment: "docs/deployment.md",
      operationsIndex: "docs/operations/index.md",
      rewriteUiSurfaces: "docs/reference/rewrite-ui-surfaces.md",
    });

    const operatorAdmin = repoSource(LOCAL_SEED_OPS_DOCS.operatorAdmin);
    assert.match(operatorAdmin, /Keep #278 open/);
    assert.match(operatorAdmin, /Example context/);
    assert.match(operatorAdmin, /https:\/\/idp\.example/);
    assert.match(operatorAdmin, /admin-1/);
    assert.match(operatorAdmin, /never rewrite login/);
    assert.match(operatorAdmin, /off product chrome/);
    assert.match(operatorAdmin, /Settings may link carefully/);

    const frontendUi = repoSource(LOCAL_SEED_OPS_DOCS.frontendUi);
    assert.match(frontendUi, /Keep #278 open|#278/);
    assert.match(frontendUi, /Example context/);
    assert.match(frontendUi, /never rewrite login/);
    assert.match(frontendUi, /https:\/\/idp\.example/);

    const deployment = repoSource(LOCAL_SEED_OPS_DOCS.deployment);
    assert.match(deployment, /#local-default-tenant-seed|Local default tenant seed/);
    assert.match(deployment, /Example context/);
    assert.match(deployment, /https:\/\/idp\.example/);
    assert.match(deployment, /admin-1/);
    assert.match(deployment, /never rewrite login/);
    assert.match(deployment, /local-only|Local-only|local only/);

    const operations = repoSource(LOCAL_SEED_OPS_DOCS.operationsIndex);
    assert.match(operations, /#278|Example context|local default tenant seed/i);

    const surfaces = repoSource(LOCAL_SEED_OPS_DOCS.rewriteUiSurfaces);
    assert.match(surfaces, /#278|Example context/);
    assert.match(surfaces, /never rewrite login|header fallback/);

    assert.deepEqual(
      [...LOCAL_SEED_OPS_SOURCES],
      [
        "src/lib/local-seed-ops.ts",
        "src/lib/local-seed-example.ts",
        "src/app/membership/page.tsx",
        "src/components/membership/IdentityBootstrap.tsx",
        "src/components/membership/MembershipOperator.tsx",
        "src/components/isolation/IsolationIdentityPanel.tsx",
        "src/components/session/SessionPanel.tsx",
      ],
    );
  });
});
