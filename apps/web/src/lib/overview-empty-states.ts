/**
 * O.3: Empty / Unfiled / drafts-do-not-run on Overview cards.
 *
 * Relates to #327 / Part of #324. Keep #327 open.
 *
 * Chloe UI only. Presentation pivot of `/workflows` (D6 in place).
 * Empty home / empty folder / Unfiled-empty use Overview card
 * chrome — not the old dense-list dashed empty panel. UXL.6 + F.5
 * verbs stay: Create / Import YAML / reviewed template / New
 * folder. Copy still teaches drafts do not run. No Developer
 * fixtures. Unfiled stays virtual. Empty-folder delete still
 * refuse-if-nonempty.
 *
 * Existing `GET /workflows` + `GET /workflow-folders` only. No
 * jonny change. Skip Personal / link-count / stats.
 *
 * Hard lines: YAML source · drafts never run · ADV-021/024 ·
 * folders not in YAML · Unfiled virtual · refuse-if-nonempty
 * delete · not an n8n clone · no KEK.
 */

import { OVERVIEW_CARD_SURFACE_CLASS, OVERVIEW_HOME } from "./overview-home.ts";
import { OVERVIEW_PATH_PILLS } from "./overview-path-pills.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  EMPTY_STATE_DEVELOPER_FIXTURE_TOKENS,
  HOME_EMPTY_CREATE_LABEL,
  HOME_EMPTY_HELP,
  HOME_EMPTY_IMPORT_LABEL,
  HOME_EMPTY_TEMPLATE_HELP,
  HOME_EMPTY_TEMPLATE_LABEL,
} from "./empty-states-teach-model.ts";
import {
  F5_HOME_FOLDER,
  FOLDER_EMPTY_CREATE_LABEL,
  FOLDER_EMPTY_HELP,
  FOLDER_EMPTY_MOVE_LABEL,
  NEW_FOLDER_LABEL,
  UNFILED_EMPTY_NONE_HELP,
  emptyFolderDeleteAllowed,
} from "./workflow-folder.ts";

export const O3_STORY = 327;
export const O3_EPIC = 324;
export const O3_KEEP_STORY_OPEN = true;
export const O3_ID = "O.3-empty-unfiled-states-overview-cards" as const;
export const O3_BRIEF = "docs/internal/flowforge-workflow-folders.md";

export const OVERVIEW_EMPTY_HELP =
  "Empty home, empty folder, and Unfiled-empty use Overview card chrome. Create, Import YAML, a reviewed template, or New folder still create a draft. Drafts do not run — publish, then start a published version.";

export const OVERVIEW_EMPTY_DENSE_LIST_TOKENS = [
  "border-dashed",
  'aria-label="Workflow home view"',
  'setView("list")',
  "data-home-view",
] as const;

export const OVERVIEW_EMPTY = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritO1CardList: true,
  inheritO2PathPills: true,
  inheritO2FinderRail: true,
  inheritUxl6Verbs: true,
  inheritF5EmptyVerbs: true,
  inheritF1ThroughF7: true,
  d6MigrateInPlace: true,
  emptyHomeUsesCardChrome: true,
  emptyFolderUsesCardChrome: true,
  unfiledEmptyUsesCardChrome: true,
  notDenseListEmptyChrome: true,
  keepUxl6CreateImportTemplate: true,
  keepF5NewFolder: true,
  copyTeachesDraftsDoNotRun: true,
  noDeveloperFixtures: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  cardsArePrimaryBrowseSurface: true,
  compactFinderRailStays: true,
  pathPillsStay: true,
  usesExistingApisOnly: true,
  noJonnyChange: true,
  noNewApi: true,
  statsStripSkipped: true,
  personalBadgeSkipped: true,
  linkCountSkipped: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep327Open: true,
} as const;

export const OVERVIEW_EMPTY_SOURCES = [
  "src/lib/overview-empty-states.ts",
  "src/lib/overview-home.ts",
  "src/lib/overview-path-pills.ts",
  "src/lib/empty-states-teach-model.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export function overviewEmptyUsesCardChrome(source: string): boolean {
  return (
    (source.includes('data-o3="empty-home"') ||
      source.includes(': "empty-home"')) &&
    source.includes('data-o3="empty-folder"') &&
    source.includes('data-o3="unfiled-empty"') &&
    source.includes('data-o3="empty-card"') &&
    source.includes("OVERVIEW_CARD_SURFACE_CLASS") &&
    source.includes('data-o1="card-list"') &&
    source.includes('data-o1="card"') &&
    OVERVIEW_EMPTY_DENSE_LIST_TOKENS.every((token) => !source.includes(token))
  );
}

export function overviewEmptyKeepsUxl6AndF5Verbs(source: string): boolean {
  return (
    source.includes("HOME_EMPTY_CREATE_LABEL") &&
    source.includes("HOME_EMPTY_IMPORT_LABEL") &&
    source.includes("HOME_EMPTY_TEMPLATE_LABEL") &&
    source.includes("createFromYaml") &&
    source.includes("importValidatedWorkflow") &&
    source.includes("createFromTemplate") &&
    source.includes('data-home-empty-verb="new-folder"') &&
    source.includes("NEW_FOLDER_LABEL") &&
    source.includes("FOLDER_EMPTY_CREATE_LABEL") &&
    source.includes("FOLDER_EMPTY_MOVE_LABEL") &&
    source.includes("DELETE_FOLDER_LABEL") &&
    source.includes('data-home-folder-empty-verb="create"') &&
    source.includes('data-home-folder-empty-verb="move"') &&
    source.includes('data-home-folder-empty-verb="delete"') &&
    HOME_EMPTY_CREATE_LABEL === "Create" &&
    HOME_EMPTY_IMPORT_LABEL === "Import YAML" &&
    HOME_EMPTY_TEMPLATE_LABEL === "Create draft" &&
    NEW_FOLDER_LABEL === "New folder" &&
    FOLDER_EMPTY_CREATE_LABEL === "Create here" &&
    FOLDER_EMPTY_MOVE_LABEL === "Move existing"
  );
}

export function overviewEmptySaysDraftsDoNotRun(source: string): boolean {
  return (
    /drafts do not run/i.test(HOME_EMPTY_HELP) &&
    /drafts do not run/i.test(HOME_EMPTY_TEMPLATE_HELP) &&
    /drafts do not run/i.test(FOLDER_EMPTY_HELP) &&
    /drafts do not run/i.test(UNFILED_EMPTY_NONE_HELP) &&
    /drafts do not run/i.test(OVERVIEW_EMPTY_HELP) &&
    (source.includes("HOME_EMPTY_HELP") || source.includes(HOME_EMPTY_HELP)) &&
    (source.includes("FOLDER_EMPTY_HELP") || source.includes(FOLDER_EMPTY_HELP)) &&
    (source.includes("UNFILED_EMPTY_NONE_HELP") ||
      source.includes(UNFILED_EMPTY_NONE_HELP))
  );
}

export function overviewEmptyShowsDeveloperFixtures(source: string): boolean {
  return EMPTY_STATE_DEVELOPER_FIXTURE_TOKENS.some((token) =>
    source.includes(token),
  );
}

export function overviewEmptyDoesNotRegressCardsOrRail(source: string): boolean {
  return (
    source.includes('data-o1="card-list"') &&
    source.includes('data-o1="overview-header"') &&
    source.includes('data-o1="card"') &&
    source.includes("OVERVIEW_CARD_SURFACE_CLASS") &&
    source.includes('data-o2="path-pills"') &&
    source.includes('data-o2="path-pill"') &&
    source.includes('data-o2="finder-rail"') &&
    source.includes('data-o2="disclosure"') &&
    source.includes('data-o2="folder-icon"') &&
    source.includes('data-home-folder-rail="unfiled"') &&
    source.includes("overviewAncestryPills") &&
    source.includes("selectedFolderListFolderId") &&
    source.includes("constrainItemsToFolderSelection") &&
    !/includeDescendants|recursiveFolder|treeWalk|data-miller|Miller columns/i.test(
      source,
    )
  );
}

export function overviewEmptyHoldsHardLines(): boolean {
  return (
    OVERVIEW_EMPTY.yamlIsSourceOfTruth &&
    OVERVIEW_EMPTY.foldersNotInYaml &&
    OVERVIEW_EMPTY.draftsNeverRun &&
    OVERVIEW_EMPTY.vaultDisplayNameUuidOnly &&
    OVERVIEW_EMPTY.adv021ChromeFromSessionEmbedOnly &&
    OVERVIEW_EMPTY.adv024MembershipIsolationStayGrantGated &&
    OVERVIEW_EMPTY.isolationSuccessIsDenial &&
    OVERVIEW_EMPTY.unfiledIsVirtual &&
    OVERVIEW_EMPTY.refuseIfNonemptyDelete &&
    OVERVIEW_EMPTY.notAnN8nClone &&
    OVERVIEW_EMPTY.noKekInBrowser &&
    OVERVIEW_EMPTY.noJonnyChange &&
    OVERVIEW_EMPTY.keep327Open &&
    OVERVIEW_EMPTY.noDeveloperFixtures &&
    F5_HOME_FOLDER.refuseIfNonemptyStays &&
    F5_HOME_FOLDER.unfiledIsNotPersisted &&
    OVERVIEW_HOME.cardsArePrimaryBrowseSurface &&
    OVERVIEW_PATH_PILLS.compactFinderRail &&
    OVERVIEW_PATH_PILLS.unfiledHasNoPathPills &&
    emptyFolderDeleteAllowed({ childFolderCount: 0, workflowCount: 0 }) &&
    !emptyFolderDeleteAllowed({ childFolderCount: 1, workflowCount: 0 }) &&
    !emptyFolderDeleteAllowed({ childFolderCount: 0, workflowCount: 1 }) &&
    OVERVIEW_CARD_SURFACE_CLASS.includes("ff-overview-card") &&
    !OVERVIEW_CARD_SURFACE_CLASS.includes("border-dashed")
  );
}

export function overviewEmptyInheritsPriorStories(): boolean {
  return (
    OVERVIEW_EMPTY.inheritO1CardList &&
    OVERVIEW_EMPTY.inheritO2PathPills &&
    OVERVIEW_EMPTY.inheritO2FinderRail &&
    OVERVIEW_EMPTY.inheritUxl6Verbs &&
    OVERVIEW_EMPTY.inheritF5EmptyVerbs &&
    OVERVIEW_EMPTY.inheritF1ThroughF7 &&
    OVERVIEW_EMPTY.d6MigrateInPlace &&
    OVERVIEW_EMPTY.cardsArePrimaryBrowseSurface &&
    OVERVIEW_HOME.keep325Open &&
    OVERVIEW_PATH_PILLS.keep326Open &&
    F5_HOME_FOLDER.keep312Open
  );
}
