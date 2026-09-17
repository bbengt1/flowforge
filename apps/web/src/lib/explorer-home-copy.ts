/**
 * X.6: Remove visible product-commentary copy from workflows
 * Explorer home.
 *
 * Relates to #393 / Part of #379. Keep #393 open.
 * Do not auto-close #393, #379, or unrelated issues.
 *
 * Chloe UI only. `/workflows` (and `/embed/v1/workflows` after
 * `session.embed`, same `WorkflowHome`) must not show the long
 * X.1–X.5 / O.* / V.* / “keep #N open” product-commentary dump.
 * That text belongs in GitHub and architecture docs.
 *
 * Keep real Explorer chrome (tree + pane + breadcrumb, context
 * menus, dense select/open), short empty/Unfiled teaching, hard
 * lines, ADV embed gates, and V.1 tokens. Do not gut empty-state
 * teaching into silence.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID
 * · ADV-021/024 · folders not in YAML · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no KEK.
 */

import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

export const X6_STORY = 393;
export const X6_EPIC = 379;
export const X6_KEEP_STORY_OPEN = true;
export const X6_KEEP_EPIC_OPEN = true;
export const X6_ID = "X.6-explorer-home-copy" as const;
export const X6_BRIEF = "docs/architecture/flowforge-workflow-folders.md";

export const WORKFLOWS_HOME_PAGE_HELP =
  "Browse folders and workflows in this workspace. Explorer home is the folder tree, selected-folder content pane, and breadcrumb. Unfiled is virtual. Right-click a folder, workflow, or empty pane for create, rename, delete, move, or import when your role allows it. Single-click selects a row; double-click or Enter opens a workflow or folder. Empty folders teach create or move; Unfiled cannot be renamed or deleted. Activation and last run stay on each row. Drafts do not run — publish, then start a published version.";

export const EXPLORER_HOME_COPY = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritX1ExplorerShell: true,
  inheritX2ContextMenus: true,
  inheritX3SelectOpen: true,
  inheritX4EmptyTeaching: true,
  inheritX5EmbedParity: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  visiblePageHasNoEpicCommentary: true,
  emptyTeachingStays: true,
  sameWorkflowHomeNoSecondTree: true,
  noJonnyChange: true,
  noNewApi: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  unfiledIsVirtual: true,
  refuseIfNonemptyDelete: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep393Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
  noAutoCloseUnrelated: true,
} as const;

export const EXPLORER_HOME_COPY_SOURCES = [
  "src/lib/explorer-home-copy.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export const EXPLORER_HOME_COPY_AUTO_CLOSE_TOKENS = [
  "Fixes #393",
  "Closes #393",
  "Close #393",
  "Resolves #393",
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
] as const;

export const EXPLORER_PAGE_COMMENTARY_TOKENS = [
  "keep #",
  "Keep #",
  "Part of #",
  "X.1 /",
  "X.2 /",
  "X.3 /",
  "X.4 /",
  "X.5 /",
  "O.1 /",
  "O.2 /",
  "O.3 /",
  "O.4 /",
  "V.3 /",
  "F.5 /",
  "card chrome",
  "scan ends",
] as const;

export function explorerPageLeaksCommentary(pageSource: string): boolean {
  return EXPLORER_PAGE_COMMENTARY_TOKENS.some((token) =>
    pageSource.includes(token),
  );
}

export function explorerPageUsesOperatorHelp(pageSource: string): boolean {
  return (
    pageSource.includes("WORKFLOWS_HOME_PAGE_HELP") &&
    pageSource.includes("WorkflowHome") &&
    !explorerPageLeaksCommentary(pageSource)
  );
}

export function explorerHomeCopyHoldsHardLines(): boolean {
  return (
    EXPLORER_HOME_COPY.yamlIsSourceOfTruth &&
    EXPLORER_HOME_COPY.draftsNeverRun &&
    EXPLORER_HOME_COPY.vaultDisplayNameUuidOnly &&
    EXPLORER_HOME_COPY.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_HOME_COPY.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_HOME_COPY.isolationSuccessIsDenial &&
    EXPLORER_HOME_COPY.unfiledIsVirtual &&
    EXPLORER_HOME_COPY.refuseIfNonemptyDelete &&
    EXPLORER_HOME_COPY.notAnN8nClone &&
    EXPLORER_HOME_COPY.noKekInBrowser &&
    EXPLORER_HOME_COPY.noJonnyChange &&
    EXPLORER_HOME_COPY.inheritV1Tokens
  );
}

export function explorerHomeCopyInheritsPriorStories(): boolean {
  return (
    EXPLORER_HOME_COPY.inheritX1ExplorerShell &&
    EXPLORER_HOME_COPY.inheritX2ContextMenus &&
    EXPLORER_HOME_COPY.inheritX3SelectOpen &&
    EXPLORER_HOME_COPY.inheritX4EmptyTeaching &&
    EXPLORER_HOME_COPY.inheritX5EmbedParity &&
    EXPLORER_HOME_COPY.emptyTeachingStays &&
    EXPLORER_HOME_COPY.sameWorkflowHomeNoSecondTree
  );
}

export function explorerDocsKeepStoryOpen(docs: string): boolean {
  return (
    docs.includes("#393") &&
    /keep #393 open/i.test(docs) &&
    EXPLORER_HOME_COPY_AUTO_CLOSE_TOKENS.every((token) => !docs.includes(token))
  );
}
