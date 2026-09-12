import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogRoutesForGrant } from "./embed-contract.ts";
import {
  ISOLATION_CHECK_HELP,
  ISOLATION_CHECK_HREF,
  JONNY_R72_NOTE,
  MEMBERSHIP_ADMIN_HELP,
  MEMBERSHIP_ADMIN_HREF,
  MEMBERSHIP_ISOLATION_CHROME,
  MEMBERSHIP_ISOLATION_CHROME_HELP,
  MEMBERSHIP_ISOLATION_CHROME_SOURCES,
  PRODUCT_CHROME_WITHOUT_MEMBERSHIP_ISOLATION,
  R72_EPIC,
  R72_KEEP_STORY_OPEN,
  R72_STORY,
  SETTINGS_ADMIN_LINKS_HELP,
  embedProductNavOmitsMembershipIsolation,
  isolationHeldIsSuccess,
  isolationStatusIsSuccess,
  membershipIsolationBoundaryMoved,
  membershipIsolationFollowsTerry2Pattern,
  membershipIsolationGranted,
  membershipIsolationHoldsR7HardLine,
  productNavOmitsMembershipIsolation,
  settingsMayLinkMembershipIsolation,
} from "./membership-isolation-chrome.ts";
import { R7_HARD_LINE, rewriteEmbedAdv024Unchanged } from "./rewrite-embed-mount.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

const viewer = ["workflow.view", "execution.view"];
const admin = [...viewer, "workspace.administer"];
const platform = [...viewer, "platform.administer"];

describe("R7.2 membership/isolation off product chrome", () => {
  it("keeps #277 open and stays on epic #233", () => {
    assert.equal(R72_STORY, 277);
    assert.equal(R72_EPIC, 233);
    assert.equal(R72_KEEP_STORY_OPEN, true);
    assert.equal(MEMBERSHIP_ADMIN_HREF, "/membership");
    assert.equal(ISOLATION_CHECK_HREF, "/isolation");
    assert.match(MEMBERSHIP_ISOLATION_CHROME_HELP, /ADV-024/);
    assert.match(MEMBERSHIP_ADMIN_HELP, /Not a product home/);
    assert.match(ISOLATION_CHECK_HELP, /Success is a denial/);
    assert.match(SETTINGS_ADMIN_LINKS_HELP, /Settings may link/);
    assert.match(JONNY_R72_NOTE, /No embed or ADV boundary moved/);
  });

  it("inherits the R7 hard line and does not weaken ADV-024", () => {
    assert.equal(membershipIsolationHoldsR7HardLine(), true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.inheritR7HardLine, true);
    assert.equal(R7_HARD_LINE.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(R7_HARD_LINE.adv024ReshapeIsR72DoNotWeakenGrant, true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.doNotWeakenGrant, true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.doNotRetireGrant, true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.adv024StayGrantGated, true);
    assert.equal(rewriteEmbedAdv024Unchanged(), true);
    assert.ok(
      catalogRoutesForGrant(true).some((route) => route.id === "membership"),
    );
    assert.ok(
      catalogRoutesForGrant(false).every(
        (route) => route.grant !== "membership-isolation",
      ),
    );
    assert.equal(membershipIsolationBoundaryMoved(), false);
  });

  it("stays grant-gated and omits inaccessible Settings / nav / search / Commands", () => {
    assert.equal(membershipIsolationGranted(null), false);
    assert.equal(membershipIsolationGranted(viewer), false);
    assert.equal(membershipIsolationGranted(admin), true);
    assert.equal(membershipIsolationGranted(platform), true);
    assert.equal(settingsMayLinkMembershipIsolation(null), false);
    assert.equal(settingsMayLinkMembershipIsolation(viewer), false);
    assert.equal(settingsMayLinkMembershipIsolation(admin), true);
    assert.equal(settingsMayLinkMembershipIsolation(platform), true);
  });

  it("takes membership/isolation off product chrome even when granted", () => {
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.offProductChrome, true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.exerciseShapedCopyPlacementDemoted, true);
    assert.equal(productNavOmitsMembershipIsolation(null), true);
    assert.equal(productNavOmitsMembershipIsolation(viewer), true);
    assert.equal(productNavOmitsMembershipIsolation(admin), true);
    assert.equal(embedProductNavOmitsMembershipIsolation(viewer), true);
    assert.equal(embedProductNavOmitsMembershipIsolation(admin), true);
    assert.equal(membershipIsolationFollowsTerry2Pattern(), true);
  });

  it("treats isolation success as a denial and does not retire the grant", () => {
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial, true);
    assert.equal(isolationHeldIsSuccess(true), true);
    assert.equal(isolationHeldIsSuccess(false), false);
    assert.equal(isolationStatusIsSuccess(403), true);
    assert.equal(isolationStatusIsSuccess(404), true);
    assert.equal(isolationStatusIsSuccess(400), true);
    assert.equal(isolationStatusIsSuccess(200), false);
    assert.equal(isolationStatusIsSuccess(201), false);
    assert.equal(isolationStatusIsSuccess(200, "scoped-list"), true);
  });

  it("unstacks the isolation exercise from membership and Settings-links carefully", () => {
    const membership = source("src/components/membership/MembershipOperator.tsx");
    assert.equal(membership.includes("IsolationExercise"), false);
    assert.match(membership, /Isolation check|ISOLATION_CHECK_HREF|\/isolation/);

    const membershipPage = source("src/app/membership/page.tsx");
    assert.doesNotMatch(membershipPage, /E2\.1 \/ E2\.3 · Chloe UI/);
    assert.match(membershipPage, /Not a product home|grant-gated/i);

    const isolationPage = source("src/app/isolation/page.tsx");
    assert.doesNotMatch(isolationPage, /E2\.2 · Chloe UI/);
    assert.match(isolationPage, /Success is a denial|denial/);
    assert.match(isolationPage, /IsolationExercise/);

    const exercise = source("src/components/isolation/IsolationExercise.tsx");
    assert.doesNotMatch(exercise, /E2\.2 · Chloe UI/);
    assert.match(exercise, /denial|fail closed/i);

    const settings = source("src/app/settings/page.tsx");
    assert.match(settings, /FoundationAdminLinks/);
    assert.doesNotMatch(settings, /Foundation operators/);

    const links = source("src/components/settings/FoundationAdminLinks.tsx");
    assert.match(links, /settingsMayLinkMembershipIsolation/);
    assert.match(links, /canSeeAuditNav/);

    const operatorNav = source("src/components/OperatorNav.tsx");
    assert.match(operatorNav, /canSeeMembershipIsolationNav/);

    const commands = source("src/lib/command-palette.ts");
    assert.match(commands, /canSeeMembershipIsolationNav/);
    assert.match(commands, /nav-membership/);
    assert.match(commands, /nav-isolation/);

    const search = source("src/lib/workspace-search.ts");
    assert.match(search, /canSeeMembershipIsolationNav/);
    assert.match(search, /doc-membership|doc-isolation/);

    assert.deepEqual(
      [...MEMBERSHIP_ISOLATION_CHROME_SOURCES],
      [
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
      ],
    );
  });

  it("does not invent a second admin app on product surfaces", () => {
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.noSecondAdminApp, true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.d6MigrateInPlace, true);
    for (const relative of PRODUCT_CHROME_WITHOUT_MEMBERSHIP_ISOLATION) {
      const text = source(relative);
      assert.equal(
        text.includes("FoundationAdminLinks"),
        false,
        `${relative} must not mount Settings admin links`,
      );
    }
  });
});
