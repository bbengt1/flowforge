import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  O2_BRIEF,
  O2_EPIC,
  O2_ID,
  O2_KEEP_STORY_OPEN,
  O2_STORY,
  OVERVIEW_FINDER_RAIL_HELP,
  OVERVIEW_PATH_PILLS,
  OVERVIEW_PATH_PILLS_HELP,
  OVERVIEW_PATH_PILLS_MILLER_TOKENS,
  OVERVIEW_PATH_PILLS_RECURSIVE_TOKENS,
  OVERVIEW_PATH_PILLS_SOURCES,
  overviewAncestryPills,
  overviewCardsShowPathPills,
  overviewFinderRailIsCompactFilterOnly,
  overviewFolderIdIsUnfiled,
  overviewPathPillsHoldHardLines,
  overviewPathPillsInheritFolderStories,
  overviewPillsDoNotBreakFolderBrowse,
  overviewPillsInventPersistedUnfiled,
  overviewUnfiledHasNoFakeFolder,
  overviewUnfiledHasNoPathPills,
} from "./overview-path-pills.ts";
import { OVERVIEW_HOME } from "./overview-home.ts";
import {
  F2_KEEP_STORY_OPEN,
  F3_KEEP_STORY_OPEN,
  F4_KEEP_STORY_OPEN,
  F6_KEEP_STORY_OPEN,
  UNFILED_FOLDER_ID,
  UNFILED_FOLDER_LABEL,
  type WorkflowFolder,
} from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

const ops: WorkflowFolder = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  parentId: null,
  name: "Ops",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

const oncall: WorkflowFolder = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: ops.workspaceId,
  parentId: ops.id,
  name: "On-call",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

const night: WorkflowFolder = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: ops.workspaceId,
  parentId: oncall.id,
  name: "Night",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

const platform: WorkflowFolder = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: ops.workspaceId,
  parentId: null,
  name: "Platform",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

const folders = [ops, oncall, night, platform];

describe("O.2 Path pills + compact Finder rail", () => {
  it("keeps #326 open and cites epic #324", () => {
    assert.equal(O2_STORY, 326);
    assert.equal(O2_EPIC, 324);
    assert.equal(O2_KEEP_STORY_OPEN, true);
    assert.equal(O2_ID, "O.2-path-pills-compact-finder-rail");
    assert.equal(O2_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(OVERVIEW_PATH_PILLS.keep326Open, true);
    assert.equal(OVERVIEW_PATH_PILLS.noJonnyChange, true);
    assert.equal(OVERVIEW_PATH_PILLS.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /path pills/i);
    assert.match(frontend, /Finder rail/i);
  });

  it("joins path pills from GET /workflow-folders ancestry root → parent → folder", () => {
    const nested = overviewAncestryPills(folders, night.id);
    assert.deepEqual(
      nested.map((pill) => pill.name),
      ["Ops", "On-call", "Night"],
    );
    assert.deepEqual(
      nested.map((pill) => pill.id),
      [ops.id, oncall.id, night.id],
    );
    assert.deepEqual(
      overviewAncestryPills(folders, oncall.id).map((pill) => pill.name),
      ["Ops", "On-call"],
    );
    assert.deepEqual(overviewAncestryPills(folders, ops.id), [
      { id: ops.id, name: "Ops" },
    ]);
    assert.deepEqual(overviewAncestryPills(folders, platform.id), [
      { id: platform.id, name: "Platform" },
    ]);
    assert.equal(OVERVIEW_PATH_PILLS.pathPillsFromAncestry, true);
    assert.equal(OVERVIEW_PATH_PILLS.ancestryOrderRootToFolder, true);
    assert.match(OVERVIEW_PATH_PILLS_HELP, /GET \/workflow-folders ancestry/);
    const home = source("src/components/home/WorkflowHome.tsx");
    const contract = source("src/lib/overview-path-pills.ts");
    assert.equal(overviewCardsShowPathPills(home), true);
    assert.match(home, /data-o2="path-pills"/);
    assert.match(home, /data-o2="path-pill"/);
    assert.match(home, /overviewAncestryPills/);
    assert.match(home, /onSelect\(\{ kind: "folder", id: pill\.id \}\)/);
    assert.match(contract, /folderPath\(/);
    assert.equal(OVERVIEW_PATH_PILLS.pillsClickableToSelectFolder, true);
    assert.equal(
      OVERVIEW_PATH_PILLS.usesExistingListFieldsAndFolderAncestry,
      true,
    );
  });

  it("gives Unfiled no path pills and does not invent a persisted folder", () => {
    assert.equal(overviewFolderIdIsUnfiled(null), true);
    assert.equal(overviewFolderIdIsUnfiled(undefined), true);
    assert.equal(overviewFolderIdIsUnfiled(""), true);
    assert.equal(overviewFolderIdIsUnfiled(UNFILED_FOLDER_ID), true);
    assert.equal(overviewFolderIdIsUnfiled(oncall.id), false);
    const unfiled = overviewAncestryPills(folders, null);
    assert.deepEqual(unfiled, []);
    assert.equal(overviewUnfiledHasNoPathPills(unfiled), true);
    assert.equal(overviewPillsInventPersistedUnfiled(unfiled), false);
    assert.deepEqual(overviewAncestryPills(folders, UNFILED_FOLDER_ID), []);
    assert.deepEqual(overviewAncestryPills(folders, "  "), []);
    const unknown = overviewAncestryPills(folders, "99999999-9999-4999-8999-999999999999");
    assert.deepEqual(unknown, []);
    assert.equal(overviewPillsInventPersistedUnfiled(unknown), false);
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewUnfiledHasNoFakeFolder(home), true);
    assert.match(home, /data-o2="unfiled"/);
    assert.doesNotMatch(home, /data-o2="path-pill"[\s\S]{0,80}UNFILED_FOLDER_ID/);
    assert.equal(OVERVIEW_PATH_PILLS.unfiledHasNoPathPills, true);
    assert.equal(OVERVIEW_PATH_PILLS.unfiledIsNotAPersistedFolder, true);
    assert.equal(OVERVIEW_PATH_PILLS.unfiledIsVirtual, true);
    assert.equal(UNFILED_FOLDER_LABEL, "Unfiled");
    assert.match(OVERVIEW_PATH_PILLS_HELP, /not a persisted folder/);
  });

  it("locks compact Finder rail as disclosure + icons and filter-only / non-recursive", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewFinderRailIsCompactFilterOnly(home), true);
    assert.match(home, /data-o2="finder-rail"/);
    assert.match(home, /data-o2="disclosure"/);
    assert.match(home, /data-o2="folder-icon"/);
    assert.match(home, /data-o2="unfiled-icon"/);
    assert.match(home, /data-home-folder-rail="unfiled"/);
    assert.match(home, /selectedFolderListFolderId/);
    assert.match(home, /folderHomeListMode/);
    assert.match(home, /constrainItemsToFolderSelection/);
    assert.match(home, /data-home-folder-verb=\{explorerMenuFolderVerb/);
    assert.match(home, /data-x2="context-menu"/);
    assert.match(home, /FOLDER_MOVE_VERB/);
    for (const token of OVERVIEW_PATH_PILLS_MILLER_TOKENS) {
      assert.equal(home.includes(token), false, token);
    }
    for (const token of OVERVIEW_PATH_PILLS_RECURSIVE_TOKENS) {
      assert.doesNotMatch(home, new RegExp(token));
    }
    assert.equal(OVERVIEW_PATH_PILLS.compactFinderRail, true);
    assert.equal(OVERVIEW_PATH_PILLS.railDisclosureAndFolderIcons, true);
    assert.equal(OVERVIEW_PATH_PILLS.railIsFilterOnly, true);
    assert.equal(OVERVIEW_PATH_PILLS.notMillerColumns, true);
    assert.equal(OVERVIEW_PATH_PILLS.notPrimaryBrowse, true);
    assert.equal(OVERVIEW_PATH_PILLS.cardsArePrimaryBrowseSurface, true);
    assert.equal(OVERVIEW_HOME.cardsArePrimaryBrowseSurface, true);
    assert.match(OVERVIEW_FINDER_RAIL_HELP, /not Miller columns/);
    assert.match(OVERVIEW_FINDER_RAIL_HELP, /that folder only/);
  });

  it("does not regress F.2 deep link or F.6 search", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewPillsDoNotBreakFolderBrowse(home), true);
    assert.equal(overviewPathPillsInheritFolderStories(), true);
    assert.equal(F2_KEEP_STORY_OPEN, true);
    assert.equal(F3_KEEP_STORY_OPEN, true);
    assert.equal(F4_KEEP_STORY_OPEN, true);
    assert.equal(F6_KEEP_STORY_OPEN, true);
    assert.equal(OVERVIEW_PATH_PILLS.inheritF2DeepLink, true);
    assert.equal(OVERVIEW_PATH_PILLS.inheritF6Search, true);
    assert.equal(OVERVIEW_PATH_PILLS.inheritF4Move, true);
    assert.equal(OVERVIEW_PATH_PILLS.nonRecursiveFolderIdStays, true);
    assert.match(home, /FOLDER_QUERY/);
    assert.match(home, /data-f6="search"/);
    assert.match(home, /FOLDER_SEARCH_ACROSS_LABEL/);
    assert.match(home, /FOLDER_SEARCH_IN_FOLDER_LABEL/);
    assert.match(home, /searchInThisFolder/);
    assert.match(home, /workflowFolderPathLabel/);
    assert.match(home, /data-home-folder-path/);
    assert.match(home, /intendedFolderSelectionFromUrl/);
  });

  it("holds hard lines and stays independent FlowForge chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewPathPillsHoldHardLines(), true);
    assert.equal(OVERVIEW_PATH_PILLS.yamlIsSourceOfTruth, true);
    assert.equal(OVERVIEW_PATH_PILLS.foldersNotInYaml, true);
    assert.equal(OVERVIEW_PATH_PILLS.draftsNeverRun, true);
    assert.equal(OVERVIEW_PATH_PILLS.notAnN8nClone, true);
    assert.equal(OVERVIEW_PATH_PILLS.noKekInBrowser, true);
    assert.equal(OVERVIEW_PATH_PILLS.noJonnyChange, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of OVERVIEW_PATH_PILLS_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
