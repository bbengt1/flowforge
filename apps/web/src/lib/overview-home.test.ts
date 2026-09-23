import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  O1_BRIEF,
  O1_EPIC,
  O1_ID,
  O1_KEEP_STORY_OPEN,
  O1_STORY,
  OVERVIEW_CARD_LIST_FIELDS,
  OVERVIEW_CREATE_LABEL,
  OVERVIEW_DEFAULT_SORT,
  OVERVIEW_FILTER_LABEL,
  OVERVIEW_HEADING,
  OVERVIEW_HELP,
  OVERVIEW_HOME,
  OVERVIEW_HOME_SOURCES,
  OVERVIEW_KEBAB_LABEL,
  OVERVIEW_PUBLISHED_LABEL,
  OVERVIEW_SKIP_TOKENS,
  OVERVIEW_SORT_LABEL,
  OVERVIEW_SORTS,
  formatOverviewAbsoluteDate,
  formatOverviewRelative,
  overviewAvoidsCloneTokens,
  overviewCardListIsPrimary,
  overviewCardTimestamps,
  overviewDoesNotRegressFolderBrowse,
  overviewHasSearchSortFilterRow,
  overviewHoldsHardLines,
  overviewInheritsFolderStories,
  overviewPublishedBadge,
  overviewPublishedFromStatus,
  overviewSkipsDeferredChrome,
  overviewUsesOnlyListFields,
  sortOverviewHomeItems,
} from "./overview-home.ts";
import { F2_KEEP_STORY_OPEN, F6_KEEP_STORY_OPEN } from "./workflow-folder.ts";
import { buildWorkflowHomeItems, sortWorkflowHomeItems } from "./workflow-home.ts";
import type { WorkflowRecord } from "./workflow-types.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "ops-deploy",
    name: "Deploy app",
    status: "published",
    draftRevision: 3,
    draftDigest: "sha256:aaaa",
    latestVersionNumber: 2,
    latestVersionId: "22222222-2222-4222-8222-222222222222",
    createdBy: "chloe",
    updatedBy: "chloe",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    folderId: null,
    ...overrides,
  };
}

describe("O.1 Overview header + card list", () => {
  it("keeps #325 open and cites epic #324", () => {
    assert.equal(O1_STORY, 325);
    assert.equal(O1_EPIC, 324);
    assert.equal(O1_KEEP_STORY_OPEN, true);
    assert.equal(O1_ID, "O.1-overview-header-card-list");
    assert.equal(O1_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(OVERVIEW_HOME.keep325Open, true);
    assert.equal(OVERVIEW_HOME.noJonnyChange, true);
    assert.equal(OVERVIEW_HOME.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /card list/i);
  });

  it("locks card list as the primary browse surface", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const page = source("src/app/workflows/page.tsx");
    assert.equal(overviewCardListIsPrimary(home), true);
    assert.match(home, /data-o1="card-list"/);
    assert.match(home, /data-o1="card"/);
    assert.match(home, /data-o1="overview-header"/);
    assert.match(home, /data-o1="create"/);
    assert.match(home, /data-o1="kebab"/);
    assert.match(home, /data-o1="published"/);
    assert.match(home, /data-o1="card-name"/);
    assert.match(home, /data-o1="card-dates"/);
    assert.equal(home.includes('aria-label="Workflow home view"'), false);
    assert.equal(home.includes('setView("list")'), false);
    assert.match(home, /OVERVIEW_HEADING/);
    assert.match(home, /OVERVIEW_CREATE_LABEL/);
    assert.match(home, /OVERVIEW_KEBAB_LABEL/);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.match(OVERVIEW_HELP, /card list is the primary browse surface/i);
    assert.equal(OVERVIEW_HOME.cardsArePrimaryBrowseSurface, true);
    assert.equal(OVERVIEW_HOME.headerHasCreateCta, true);
    assert.equal(OVERVIEW_HEADING, "Overview");
    assert.equal(OVERVIEW_CREATE_LABEL, "Create workflow");
    assert.equal(OVERVIEW_KEBAB_LABEL, "Workflow actions");
    assert.match(OVERVIEW_HELP, /card list is the primary browse surface/i);
    assert.match(OVERVIEW_HELP, /Drafts do not run/);
  });

  it("locks the search/sort/filter row", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewHasSearchSortFilterRow(home), true);
    assert.match(home, /data-o1="toolbar"/);
    assert.match(home, /data-o1="sort"/);
    assert.match(home, /data-o1="filter"/);
    assert.match(home, /OVERVIEW_SORT_LABEL/);
    assert.match(home, /OVERVIEW_FILTER_LABEL/);
    assert.deepEqual(
      OVERVIEW_SORTS.map((item) => item.value),
      ["updatedAt", "createdAt", "name"],
    );
    assert.equal(OVERVIEW_DEFAULT_SORT, "updatedAt");
    assert.equal(OVERVIEW_SORT_LABEL, "Sort by");
    assert.equal(OVERVIEW_FILTER_LABEL, "Filter");
    assert.equal(OVERVIEW_HOME.searchSortFilterRow, true);
  });

  it("uses existing list fields only on the card face", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const contract = source("src/lib/overview-home.ts");
    assert.deepEqual([...OVERVIEW_CARD_LIST_FIELDS], [
      "name",
      "createdAt",
      "updatedAt",
      "status",
      "folderId",
    ]);
    assert.equal(overviewUsesOnlyListFields(contract), true);
    assert.match(home, /overviewCardTimestamps/);
    assert.match(home, /overviewPublishedBadge/);
    assert.match(home, /item\.name/);
    assert.match(home, /item\.status/);
    assert.equal(OVERVIEW_HOME.usesExistingListFieldsOnly, true);
    assert.equal(OVERVIEW_HOME.pathPillsWaitForO2, true);
    assert.equal(overviewPublishedFromStatus("published"), true);
    assert.equal(overviewPublishedFromStatus("draft"), false);
    assert.deepEqual(overviewPublishedBadge("published"), {
      shown: true,
      label: OVERVIEW_PUBLISHED_LABEL,
    });
    assert.deepEqual(overviewPublishedBadge("draft"), {
      shown: false,
      label: "",
    });
    const now = Date.parse("2026-09-14T00:00:00Z");
    const dates = overviewCardTimestamps(
      {
        updatedAt: "2026-08-14T00:00:00Z",
        createdAt: "2026-06-21T00:00:00Z",
      },
      now,
    );
    assert.equal(dates.updated, "1 month ago");
    assert.equal(dates.created, formatOverviewAbsoluteDate("2026-06-21T00:00:00Z"));
    assert.match(dates.line, /Last updated 1 month ago/);
    assert.match(dates.line, /Created /);
    assert.equal(formatOverviewRelative("2026-09-14T00:00:00Z", now), "1 minute ago");
  });

  it("sorts by last updated, created, or name from list fields", () => {
    const older = record({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Zebra",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const newer = record({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Alpha",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    const items = buildWorkflowHomeItems([older, newer]);
    assert.deepEqual(
      sortOverviewHomeItems(items, "updatedAt").map((item) => item.name),
      ["Alpha", "Zebra"],
    );
    assert.deepEqual(
      sortOverviewHomeItems(items, "createdAt").map((item) => item.name),
      ["Zebra", "Alpha"],
    );
    assert.deepEqual(
      sortOverviewHomeItems(items, "name").map((item) => item.name),
      ["Alpha", "Zebra"],
    );
    assert.deepEqual(
      sortWorkflowHomeItems(items).map((item) => item.name),
      ["Alpha", "Zebra"],
    );
  });

  it("skips the stats strip, Personal badge, and link-count", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const contract = source("src/lib/overview-home.ts");
    assert.equal(overviewSkipsDeferredChrome(home), true);
    assert.equal(OVERVIEW_HOME.statsStripSkipped, true);
    assert.equal(OVERVIEW_HOME.personalBadgeSkipped, true);
    assert.equal(OVERVIEW_HOME.linkCountSkipped, true);
    for (const token of OVERVIEW_SKIP_TOKENS) {
      if (token.startsWith("data-o1=")) {
        assert.equal(home.includes(token), false, token);
      }
    }
    assert.doesNotMatch(home, /Prod\. executions/);
    assert.doesNotMatch(home, /Failure rate/);
    assert.doesNotMatch(home, /Time saved/);
    assert.doesNotMatch(home, /Personal badge/);
    assert.doesNotMatch(home, /link-count/);
    assert.doesNotMatch(home, /data-o1="stats"/);
    assert.doesNotMatch(home, /data-o1="personal"/);
    assert.doesNotMatch(home, /data-o1="link-count"/);
    assert.match(contract, /stats strip deferred/i);
  });

  it("does not regress F.6 search or F.2 non-recursive folder select", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewDoesNotRegressFolderBrowse(home), true);
    assert.equal(overviewInheritsFolderStories(), true);
    assert.equal(F2_KEEP_STORY_OPEN, true);
    assert.equal(F6_KEEP_STORY_OPEN, true);
    assert.equal(OVERVIEW_HOME.inheritF6Search, true);
    assert.equal(OVERVIEW_HOME.inheritF2RailSelect, true);
    assert.equal(OVERVIEW_HOME.nonRecursiveFolderIdStays, true);
    assert.equal(OVERVIEW_HOME.compactFolderRailMayRemain, true);
    assert.match(home, /data-home-folder-rail/);
    assert.match(home, /data-f6="search"/);
    assert.match(home, /FOLDER_SEARCH_ACROSS_LABEL/);
    assert.match(home, /FOLDER_SEARCH_IN_FOLDER_LABEL/);
    assert.match(home, /searchInThisFolder/);
    assert.match(home, /folderHomeListMode/);
    assert.match(home, /selectedFolderListFolderId/);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
  });

  it("holds hard lines and stays independent FlowForge chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewHoldsHardLines(), true);
    assert.equal(overviewAvoidsCloneTokens(home), true);
    assert.equal(OVERVIEW_HOME.yamlIsSourceOfTruth, true);
    assert.equal(OVERVIEW_HOME.foldersNotInYaml, true);
    assert.equal(OVERVIEW_HOME.draftsNeverRun, true);
    assert.equal(OVERVIEW_HOME.notAnN8nClone, true);
    assert.equal(OVERVIEW_HOME.noKekInBrowser, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of OVERVIEW_HOME_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
