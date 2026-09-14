import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOME_EMPTY_CREATE_LABEL,
  HOME_EMPTY_HELP,
  HOME_EMPTY_IMPORT_LABEL,
  HOME_EMPTY_TEMPLATE_HELP,
  HOME_EMPTY_TEMPLATE_LABEL,
} from "./empty-states-teach-model.ts";
import {
  O3_BRIEF,
  O3_EPIC,
  O3_ID,
  O3_KEEP_STORY_OPEN,
  O3_STORY,
  OVERVIEW_EMPTY,
  OVERVIEW_EMPTY_DENSE_LIST_TOKENS,
  OVERVIEW_EMPTY_HELP,
  OVERVIEW_EMPTY_SOURCES,
  overviewEmptyDoesNotRegressCardsOrRail,
  overviewEmptyHoldsHardLines,
  overviewEmptyInheritsPriorStories,
  overviewEmptyKeepsUxl6AndF5Verbs,
  overviewEmptySaysDraftsDoNotRun,
  overviewEmptyShowsDeveloperFixtures,
  overviewEmptyUsesCardChrome,
} from "./overview-empty-states.ts";
import {
  OVERVIEW_CARD_SURFACE_CLASS,
  OVERVIEW_HOME,
  overviewCardListIsPrimary,
} from "./overview-home.ts";
import {
  OVERVIEW_PATH_PILLS,
  overviewCardsShowPathPills,
  overviewFinderRailIsCompactFilterOnly,
  overviewUnfiledHasNoFakeFolder,
} from "./overview-path-pills.ts";
import {
  F5_HOME_FOLDER,
  F5_KEEP_STORY_OPEN,
  FOLDER_EMPTY_CREATE_LABEL,
  FOLDER_EMPTY_HELP,
  FOLDER_EMPTY_MOVE_LABEL,
  NEW_FOLDER_LABEL,
  UNFILED_EMPTY_NONE_HELP,
  emptyFolderDeleteAllowed,
} from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("O.3 Empty / Unfiled states on Overview cards", () => {
  it("keeps #327 open and cites epic #324", () => {
    assert.equal(O3_STORY, 327);
    assert.equal(O3_EPIC, 324);
    assert.equal(O3_KEEP_STORY_OPEN, true);
    assert.equal(O3_ID, "O.3-empty-unfiled-states-overview-cards");
    assert.equal(O3_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(OVERVIEW_EMPTY.keep327Open, true);
    assert.equal(OVERVIEW_EMPTY.noJonnyChange, true);
    assert.equal(OVERVIEW_EMPTY.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /#327/);
    assert.match(frontend, /keep #327 open/i);
    assert.match(frontend, /card chrome/i);
  });

  it("locks empty-home / empty-folder / Unfiled-empty on card chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const page = source("src/app/workflows/page.tsx");
    assert.equal(overviewEmptyUsesCardChrome(home), true);
    assert.match(
      home,
      /data-o3=\{unfiledEmpty \? "unfiled-empty" : "empty-home"\}/,
    );
    assert.match(home, /data-o3="empty-folder"/);
    assert.match(home, /data-o3="unfiled-empty"/);
    assert.match(home, /data-o3="empty-card"/);
    assert.match(home, /OVERVIEW_CARD_SURFACE_CLASS/);
    assert.match(home, /data-o1="card-list"/);
    assert.match(home, /data-o1="card"/);
    assert.match(home, /data-uxl6="home-empty"/);
    assert.match(
      home,
      /data-f5=\{unfiledEmpty \? "unfiled-empty-none" : "home-empty"\}/,
    );
    assert.match(home, /data-f5="folder-empty"/);
    assert.match(home, /data-f5="unfiled-empty-filed"/);
    assert.match(home, /"unfiled-empty-none"/);
    for (const token of OVERVIEW_EMPTY_DENSE_LIST_TOKENS) {
      assert.equal(home.includes(token), false, token);
    }
    assert.doesNotMatch(home, /border-dashed/);
    assert.match(OVERVIEW_CARD_SURFACE_CLASS, /border-zinc-200/);
    assert.equal(OVERVIEW_CARD_SURFACE_CLASS.includes("border-dashed"), false);
    assert.match(page, /card chrome/i);
    assert.equal(OVERVIEW_EMPTY.emptyHomeUsesCardChrome, true);
    assert.equal(OVERVIEW_EMPTY.emptyFolderUsesCardChrome, true);
    assert.equal(OVERVIEW_EMPTY.unfiledEmptyUsesCardChrome, true);
    assert.equal(OVERVIEW_EMPTY.notDenseListEmptyChrome, true);
  });

  it("keeps UXL.6 + F.5 verbs and teaches drafts do not run", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewEmptyKeepsUxl6AndF5Verbs(home), true);
    assert.equal(overviewEmptySaysDraftsDoNotRun(home), true);
    assert.equal(HOME_EMPTY_CREATE_LABEL, "Create");
    assert.equal(HOME_EMPTY_IMPORT_LABEL, "Import YAML");
    assert.equal(HOME_EMPTY_TEMPLATE_LABEL, "Create draft");
    assert.equal(NEW_FOLDER_LABEL, "New folder");
    assert.equal(FOLDER_EMPTY_CREATE_LABEL, "Create here");
    assert.equal(FOLDER_EMPTY_MOVE_LABEL, "Move existing");
    assert.match(HOME_EMPTY_HELP, /drafts do not run/i);
    assert.match(HOME_EMPTY_TEMPLATE_HELP, /drafts do not run/i);
    assert.match(FOLDER_EMPTY_HELP, /drafts do not run/i);
    assert.match(UNFILED_EMPTY_NONE_HELP, /drafts do not run/i);
    assert.match(OVERVIEW_EMPTY_HELP, /drafts do not run/i);
    assert.match(home, /HOME_EMPTY_CREATE_LABEL/);
    assert.match(home, /HOME_EMPTY_IMPORT_LABEL/);
    assert.match(home, /HOME_EMPTY_TEMPLATE_LABEL/);
    assert.match(home, /data-home-empty-verb="new-folder"/);
    assert.match(home, /data-home-folder-empty-verb="create"/);
    assert.match(home, /data-home-folder-empty-verb="move"/);
    assert.match(home, /data-home-folder-empty-verb="delete"/);
    assert.equal(OVERVIEW_EMPTY.keepUxl6CreateImportTemplate, true);
    assert.equal(OVERVIEW_EMPTY.keepF5NewFolder, true);
    assert.equal(OVERVIEW_EMPTY.copyTeachesDraftsDoNotRun, true);
    assert.equal(F5_HOME_FOLDER.emptyHomeKeepsUxl6Verbs, true);
  });

  it("does not promote Developer fixtures; Unfiled stays virtual; delete refuses nonempty", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewEmptyShowsDeveloperFixtures(home), false);
    assert.equal(home.includes("Load starter YAML"), false);
    assert.equal(home.includes("Load invalid YAML"), false);
    assert.doesNotMatch(home, /\/actions/);
    assert.match(home, /data-home-folder-rail="unfiled"/);
    assert.match(home, /UNFILED_FOLDER_LABEL/);
    assert.match(home, /emptyFolderDeleteAllowed/);
    assert.match(home, /FOLDER_NOT_EMPTY_HELP/);
    assert.equal(
      emptyFolderDeleteAllowed({ childFolderCount: 0, workflowCount: 0 }),
      true,
    );
    assert.equal(
      emptyFolderDeleteAllowed({ childFolderCount: 1, workflowCount: 0 }),
      false,
    );
    assert.equal(
      emptyFolderDeleteAllowed({ childFolderCount: 0, workflowCount: 2 }),
      false,
    );
    assert.equal(OVERVIEW_EMPTY.noDeveloperFixtures, true);
    assert.equal(OVERVIEW_EMPTY.unfiledIsVirtual, true);
    assert.equal(OVERVIEW_EMPTY.refuseIfNonemptyDelete, true);
    assert.equal(F5_KEEP_STORY_OPEN, true);
    assert.equal(F5_HOME_FOLDER.unfiledIsNotPersisted, true);
    assert.equal(F5_HOME_FOLDER.refuseIfNonemptyStays, true);
  });

  it("does not regress O.1 cards, O.2 path pills, or compact Finder rail", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewEmptyDoesNotRegressCardsOrRail(home), true);
    assert.equal(overviewCardListIsPrimary(home), true);
    assert.equal(overviewCardsShowPathPills(home), true);
    assert.equal(overviewFinderRailIsCompactFilterOnly(home), true);
    assert.equal(overviewUnfiledHasNoFakeFolder(home), true);
    assert.equal(overviewEmptyInheritsPriorStories(), true);
    assert.equal(OVERVIEW_HOME.cardsArePrimaryBrowseSurface, true);
    assert.equal(OVERVIEW_PATH_PILLS.compactFinderRail, true);
    assert.equal(OVERVIEW_PATH_PILLS.pathPillsFromAncestry, true);
    assert.equal(OVERVIEW_EMPTY.inheritO1CardList, true);
    assert.equal(OVERVIEW_EMPTY.inheritO2PathPills, true);
    assert.equal(OVERVIEW_EMPTY.inheritO2FinderRail, true);
    assert.match(home, /data-o1="overview-header"/);
    assert.match(home, /data-o2="finder-rail"/);
    assert.match(home, /data-o2="path-pills"/);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
  });

  it("holds hard lines and stays independent FlowForge chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(overviewEmptyHoldsHardLines(), true);
    assert.equal(OVERVIEW_EMPTY.yamlIsSourceOfTruth, true);
    assert.equal(OVERVIEW_EMPTY.foldersNotInYaml, true);
    assert.equal(OVERVIEW_EMPTY.draftsNeverRun, true);
    assert.equal(OVERVIEW_EMPTY.notAnN8nClone, true);
    assert.equal(OVERVIEW_EMPTY.noKekInBrowser, true);
    assert.equal(OVERVIEW_EMPTY.noJonnyChange, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    assert.doesNotMatch(home, /data-o1="stats"|data-o1="personal"|data-o1="link-count"/);
    for (const path of OVERVIEW_EMPTY_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
