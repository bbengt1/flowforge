import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OVERVIEW_EMPTY,
  overviewEmptyKeepsUxl6AndF5Verbs,
  overviewEmptyUsesCardChrome,
} from "./overview-empty-states.ts";
import { OVERVIEW_EMBED } from "./overview-embed.ts";
import {
  OVERVIEW_CARD_SURFACE_CLASS,
  OVERVIEW_HOME,
  overviewCardListIsPrimary,
  overviewHasSearchSortFilterRow,
} from "./overview-home.ts";
import {
  OVERVIEW_PATH_PILLS,
  overviewCardsShowPathPills,
  overviewFinderRailIsCompactFilterOnly,
  overviewUnfiledHasNoFakeFolder,
} from "./overview-path-pills.ts";
import {
  FF_OVERVIEW_CARD_CLASS,
  FF_OVERVIEW_CREATE_CLASS,
  FF_OVERVIEW_HEADER_CLASS,
  FF_OVERVIEW_RAIL_CLASS,
  LIGHT_OVERVIEW_TOKENS,
  N8N_OVERVIEW_TAB_TOKENS,
  OVERVIEW_VISUAL,
  V3_BRIEF,
  V3_CHROME_SOURCES,
  V3_EPIC,
  V3_HELP,
  V3_ID,
  V3_KEEP_STORY_OPEN,
  V3_SOURCES,
  V3_STORY,
  V3_TOKEN_FILE,
  overviewCardClassIsDarkTokenRow,
  overviewChromeRejectsForbiddenLook,
  overviewChromeRejectsLightLook,
  overviewEmbedSharesWorkflowHome,
  overviewMoveIsPatchFolderIdOnly,
  overviewRejectsDeferredIa,
  overviewRejectsN8nTabs,
  overviewScanEndsAreVisible,
  overviewUsesV1TokenClasses,
  overviewVisualHoldsAcceptance,
  overviewVisualHoldsHardLines,
  overviewVisualInheritsPriorStories,
} from "./overview-visual.ts";
import { F4_HOME_FOLDER, F7_HOME_FOLDER } from "./workflow-folder.ts";
import { FF_ACCENT, FF_CANVAS, FF_SURFACE } from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("V.3 Overview home visual rebuild", () => {
  it("keeps #359 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V3_STORY, 359);
    assert.equal(V3_EPIC, 353);
    assert.equal(V3_KEEP_STORY_OPEN, true);
    assert.equal(V3_ID, "V.3-overview-home-visual-rebuild");
    assert.equal(V3_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(V3_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(OVERVIEW_VISUAL.keep359Open, true);
    assert.equal(OVERVIEW_VISUAL.uiOnly, true);
    assert.equal(OVERVIEW_VISUAL.jonnyNoneExpected, true);
    assert.match(V3_HELP, /Dark card rows/);
    assert.match(V3_HELP, /Not an n8n clone/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /dark card/i);
  });

  it("locks dark card rows on V.1 tokens", () => {
    const globals = source("src/app/globals.css");
    const home = source("src/components/home/WorkflowHome.tsx");
    const contract = source("src/lib/overview-home.ts");
    assert.equal(overviewUsesV1TokenClasses(globals), true);
    assert.equal(overviewCardClassIsDarkTokenRow(), true);
    assert.equal(OVERVIEW_CARD_SURFACE_CLASS, FF_OVERVIEW_CARD_CLASS);
    assert.match(contract, /ff-overview-card/);
    assert.match(home, /OVERVIEW_CARD_SURFACE_CLASS/);
    assert.match(home, /FF_OVERVIEW_CARD_ROW_CLASS/);
    assert.match(home, /data-ff-overview/);
    assert.match(home, /FF_OVERVIEW_VALUE/);
    assert.match(globals, /\.ff-overview-card/);
    assert.match(globals, /background: var\(--ff-surface\)/);
    assert.match(globals, /var\(--ff-border\)/);
    assert.match(globals, /var\(--ff-radius\)/);
    assert.equal(OVERVIEW_VISUAL.darkCardRows, true);
    assert.equal(OVERVIEW_VISUAL.inheritV1Tokens, true);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_SURFACE, "#171b22");
    assert.equal(FF_ACCENT, "#0f766e");
  });

  it("locks header + Create, search/sort/filter, path pills, kebab, and scan ends", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewCardListIsPrimary(home), true);
    assert.equal(overviewHasSearchSortFilterRow(home), true);
    assert.equal(overviewCardsShowPathPills(home), true);
    assert.equal(overviewScanEndsAreVisible(home), true);
    assert.match(home, /data-o1="overview-header"/);
    assert.match(home, /data-o1="create"/);
    assert.match(home, /FF_OVERVIEW_CREATE_CLASS/);
    assert.match(home, /data-o1="toolbar"/);
    assert.match(home, /data-o1="sort"/);
    assert.match(home, /data-o1="filter"/);
    assert.match(home, /data-o2="path-pills"/);
    assert.match(home, /data-o1="published"/);
    assert.match(home, /data-o1="kebab"/);
    assert.match(home, /HomeActivationStatus/);
    assert.match(home, /HomeLastRunStatus/);
    assert.match(home, /FF_OVERVIEW_SCAN_LEAD_CLASS/);
    assert.match(home, /FF_OVERVIEW_SCAN_TRAIL_CLASS/);
    assert.equal(OVERVIEW_VISUAL.headerHasCreateCta, true);
    assert.equal(OVERVIEW_VISUAL.searchSortFilterRow, true);
    assert.equal(OVERVIEW_VISUAL.pathPillsStay, true);
    assert.equal(OVERVIEW_VISUAL.kebabStays, true);
    assert.equal(OVERVIEW_VISUAL.publishedActivationLastRunAtScanEnds, true);
  });

  it("keeps the compact Finder rail filter-only and Unfiled without pills", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewFinderRailIsCompactFilterOnly(home), true);
    assert.equal(overviewUnfiledHasNoFakeFolder(home), true);
    assert.match(home, /data-o2="finder-rail"/);
    assert.match(home, /data-o2="disclosure"/);
    assert.match(home, /data-home-folder-rail="unfiled"/);
    assert.match(home, /FF_OVERVIEW_RAIL_CLASS/);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.doesNotMatch(home, /data-miller|Miller columns/);
    assert.equal(OVERVIEW_PATH_PILLS.compactFinderRail, true);
    assert.equal(OVERVIEW_PATH_PILLS.unfiledHasNoPathPills, true);
    assert.equal(OVERVIEW_VISUAL.compactFinderRailFilterOnly, true);
    assert.equal(OVERVIEW_VISUAL.nonRecursiveFolderIdStays, true);
    assert.equal(OVERVIEW_VISUAL.unfiledHasNoPills, true);
    assert.equal(OVERVIEW_VISUAL.noMillerColumns, true);
  });

  it("skips stats, Personal, link-count, and n8n Overview tabs", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewRejectsDeferredIa(home), true);
    assert.equal(overviewRejectsN8nTabs(home), true);
    assert.doesNotMatch(home, /data-o1="stats"/);
    assert.doesNotMatch(home, /data-o1="personal"/);
    assert.doesNotMatch(home, /data-o1="link-count"/);
    assert.doesNotMatch(home, /Prod\. executions|Time saved|Personal badge/);
    for (const token of N8N_OVERVIEW_TAB_TOKENS) {
      assert.equal(home.includes(token), false, token);
    }
    assert.equal(OVERVIEW_VISUAL.noStats, true);
    assert.equal(OVERVIEW_VISUAL.noPersonal, true);
    assert.equal(OVERVIEW_VISUAL.noLinkCount, true);
    assert.equal(OVERVIEW_VISUAL.noN8nOverviewTabs, true);
    assert.equal(OVERVIEW_HOME.statsStripSkipped, true);
  });

  it("holds UXL.6 / O.3 empty states, PATCH folderId move, and shared WorkflowHome on embed", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewEmptyUsesCardChrome(home), true);
    assert.equal(overviewEmptyKeepsUxl6AndF5Verbs(home), true);
    assert.equal(overviewMoveIsPatchFolderIdOnly(home), true);
    assert.equal(overviewEmbedSharesWorkflowHome(home), true);
    assert.match(home, /data-o3="empty-card"/);
    assert.match(home, /data-uxl6="home-empty"/);
    assert.match(home, /moveWorkflowToFolder/);
    assert.match(home, /folderIdForMove/);
    assert.match(home, /data-o4=/);
    assert.equal(OVERVIEW_EMPTY.emptyHomeUsesCardChrome, true);
    assert.equal(OVERVIEW_VISUAL.emptyStatesStayUxl6O3, true);
    assert.equal(OVERVIEW_VISUAL.moveStillPatchFolderIdOnly, true);
    assert.equal(OVERVIEW_VISUAL.sameWorkflowHomeOnEmbed, true);
    assert.equal(F4_HOME_FOLDER.dragAndMenuCallSamePatch, true);
    assert.equal(F7_HOME_FOLDER.sameWorkflowHomeNoSecondTree, true);
    assert.equal(OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree, true);
  });

  it("rejects leftover light chrome, n8n orange, and a second theme tree", () => {
    for (const relative of V3_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(overviewChromeRejectsForbiddenLook(text), true, relative);
      assert.equal(overviewChromeRejectsLightLook(text), true, relative);
      for (const token of LIGHT_OVERVIEW_TOKENS) {
        assert.equal(text.includes(token), false, `${relative} ${token}`);
      }
    }
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewVisualHoldsAcceptance(home), true);
    assert.equal(OVERVIEW_VISUAL.noN8nOrange, true);
    assert.equal(OVERVIEW_VISUAL.noSecondThemeTree, true);
    assert.equal(OVERVIEW_VISUAL.notAnN8nClone, true);
    const tokens = source(V3_TOKEN_FILE);
    assert.doesNotMatch(tokens, /#f97316|#ea4b71|#ff6d5a/);
  });

  it("holds hard lines and inherits F / O / UXL stories", () => {
    assert.equal(overviewVisualHoldsHardLines(), true);
    assert.equal(overviewVisualInheritsPriorStories(), true);
    assert.equal(OVERVIEW_VISUAL.yamlIsSourceOfTruth, true);
    assert.equal(OVERVIEW_VISUAL.draftsNeverRun, true);
    assert.equal(OVERVIEW_VISUAL.foldersNotInYaml, true);
    assert.equal(OVERVIEW_VISUAL.vaultDisplayNameUuidOnly, true);
    assert.equal(OVERVIEW_VISUAL.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(OVERVIEW_VISUAL.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(OVERVIEW_VISUAL.isolationSuccessIsDenial, true);
    assert.equal(OVERVIEW_VISUAL.unfiledIsVirtual, true);
    assert.equal(OVERVIEW_VISUAL.refuseIfNonemptyDelete, true);
    assert.equal(OVERVIEW_VISUAL.noGreenfieldApis, true);
    assert.equal(OVERVIEW_HOME.keep325Open, true);
    assert.equal(OVERVIEW_PATH_PILLS.keep326Open, true);
    assert.equal(OVERVIEW_EMPTY.keep327Open, true);
    assert.equal(OVERVIEW_EMBED.keep328Open, true);
    for (const path of V3_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
    assert.ok(FF_OVERVIEW_HEADER_CLASS);
    assert.ok(FF_OVERVIEW_RAIL_CLASS);
    assert.ok(FF_OVERVIEW_CREATE_CLASS);
  });
});
