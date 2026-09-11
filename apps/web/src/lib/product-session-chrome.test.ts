import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_IDENTITY_GATE_SOURCE,
  FOUNDATION_IDENTITY_SOURCES,
  ISOLATION_HREF,
  MEMBERSHIP_HREF,
  PRODUCT_SESSION_CHROME,
  PRODUCT_SURFACES_WITHOUT_IDENTITY_PANEL,
  SESSION_CHIP_SOURCE,
  SESSION_SETUP_HINT_SOURCE,
  SETTINGS_HREF,
  SETTINGS_SESSION_HREF,
} from "./product-session-chrome.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("product session chrome", () => {
  it("keeps product lists primary and session chrome on Settings", () => {
    assert.equal(PRODUCT_SESSION_CHROME.productPrimary, true);
    assert.equal(
      PRODUCT_SESSION_CHROME.fullIsolationIdentityPanelOnProductRoutes,
      false,
    );
    assert.equal(PRODUCT_SESSION_CHROME.sessionReachableViaChip, true);
    assert.equal(
      PRODUCT_SESSION_CHROME.exampleContextOnSettingsOrMembership,
      true,
    );
    assert.equal(
      PRODUCT_SESSION_CHROME.editorCollapsedIdentityGateWhenNotReady,
      true,
    );
    assert.equal(PRODUCT_SESSION_CHROME.rbacFailClosed, true);
    assert.equal(PRODUCT_SESSION_CHROME.noAppsApiChanges, true);
    assert.equal(SETTINGS_SESSION_HREF, "/settings#session");
    assert.equal(SETTINGS_HREF, "/settings");
    assert.equal(MEMBERSHIP_HREF, "/membership");
    assert.equal(ISOLATION_HREF, "/isolation");
  });

  it("does not stack IsolationIdentityPanel on product routes", () => {
    for (const relative of PRODUCT_SURFACES_WITHOUT_IDENTITY_PANEL) {
      const text = source(relative);
      assert.equal(
        text.includes("IsolationIdentityPanel"),
        false,
        `${relative} must not mount IsolationIdentityPanel`,
      );
    }
  });

  it("keeps full session + Example context on Settings, membership, isolation", () => {
    const settings = source("src/app/settings/page.tsx");
    assert.match(settings, /IsolationIdentityPanel/);

    const isolation = source("src/app/isolation/page.tsx");
    assert.match(isolation, /IsolationIdentityPanel/);

    const membership = source("src/components/membership/MembershipOperator.tsx");
    assert.match(membership, /SessionPanel/);
    assert.match(membership, /IdentityBootstrap/);
    assert.match(membership, /Example context|LOCAL_SEED_EXAMPLE_IDENTITY/);

    const bootstrap = source("src/components/membership/IdentityBootstrap.tsx");
    assert.match(bootstrap, /Example context/);
    assert.match(bootstrap, /workspace-context-heading/);

    const session = source("src/components/session/SessionPanel.tsx");
    assert.match(session, /session-heading/);
    assert.match(session, /Fail-closed CSRF exercise/);
    assert.match(session, /Session audit/);

    assert.deepEqual(
      [...FOUNDATION_IDENTITY_SOURCES],
      [
        "src/app/settings/page.tsx",
        "src/app/isolation/page.tsx",
        "src/components/membership/MembershipOperator.tsx",
        "src/components/isolation/IsolationIdentityPanel.tsx",
        "src/components/session/SessionPanel.tsx",
        "src/components/membership/IdentityBootstrap.tsx",
      ],
    );
  });

  it("keeps a compact session chip and a Settings setup hint", () => {
    const chip = source(SESSION_CHIP_SOURCE);
    assert.match(chip, /settingsHref/);
    assert.match(chip, /#session/);
    assert.match(chip, /membershipHref/);

    const hint = source(SESSION_SETUP_HINT_SOURCE);
    assert.match(hint, /SETTINGS_SESSION_HREF/);
    assert.match(hint, /Settings/);
  });

  it("collapses editor identity chrome until the workflow cannot load", () => {
    const editor = source(EDITOR_IDENTITY_GATE_SOURCE);
    assert.match(editor, /identityGate=/);
    assert.match(editor, /IsolationIdentityPanel/);
    assert.match(editor, /Set workspace identity to load this workflow/);
    assert.match(editor, /<details/);
  });
});
