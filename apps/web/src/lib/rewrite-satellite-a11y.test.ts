import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  E12_A11Y_GAPS,
  E12_A11Y_RULES,
  EDITOR_CHROME_A11Y,
  EDITOR_INSPECTOR_FIRST_MEDIA,
  editorDrawerAfterEscape,
} from "./e12-accessibility-contract.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  HOME_SATELLITE_OVERLAYS,
  JONNY_R74_NOTE,
  R74_A11Y_ID,
  R74_EPIC,
  R74_KEEP_STORY_OPEN,
  R74_STORY,
  REWRITE_SATELLITE_A11Y,
  REWRITE_SATELLITE_A11Y_DOCS,
  REWRITE_SATELLITE_A11Y_HELP,
  REWRITE_SATELLITE_A11Y_SOURCES,
  REWRITE_SATELLITE_SURFACES,
  SATELLITE_OVERLAY_IDS,
  SATELLITE_RAIL_IDS,
  activationStatusPresentation,
  homeSatelliteOverlayTriggerId,
  ndvCredentialOverlayTriggerId,
  rewriteSatelliteA11yBoundaryMoved,
  rewriteSatelliteA11yHoldsR7HardLine,
  rewriteSatelliteA11yInheritsUx10,
  rewriteSatelliteA11yInventedSrGraph,
  rewriteSatelliteA11yKeepsTouchBreakpoint,
  rewriteSatelliteA11yNestsMain,
  rewriteSatelliteLabeledControl,
  satelliteOverlayAfterEscape,
  satelliteOverlayTriggerId,
} from "./rewrite-satellite-a11y.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");
const repoRoot = join(webRoot, "..", "..");

function webSource(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

describe("R7.4 rewrite satellite a11y", () => {
  it("keeps #279 open and stays on epic #233", () => {
    assert.equal(R74_STORY, 279);
    assert.equal(R74_EPIC, 233);
    assert.equal(R74_KEEP_STORY_OPEN, true);
    assert.equal(R74_A11Y_ID, "R7.4-satellite-a11y");
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /Esc/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /focus return/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /nested main/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /icon\+text/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /NDV/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /palette/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /Runs overlay/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /activation/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /no screen-reader graph rewrite/);
    assert.match(REWRITE_SATELLITE_A11Y_HELP, /touch-inspector-first/);
    assert.match(JONNY_R74_NOTE, /No embed or ADV boundary moved/);
    assert.equal(REWRITE_SATELLITE_A11Y_DOCS.review, "docs/reference/e12-accessibility-review.md");
  });

  it("inherits the R7 hard line and does not weaken ADV", () => {
    assert.equal(rewriteSatelliteA11yHoldsR7HardLine(), true);
    assert.equal(REWRITE_SATELLITE_A11Y.inheritR7HardLine, true);
    assert.equal(R7_HARD_LINE.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(R7_HARD_LINE.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization, true);
    assert.equal(R7_HARD_LINE.noSecondEmbedTreeSameMountsAsStandalone, true);
    assert.equal(rewriteSatelliteA11yBoundaryMoved(), false);
    assert.equal(REWRITE_SATELLITE_A11Y.noAppsApiChanges, true);
    assert.equal(REWRITE_SATELLITE_A11Y.d6MigrateInPlace, true);
  });

  it("extends UX.10 / E12.3 Esc, focus return, no nested main, and icon+text", () => {
    assert.equal(rewriteSatelliteA11yInheritsUx10(), true);
    assert.equal(REWRITE_SATELLITE_A11Y.escapeCloses, true);
    assert.equal(REWRITE_SATELLITE_A11Y.focusReturns, true);
    assert.equal(REWRITE_SATELLITE_A11Y.noNestedMain, true);
    assert.equal(REWRITE_SATELLITE_A11Y.iconPlusText, true);
    assert.equal(REWRITE_SATELLITE_A11Y.skipLinkMainContent, true);
    assert.equal(E12_A11Y_RULES.skipLinkHref, "#main-content");
    assert.equal(EDITOR_CHROME_A11Y.noNestedMain, true);
    assert.deepEqual(satelliteOverlayAfterEscape(), editorDrawerAfterEscape());
    assert.deepEqual(satelliteOverlayAfterEscape(), {
      open: false,
      restoreFocus: true,
    });
    assert.equal(satelliteOverlayTriggerId("action-wizard"), "editor-topbar-add-action");
    assert.equal(satelliteOverlayTriggerId("ndv-credential"), "ndv-add-credential");
    assert.equal(
      ndvCredentialOverlayTriggerId("kubeconfig"),
      "ndv-add-credential-kubeconfig",
    );
    assert.notEqual(
      ndvCredentialOverlayTriggerId("token"),
      ndvCredentialOverlayTriggerId("kubeconfig"),
    );
    assert.equal(satelliteOverlayTriggerId("start-published"), "editor-topbar-start");
    assert.equal(satelliteOverlayTriggerId("activation"), "editor-topbar-activation");
    assert.deepEqual([...SATELLITE_OVERLAY_IDS], [
      "action-wizard",
      "ndv-credential",
      "start-published",
      "activation",
      "home-start",
      "home-webhooks",
      "home-schedules",
    ]);
    assert.deepEqual([...HOME_SATELLITE_OVERLAYS], ["start", "webhooks", "schedules"]);
    assert.equal(
      homeSatelliteOverlayTriggerId("start", "wf-1"),
      "home-start-wf-1",
    );
    assert.equal(SATELLITE_RAIL_IDS.library, "editor-library-satellite");
    assert.equal(SATELLITE_RAIL_IDS.inspector, "editor-inspector-satellite");
    assert.equal(SATELLITE_RAIL_IDS.runs, "editor-runs-satellite");
    assert.equal(rewriteSatelliteLabeledControl("add-action"), "Add action");
    assert.equal(rewriteSatelliteLabeledControl("activation"), "Activation");
  });

  it("keeps the inspector-first breakpoint and does not invent an SR graph rewrite", () => {
    assert.equal(rewriteSatelliteA11yKeepsTouchBreakpoint(), true);
    assert.equal(REWRITE_SATELLITE_A11Y.noSrGraphRewrite, true);
    assert.equal(REWRITE_SATELLITE_A11Y.notAMobileApp, true);
    assert.equal(EDITOR_INSPECTOR_FIRST_MEDIA, "(max-width: 767px)");
    assert.ok(E12_A11Y_GAPS.includes("touch-inspector-first"));
    assert.ok(E12_A11Y_GAPS.includes("canvas-sr-graph"));
    assert.equal(
      rewriteSatelliteA11yInventedSrGraph("Selecting nodes announces the inspector."),
      false,
    );
    assert.equal(
      rewriteSatelliteA11yInventedSrGraph("screen-reader graph rewrite"),
      true,
    );
  });

  it("announces activation as icon+text, never color alone", () => {
    const live = activationStatusPresentation({
      live: true,
      label: "Active · published v2",
    });
    assert.equal(live.icon, "●");
    assert.equal(live.label, "Active · published v2");
    assert.match(live.description, /enabled webhook or schedule pin/);
    const draft = activationStatusPresentation({
      live: false,
      label: "Draft — not live",
    });
    assert.equal(draft.icon, "○");
    assert.match(draft.description, /never look live/);
  });

  it("wires Esc + focus return on NDV, palette, start, and home drawers", () => {
    const wizard = webSource("src/components/workflows/ActionWizard.tsx");
    assert.match(wizard, /satelliteOverlayAfterEscape/);
    assert.match(wizard, /restoreSatelliteOverlayFocus/);
    assert.match(wizard, /Escape/);

    const credential = webSource(
      "src/components/credentials/CredentialWizardDialog.tsx",
    );
    assert.match(credential, /satelliteOverlayAfterEscape/);
    assert.match(credential, /restoreSatelliteOverlayFocus/);
    assert.match(credential, /satelliteOverlayTriggerId\("ndv-credential"\)/);

    const start = webSource("src/components/workflows/EditorStartDialog.tsx");
    assert.match(start, /satelliteOverlayAfterEscape/);
    assert.match(start, /restoreSatelliteOverlayFocus/);

    const topBar = webSource("src/components/workflows/EditorTopBar.tsx");
    assert.match(topBar, /editor-topbar-add-action|satelliteOverlayTriggerId\("action-wizard"\)/);
    assert.match(topBar, /editor-topbar-start|satelliteOverlayTriggerId\("start-published"\)/);

    const inspector = webSource("src/components/workflows/EditorInspector.tsx");
    assert.match(inspector, /ndvCredentialOverlayTriggerId/);

    const home = webSource("src/components/home/WorkflowHome.tsx");
    assert.match(home, /satelliteOverlayAfterEscape/);
    assert.match(home, /restoreSatelliteOverlayFocus/);
    assert.match(home, /homeSatelliteOverlayTriggerId/);
    assert.match(home, /Escape/);

    const operator = webSource("src/components/workflows/WorkflowOperator.tsx");
    assert.match(operator, /editorDrawerToClose/);
    assert.match(operator, /editorRestoreDrawerFocus/);
    assert.match(operator, /Escape/);

    const palette = webSource("src/components/shell/CommandPalette.tsx");
    assert.match(palette, /Escape/);
    assert.match(palette, /triggerRef\.current\?\.focus/);
  });

  it("keeps a single page main and icon+text on rewrite satellites", () => {
    for (const surface of REWRITE_SATELLITE_SURFACES) {
      for (const relative of surface.sources) {
        const source = webSource(relative);
        assert.equal(
          rewriteSatelliteA11yNestsMain(source),
          false,
          `${relative} must not nest <main>`,
        );
        assert.equal(
          rewriteSatelliteA11yInventedSrGraph(source),
          false,
          `${relative} must not invent an SR graph rewrite`,
        );
      }
    }

    const chrome = webSource("src/components/workflows/EditorChrome.tsx");
    assert.doesNotMatch(chrome, /<main[\s>]/);
    assert.match(chrome, /data-editor-breakpoint="inspector-first"/);
    assert.match(chrome, /order-first/);

    const activation = webSource(
      "src/components/workflows/EditorActivationChrome.tsx",
    );
    assert.match(activation, /activationStatusPresentation/);
    const homeActivation = webSource(
      "src/components/home/HomeActivationStatus.tsx",
    );
    assert.match(homeActivation, /activationStatusPresentation/);

    const runs = webSource("src/components/workflows/EditorRunsDrawer.tsx");
    assert.match(runs, /ExecutionStatusBadge/);
    assert.match(runs, /EDITOR_RUNS_SATELLITE_LABEL/);

    const page = webSource("src/app/workflows/[id]/page.tsx");
    assert.equal((page.match(/<main[\s>]/g) ?? []).length, 1);
    const homePage = webSource("src/app/workflows/page.tsx");
    assert.equal((homePage.match(/<main[\s>]/g) ?? []).length, 1);
  });

  it("records the extend in a11y + rewrite docs without closing #279", () => {
    const review = repoSource(REWRITE_SATELLITE_A11Y_DOCS.review);
    assert.match(review, /#279/);
    assert.match(review, /Keep #279 open/);
    assert.match(review, /R7\.4/);
    assert.match(review, /touch-inspector-first/);

    const frontend = repoSource(REWRITE_SATELLITE_A11Y_DOCS.frontend);
    assert.match(frontend, /#279/);
    assert.match(frontend, /Keep #279 open/);
    assert.match(frontend, /NDV/);
    assert.match(frontend, /touch-inspector-first/);
    assert.match(frontend, /not a mobile app/i);

    const guide = repoSource(REWRITE_SATELLITE_A11Y_DOCS.operatorAdmin);
    assert.match(guide, /#279/);
    assert.match(guide, /Keep #279 open/);
    assert.match(guide, /focus return|restores focus/);

    const surfaces = repoSource(REWRITE_SATELLITE_A11Y_DOCS.rewriteUiSurfaces);
    assert.match(surfaces, /#279/);
    assert.match(surfaces, /Keep #279 open/);

    const charter = repoSource(REWRITE_SATELLITE_A11Y_DOCS.charter);
    assert.match(charter, /#279/);
    assert.match(charter, /Keep #279 open/);
    assert.match(charter, /no screen-reader graph rewrite|Still no screen-reader graph rewrite/);

    assert.ok(REWRITE_SATELLITE_A11Y_SOURCES.includes("src/lib/rewrite-satellite-a11y.ts"));
  });
});
