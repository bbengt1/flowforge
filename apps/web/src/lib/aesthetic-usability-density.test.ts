import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EDITOR_LIBRARY_SATELLITE_WIDTH } from "./editor-library.ts";
import { EDITOR_NDV_SATELLITE_WIDTH } from "./editor-ndv.ts";
import { EDITOR_RUNS_SATELLITE_WIDTH } from "./editor-runs.ts";
import { EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS } from "./editor-topbar-chunking.ts";
import { MEMBERSHIP_ISOLATION_CHROME } from "./membership-isolation-chrome.ts";
import { REWRITE_SATELLITE_A11Y } from "./rewrite-satellite-a11y.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  AESTHETIC_USABILITY,
  AESTHETIC_USABILITY_HELP,
  AESTHETIC_USABILITY_SOURCES,
  AESTHETIC_USABILITY_SURFACES,
  ISOLATION_CHROME_SOURCES,
  ISOLATION_DENIAL_ICON,
  ISOLATION_DENIAL_LABEL,
  ISOLATION_LEAK_ICON,
  ISOLATION_LEAK_LABEL,
  KEK_CHROME_TOKENS,
  LOUD_ADV024_DENIAL_CLASS,
  LOUD_ADV024_LEAK_CLASS,
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
  LOUD_WARNING_CLASS,
  PAGE_SHELL_CLASS,
  PRODUCT_CHROME_SOURCES,
  SATELLITE_HEADER_CLASS,
  SATELLITE_HIDE_BUTTON_CLASS,
  SATELLITE_RAIL_BUTTON_CLASS,
  SATELLITE_RAIL_WIDTH,
  SATELLITE_TITLE_CLASS,
  TYPE_CAPTION_CLASS,
  TYPE_EYEBROW_CLASS,
  TYPE_HEADING_CLASS,
  TYPE_PAGE_HELP_CLASS,
  UXL8_BRIEF,
  UXL8_EPIC,
  UXL8_ID,
  UXL8_KEEP_STORY_OPEN,
  UXL8_STORY,
  aestheticUsabilityHoldsHardLines,
  aestheticUsabilityInheritsPriorStories,
  clonedN8nTokenPresent,
  inventedPxTypeScale,
  inventedSurfacePresent,
  isolationCopyCallsSuccessAPass,
  kekAppearsInProductChrome,
  loudContrastNotQuieter,
  satelliteRailsAlign,
  satelliteSourceAligned,
  standaloneAndEmbedShareDensity,
  statusStaysIconPlusText,
  warningContrastNotQuieter,
} from "./aesthetic-usability-density.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UXL.8 Aesthetic-Usability density pass", () => {
  it("keeps #295 open and cites epic #287", () => {
    assert.equal(UXL8_STORY, 295);
    assert.equal(UXL8_EPIC, 287);
    assert.equal(UXL8_KEEP_STORY_OPEN, true);
    assert.equal(UXL8_ID, "UXL.8-aesthetic-usability-density");
    assert.equal(UXL8_BRIEF, "docs/architecture/flowforge-ux-laws.md");
    assert.match(AESTHETIC_USABILITY_HELP, /standalone and \/embed\/v1/);
    assert.match(AESTHETIC_USABILITY_HELP, /indeterminate/);
    assert.match(AESTHETIC_USABILITY_HELP, /ADV-024/);
    assert.equal(AESTHETIC_USABILITY.d6MigrateInPlace, true);
    assert.equal(AESTHETIC_USABILITY.notARedesign, true);
    assert.equal(AESTHETIC_USABILITY.jonnyNoneExpected, true);
    assert.equal(AESTHETIC_USABILITY.noNewApiRoutes, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /Aesthetic-Usability/);
  });

  it("aligns spacing, type, and satellite rails on standalone and embed", () => {
    assert.deepEqual([...AESTHETIC_USABILITY_SURFACES], [
      "editor",
      "ndv",
      "runs",
      "activation",
      "embed",
      "vault",
      "home",
    ]);
    assert.equal(satelliteRailsAlign(), true);
    assert.equal(SATELLITE_RAIL_WIDTH, EDITOR_LIBRARY_SATELLITE_WIDTH);
    assert.equal(SATELLITE_RAIL_WIDTH, EDITOR_NDV_SATELLITE_WIDTH);
    assert.equal(SATELLITE_RAIL_WIDTH, EDITOR_RUNS_SATELLITE_WIDTH);
    assert.equal(TYPE_CAPTION_CLASS, "text-xs");
    assert.equal(TYPE_HEADING_CLASS.includes("text-3xl"), true);
    assert.equal(PAGE_SHELL_CLASS.includes("max-w-6xl"), true);

    const editor = source("src/components/workflows/EditorChrome.tsx");
    const runs = source("src/components/workflows/EditorRunsDrawer.tsx");
    const yaml = source("src/components/workflows/EditorYamlDrawer.tsx");
    const ndv = source("src/components/workflows/EditorInspector.tsx");
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const homePage = source("src/app/workflows/page.tsx");
    const vaultPage = source("src/app/credentials/page.tsx");
    const inboxPage = source("src/app/executions/page.tsx");

    assert.equal(satelliteSourceAligned(editor), true);
    assert.equal(satelliteSourceAligned(runs), true);
    assert.match(yaml, /SATELLITE_HEADER_CLASS/);
    assert.match(ndv, /SATELLITE_NDV_HEADER_CLASS|data-uxl8="ndv"/);
    assert.match(editor, /data-uxl8="editor"/);
    assert.match(runs, /data-uxl8="runs"/);
    assert.match(embed, /data-uxl8="embed"/);
    assert.match(topBar, /TYPE_CAPTION_CLASS/);
    assert.equal(inventedPxTypeScale(topBar), false);
    assert.equal(inventedPxTypeScale(embed), false);
    assert.equal(inventedPxTypeScale(runs), false);
    assert.equal(
      standaloneAndEmbedShareDensity({
        editorChrome: editor,
        embedChrome: embed,
        topBar,
      }),
      true,
    );
    assert.match(homePage, /PAGE_SHELL_CLASS/);
    assert.match(vaultPage, /PAGE_SHELL_CLASS/);
    assert.match(inboxPage, /PAGE_SHELL_CLASS/);
    assert.match(homePage, /TYPE_HEADING_CLASS|TYPE_EYEBROW_CLASS/);
    assert.equal(homePage.includes(TYPE_EYEBROW_CLASS) || homePage.includes("TYPE_EYEBROW_CLASS"), true);
    assert.equal(AESTHETIC_USABILITY.sameTokensStandaloneAndEmbed, true);
    assert.equal(AESTHETIC_USABILITY.fittsPrimaryControlsUnchanged, true);
    assert.equal(
      EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS,
      "px-2.5 py-1 text-sm font-medium",
    );
  });

  it("does not quiet error, warning, indeterminate, or ADV-024 denial contrast", () => {
    assert.equal(loudContrastNotQuieter(LOUD_INDETERMINATE_CLASS), true);
    assert.equal(loudContrastNotQuieter(LOUD_ERROR_CLASS), true);
    assert.equal(loudContrastNotQuieter(LOUD_ADV024_DENIAL_CLASS), true);
    assert.equal(loudContrastNotQuieter(LOUD_ADV024_LEAK_CLASS), true);
    assert.equal(warningContrastNotQuieter(LOUD_WARNING_CLASS), true);
    assert.equal(
      loudContrastNotQuieter("border border-amber-200 bg-amber-50/40 text-amber-400"),
      false,
    );

    const badge = source("src/components/executions/ExecutionStatusBadge.tsx");
    const lastRun = source("src/components/home/HomeLastRunStatus.tsx");
    const ndvIo = source("src/components/workflows/LastRunIoPanel.tsx");
    const isolation = source("src/components/isolation/IsolationExercise.tsx");
    const alert = source("src/components/alerts/AlertSeverityBadge.tsx");
    const peakEnd = source("src/lib/peak-end-operate-endings.ts");

    assert.match(badge, /LOUD_INDETERMINATE_CLASS/);
    assert.match(badge, /LOUD_ERROR_CLASS/);
    assert.equal(statusStaysIconPlusText(badge), true);
    assert.match(lastRun, /LOUD_INDETERMINATE_CLASS/);
    assert.match(lastRun, /LOUD_ERROR_CLASS/);
    assert.equal(statusStaysIconPlusText(lastRun), true);
    assert.match(ndvIo, /LOUD_INDETERMINATE_SURFACE|LOUD_INDETERMINATE_CLASS|border-2 border-amber-700/);
    assert.match(peakEnd, /LOUD_INDETERMINATE_SURFACE/);
    assert.match(peakEnd, /LOUD_ERROR_SURFACE/);
    assert.match(alert, /LOUD_WARNING_CLASS/);
    assert.match(isolation, /LOUD_ADV024_DENIAL_CLASS/);
    assert.match(isolation, /ISOLATION_DENIAL_ICON/);
    assert.match(isolation, /ISOLATION_DENIAL_LABEL/);
    assert.equal(ISOLATION_DENIAL_LABEL, "Denial");
    assert.equal(ISOLATION_LEAK_LABEL, "Did not hold");
    assert.equal(ISOLATION_DENIAL_ICON.length > 0, true);
    assert.equal(ISOLATION_LEAK_ICON.length > 0, true);
    assert.equal(AESTHETIC_USABILITY.loudStatusDoesNotGetQuieter, true);
    assert.equal(AESTHETIC_USABILITY.statusStaysIconPlusText, true);
    assert.equal(REWRITE_SATELLITE_A11Y.iconPlusText, true);
  });

  it("does not invent surfaces, n8n clone tokens, isolation pass copy, or KEK chrome", () => {
    for (const relative of AESTHETIC_USABILITY_SOURCES) {
      if (relative === "src/lib/aesthetic-usability-density.ts") {
        continue;
      }
      const text = source(relative);
      assert.equal(clonedN8nTokenPresent(text), false, relative);
      assert.equal(inventedSurfacePresent(text), false, relative);
    }
    for (const relative of ISOLATION_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(isolationCopyCallsSuccessAPass(text), false, relative);
    }
    for (const relative of PRODUCT_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(kekAppearsInProductChrome(text), false, relative);
    }
    const isolation = source("src/components/isolation/IsolationExercise.tsx");
    assert.match(isolation, /denial/i);
    assert.doesNotMatch(isolation, /\bpass\b/i);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial, true);
    assert.equal(AESTHETIC_USABILITY.noNewSurfaces, true);
    assert.equal(AESTHETIC_USABILITY.noClonedN8nColorsIconsMeasurements, true);
    assert.equal(AESTHETIC_USABILITY.noKekSecretChrome, true);
    assert.deepEqual([...KEK_CHROME_TOKENS], ["CREDENTIAL_KEK", "keyReference"]);
  });

  it("holds hard lines and inherits UXL.1–UXL.7 / UX.10 / R7.4", () => {
    assert.equal(aestheticUsabilityHoldsHardLines(), true);
    assert.equal(aestheticUsabilityInheritsPriorStories(), true);
    assert.equal(AESTHETIC_USABILITY.yamlIsSourceOfTruth, true);
    assert.equal(AESTHETIC_USABILITY.draftsNeverRun, true);
    assert.equal(AESTHETIC_USABILITY.vaultDisplayNameUuidOnly, true);
    assert.equal(AESTHETIC_USABILITY.oneReplayPath, true);
    assert.equal(AESTHETIC_USABILITY.loudIndeterminate, true);
    assert.equal(AESTHETIC_USABILITY.failClosedCatalogs, true);
    assert.equal(AESTHETIC_USABILITY.notAnN8nClone, true);
    assert.equal(AESTHETIC_USABILITY.noKekInBrowser, true);
    assert.equal(AESTHETIC_USABILITY.d3TriggersAreWorkflowLevel, true);
    assert.equal(R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1, true);
    assert.equal(R7_HARD_LINE.adv024MembershipIsolationStayGrantGated, true);
    assert.match(SATELLITE_HEADER_CLASS, /px-3 py-2/);
    assert.match(SATELLITE_TITLE_CLASS, /text-sm font-medium/);
    assert.match(SATELLITE_HIDE_BUTTON_CLASS, /text-xs/);
    assert.match(SATELLITE_RAIL_BUTTON_CLASS, /rotate-180/);
    assert.match(TYPE_PAGE_HELP_CLASS, /leading-7/);
  });
});
