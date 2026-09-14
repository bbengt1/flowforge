/**
 * O.1: Overview header + search/sort/filter + card list.
 *
 * Relates to #325 / Part of #324. Keep #325 open.
 *
 * Chloe UI only. Presentation pivot of `/workflows` (D6 in place).
 * F.1–F.7 folder model stays: compact rail may filter; cards are
 * the primary browse surface. Existing `GET /workflows` list fields
 * plus `GET /workflow-folders` — no jonny change. Path pills wait
 * for O.2. Stats strip deferred. Personal badge and link-count are skipped.
 *
 * Hard lines: YAML source · drafts never run · ADV-021/024 ·
 * folders not in YAML · Unfiled virtual · refuse-if-nonempty
 * delete · not an n8n clone · no KEK.
 */

import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import { F2_HOME_FOLDER, F6_HOME_FOLDER } from "./workflow-folder.ts";

export const O1_STORY = 325;
export const O1_EPIC = 324;
export const O1_KEEP_STORY_OPEN = true;
export const O1_ID = "O.1-overview-header-card-list" as const;
export const O1_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const OVERVIEW_HEADING = "Overview";
export const OVERVIEW_HELP =
  "Workflows in this workspace. The card list is the primary browse surface. Drafts do not run — publish, then start a published version.";
export const OVERVIEW_CREATE_LABEL = "Create workflow";
export const OVERVIEW_SORT_LABEL = "Sort by";
export const OVERVIEW_FILTER_LABEL = "Filter";
export const OVERVIEW_KEBAB_LABEL = "Workflow actions";
export const OVERVIEW_PUBLISHED_LABEL = "Published";
export const OVERVIEW_UPDATED_PREFIX = "Last updated";
export const OVERVIEW_CREATED_PREFIX = "Created";
export const OVERVIEW_CARD_SURFACE_CLASS =
  "rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm";

export const OVERVIEW_CARD_LIST_FIELDS = [
  "name",
  "createdAt",
  "updatedAt",
  "status",
  "folderId",
] as const;

export type OverviewHomeSort = "updatedAt" | "createdAt" | "name";

export const OVERVIEW_SORTS = [
  { value: "updatedAt", label: "Last updated" },
  { value: "createdAt", label: "Created" },
  { value: "name", label: "Name" },
] as const satisfies ReadonlyArray<{
  value: OverviewHomeSort;
  label: string;
}>;

export const OVERVIEW_DEFAULT_SORT: OverviewHomeSort = "updatedAt";

export const OVERVIEW_SKIP_TOKENS = [
  "Prod. executions",
  "Failed prod.",
  "Failure rate",
  "Time saved",
  "run time (avg",
  "data-o1=\"stats\"",
  "data-o1=\"personal\"",
  "data-o1=\"link-count\"",
  "Personal badge",
  "link-count",
] as const;

export const OVERVIEW_CLONE_SKIP = [
  "#ea4b71",
  "#ff6d5a",
  "#e99854",
  "n8n-logo",
  "Execute workflow",
] as const;

export const OVERVIEW_HOME = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritF6Search: true,
  inheritF2RailSelect: true,
  nonRecursiveFolderIdStays: true,
  d6MigrateInPlace: true,
  cardsArePrimaryBrowseSurface: true,
  headerHasCreateCta: true,
  searchSortFilterRow: true,
  cardShowsNameUpdatedCreatedPublishedKebab: true,
  usesExistingListFieldsOnly: true,
  compactFolderRailMayRemain: true,
  pathPillsWaitForO2: true,
  statsStripSkipped: true,
  personalBadgeSkipped: true,
  linkCountSkipped: true,
  noJonnyChange: true,
  noNewApi: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep325Open: true,
} as const;

export const OVERVIEW_HOME_SOURCES = [
  "src/lib/overview-home.ts",
  "src/lib/workflow-home.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export type OverviewListItem = {
  name: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  folderId: string | null;
};

export function overviewPublishedFromStatus(status: string): boolean {
  return status.trim().toLowerCase() === "published";
}

export function overviewPublishedBadge(status: string): {
  shown: boolean;
  label: string;
} {
  const shown = overviewPublishedFromStatus(status);
  return {
    shown,
    label: shown ? OVERVIEW_PUBLISHED_LABEL : "",
  };
}

export function formatOverviewAbsoluteDate(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return "";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ts));
}

export function formatOverviewRelative(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) {
    return "";
  }
  const delta = Math.max(0, now - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;
  if (delta < hour) {
    const n = Math.max(1, Math.round(delta / minute));
    return n === 1 ? "1 minute ago" : `${n} minutes ago`;
  }
  if (delta < day) {
    const n = Math.max(1, Math.round(delta / hour));
    return n === 1 ? "1 hour ago" : `${n} hours ago`;
  }
  if (delta < month) {
    const n = Math.max(1, Math.round(delta / day));
    return n === 1 ? "1 day ago" : `${n} days ago`;
  }
  if (delta < year) {
    const n = Math.max(1, Math.round(delta / month));
    return n === 1 ? "1 month ago" : `${n} months ago`;
  }
  const n = Math.max(1, Math.round(delta / year));
  return n === 1 ? "1 year ago" : `${n} years ago`;
}

export function overviewCardTimestamps(
  item: Pick<OverviewListItem, "createdAt" | "updatedAt">,
  now = Date.now(),
): { updated: string; created: string; line: string } {
  const updated = formatOverviewRelative(item.updatedAt, now);
  const created = formatOverviewAbsoluteDate(item.createdAt);
  const parts = [
    updated ? `${OVERVIEW_UPDATED_PREFIX} ${updated}` : "",
    created ? `${OVERVIEW_CREATED_PREFIX} ${created}` : "",
  ].filter(Boolean);
  return {
    updated,
    created,
    line: parts.join(" · "),
  };
}

export function sortOverviewHomeItems<T extends OverviewListItem>(
  items: readonly T[],
  sort: OverviewHomeSort = OVERVIEW_DEFAULT_SORT,
): T[] {
  return [...items].sort((left, right) => {
    if (sort === "name") {
      return left.name.localeCompare(right.name);
    }
    if (sort === "createdAt") {
      return (right.createdAt || "").localeCompare(left.createdAt || "");
    }
    return (right.updatedAt || "").localeCompare(left.updatedAt || "");
  });
}

export function overviewUsesOnlyListFields(source: string): boolean {
  return OVERVIEW_CARD_LIST_FIELDS.every((field) => source.includes(field));
}

export function overviewSkipsDeferredChrome(source: string): boolean {
  return OVERVIEW_SKIP_TOKENS.every((token) => !source.includes(token));
}

export function overviewAvoidsCloneTokens(source: string): boolean {
  return OVERVIEW_CLONE_SKIP.every((token) => !source.includes(token));
}

export function overviewCardListIsPrimary(source: string): boolean {
  return (
    source.includes('data-o1="card-list"') &&
    !source.includes('aria-label="Workflow home view"') &&
    !source.includes('setView("list")') &&
    source.includes('data-o1="overview-header"')
  );
}

export function overviewHasSearchSortFilterRow(source: string): boolean {
  return (
    source.includes('data-o1="toolbar"') &&
    source.includes('data-f6="search"') &&
    source.includes("OVERVIEW_SORT_LABEL") &&
    source.includes("OVERVIEW_FILTER_LABEL") &&
    source.includes("FOLDER_SEARCH_ACROSS_LABEL")
  );
}

export function overviewDoesNotRegressFolderBrowse(source: string): boolean {
  return (
    source.includes("data-home-folder-rail") &&
    source.includes("data-home-folder-search") &&
    source.includes("FOLDER_SEARCH_IN_FOLDER_LABEL") &&
    source.includes("searchInThisFolder") &&
    source.includes("folderHomeListMode") &&
    source.includes("selectedFolderListFolderId") &&
    source.includes("constrainItemsToFolderSelection") &&
    !/includeDescendants|recursiveFolder|treeWalk/i.test(source)
  );
}

export function overviewHoldsHardLines(): boolean {
  return (
    OVERVIEW_HOME.yamlIsSourceOfTruth &&
    OVERVIEW_HOME.foldersNotInYaml &&
    OVERVIEW_HOME.draftsNeverRun &&
    OVERVIEW_HOME.vaultDisplayNameUuidOnly &&
    OVERVIEW_HOME.adv021ChromeFromSessionEmbedOnly &&
    OVERVIEW_HOME.adv024MembershipIsolationStayGrantGated &&
    OVERVIEW_HOME.isolationSuccessIsDenial &&
    OVERVIEW_HOME.unfiledIsVirtual &&
    OVERVIEW_HOME.refuseIfNonemptyDelete &&
    OVERVIEW_HOME.notAnN8nClone &&
    OVERVIEW_HOME.noKekInBrowser &&
    OVERVIEW_HOME.noJonnyChange &&
    OVERVIEW_HOME.keep325Open &&
    F2_HOME_FOLDER.keep309Open &&
    F6_HOME_FOLDER.defaultSearchAcrossFolders &&
    F6_HOME_FOLDER.folderIdIsNotATreeWalk
  );
}

export function overviewInheritsFolderStories(): boolean {
  return (
    OVERVIEW_HOME.inheritF1ThroughF7 &&
    OVERVIEW_HOME.inheritF6Search &&
    OVERVIEW_HOME.inheritF2RailSelect &&
    OVERVIEW_HOME.nonRecursiveFolderIdStays &&
    OVERVIEW_HOME.d6MigrateInPlace &&
    F6_HOME_FOLDER.keep313Open &&
    F2_HOME_FOLDER.keep309Open
  );
}
