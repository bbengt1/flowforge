import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyBrowserSession } from "./session.ts";
import {
  E12_A11Y_DOCS,
  E12_A11Y_EPIC,
  E12_A11Y_FIXES,
  E12_A11Y_GAPS,
  E12_A11Y_ID,
  E12_A11Y_RULES,
  E12_A11Y_STORY,
  e12A11yChipName,
  e12A11yExpiredSessionIsAlert,
  e12A11yMembershipIsolationNavIds,
  e12A11yMembershipIsolationVisible,
  e12A11yPaletteContract,
  e12A11yPaletteHighlight,
  e12A11ySkipTarget,
} from "./e12-accessibility-contract.ts";

describe("E12.3 accessibility contract", () => {
  it("keeps #184 open and points at the operator guide + review", () => {
    assert.equal(E12_A11Y_STORY, 184);
    assert.equal(E12_A11Y_EPIC, 181);
    assert.equal(E12_A11Y_ID, "E12.3-chloe-a11y");
    assert.equal(E12_A11Y_RULES.keep184Open, true);
    assert.equal(E12_A11Y_DOCS.guide, "docs/guides/operator-admin.md");
    assert.equal(E12_A11Y_DOCS.review, "docs/reference/e12-accessibility-review.md");
    assert.ok(E12_A11Y_FIXES.includes("skip-link"));
    assert.ok(E12_A11Y_GAPS.includes("dialog-focus-trap"));
  });

  it("uses a skip target that does not invent a nested main landmark", () => {
    const skip = e12A11ySkipTarget();
    assert.equal(skip.href, "#main-content");
    assert.equal(skip.id, "main-content");
    assert.equal(skip.label, "Skip to main content");
    assert.equal(E12_A11Y_RULES.noNestedMainInShell, true);
  });

  it("labels the command palette and moves highlight with arrows", () => {
    const palette = e12A11yPaletteContract();
    assert.equal(palette.inputLabel, "Filter commands");
    assert.equal(palette.resultsId, "command-palette-results");
    assert.match(palette.shortcutHelp, /Ctrl\+Shift\+K/);
    assert.equal(e12A11yPaletteHighlight(0, "ArrowDown", 2), 1);
    assert.equal(e12A11yPaletteHighlight(0, "ArrowUp", 2), 1);
  });

  it("announces expired session as alert and names the chip without color-only state", () => {
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    const expired = {
      active: true,
      stale: false,
      session: {
        ...emptyBrowserSession(),
        subject: "ada",
        idleExpiresAt: "2026-09-10T11:00:00.000Z",
      },
    };
    assert.equal(e12A11yExpiredSessionIsAlert(expired, now), true);
    assert.equal(e12A11yChipName(expired, now), "Session expired for ada");
    assert.equal(
      e12A11yChipName(
        { active: false, stale: true, session: emptyBrowserSession() },
        now,
      ),
      "Session stale. Re-establish a cookie session.",
    );
  });

  it("hides membership/isolation unless ADV-024 grant is present", () => {
    assert.equal(e12A11yMembershipIsolationVisible(null), false);
    assert.equal(e12A11yMembershipIsolationVisible(["workflow.view"]), false);
    assert.deepEqual(e12A11yMembershipIsolationNavIds(["workflow.view"]), []);
    assert.equal(
      e12A11yMembershipIsolationVisible(["workspace.administer"]),
      true,
    );
    assert.deepEqual(
      e12A11yMembershipIsolationNavIds(["workspace.administer"]),
      ["membership", "isolation"],
    );
    assert.equal(
      e12A11yMembershipIsolationVisible(["platform.administer"]),
      true,
    );
  });
});
