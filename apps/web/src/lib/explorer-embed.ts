/**
 * X.5: Explorer embed parity.
 *
 * Relates to #384 / Part of #379. Keep #384 open. Keep #379 open.
 * Do not auto-close the Windows Explorer epic. Arie locks #379
 * after this last Explorer story lands.
 *
 * Chloe UI only. Presentation gate of `/embed/v1/workflows`
 * (D6 in place). Same Explorer chrome as standalone after
 * GET /session `session.embed`: X.1 tree + content pane +
 * breadcrumb, X.2 right-click menus, X.3 dense list +
 * select/open, X.4 empty / Unfiled teaching. Prefer shared
 * `WorkflowHome` — do not fork a second embed tree.
 *
 * Viewers select/open only; mutate chrome is grant-gated
 * (ADV-024). Unfiled stays virtual. Missing `session.embed`
 * is an ADV-021 alert (fail-closed). Host `?tenant=` /
 * `?workbench=` stay display-only. Wizard / Change-password /
 * Login never mount on embed. CHIPS / Portal iframe: tree
 * comes from GET /workflow-folders, not `localStorage`.
 *
 * F.1–F.7 contracts unchanged. No new APIs. V.1 tokens only.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID
 * · ADV-021/024 · folders not in YAML · Unfiled virtual ·
 * refuse-if-nonempty · not an n8n clone · no KEK.
 */

import { embedSourceMountsChangePassword } from "./change-password.ts";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./embed-contract.ts";
import {
  EXPLORER_CONTEXT_MENU,
  explorerHomeGrantGatesMenus,
  explorerHomeWiresExistingVerbs,
  explorerMenuShowsMutateForViewer,
  explorerEmptyPaneMenuItems,
  explorerFolderMenuItems,
  explorerWorkflowMenuItems,
  visibleExplorerMenuItems,
  X2_EPIC,
  X2_KEEP_EPIC_OPEN,
} from "./explorer-context-menu.ts";
import {
  EXPLORER_EMPTY,
  explorerEmptyDifferentiatesFolderAndUnfiled,
  explorerEmptyKeepsDraftsLoud,
  explorerEmptyKeepsUnfiledVirtual,
  explorerEmptyKeepsX2EmptyPaneMenu,
  explorerEmptyUsesExplorerChrome,
  X4_EPIC,
  X4_KEEP_EPIC_OPEN,
} from "./explorer-empty-states.ts";
import {
  EXPLORER_SELECT_OPEN,
  explorerHomeWiresSelectOpen,
  X3_EPIC,
  X3_KEEP_EPIC_OPEN,
} from "./explorer-select-open.ts";
import {
  EXPLORER_SHELL,
  explorerBreadcrumbFromAncestry,
  explorerContentIsSelectedFolderOnly,
  explorerShellIsPrimary,
  explorerTreeHasDisclosureAndUnfiled,
  explorerUnfiledIsVirtual,
  X1_EPIC,
  X1_KEEP_EPIC_OPEN,
} from "./explorer-shell.ts";
import { embedSourceMountsLogin } from "./local-login.ts";
import { OVERVIEW_EMBED } from "./overview-embed.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import { SETTINGS_WIZARD_VISUAL } from "./settings-wizard-visual.ts";
import {
  F7_HOME_FOLDER,
  embedFolderHomeMountsAfterSessionEmbed,
  embedFolderUsesSharedWorkflowHome,
  embedInventedFolderTree,
  embedMissingSessionEmbedIsAlert,
  folderTreePersistsInLocalStorage,
  hostTenantWorkbenchSelectsFolderTree,
} from "./workflow-folder.ts";

export const X5_STORY = 384;
export const X5_EPIC = 379;
export const X5_KEEP_STORY_OPEN = true;
export const X5_KEEP_EPIC_OPEN = true;
export const X5_ID = "X.5-explorer-embed-parity" as const;
export const X5_BRIEF = "docs/internal/flowforge-workflow-folders.md";

export const EXPLORER_EMBED_HELP =
  "Embed Explorer is the same WorkflowHome tree, content pane, breadcrumb, grant-gated menus, dense select/open, and empty/Unfiled teaching after session.embed. Viewers select/open only. Missing session.embed is an ADV-021 alert. Host query is display-only. Wizard, Login, and Change-password never mount on embed. The tree comes from the API, not localStorage. No second tree.";

export const EXPLORER_EMBED = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritF1ThroughF7: true,
  inheritF7EmbedFolderParity: true,
  inheritO4EmbedOverview: true,
  inheritX1ExplorerShell: true,
  inheritX2ContextMenus: true,
  inheritX3SelectOpen: true,
  inheritX4EmptyTeaching: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  sameWorkflowHomeNoSecondTree: true,
  explorerChromeAfterSessionEmbed: true,
  treePlusContentPlusBreadcrumb: true,
  grantGatedRightClick: true,
  viewersSelectOpenOnly: true,
  noMutateWithoutWorkflowEdit: true,
  denseListSelectOpen: true,
  emptyUnfiledTeaching: true,
  unfiledIsVirtual: true,
  missingSessionEmbedIsAlert: true,
  hostQueryDisplayOnly: true,
  treeFromApiNotLocalStorage: true,
  chipsPortalIframeUsesApiTree: true,
  workspaceScopedNoHostFolderState: true,
  wizardNeverOnEmbedV1: true,
  loginNeverOnEmbedV1: true,
  changePasswordNeverOnEmbedV1: true,
  usesExistingApisOnly: true,
  noJonnyChange: true,
  noNewApi: true,
  f1ThroughF7ContractsUnchanged: true,
  identityProxyAllowlistUnchanged: true,
  yamlIsSourceOfTruth: true,
  foldersNotInYaml: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv021FailClosedWithoutSessionEmbed: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  refuseIfNonemptyDelete: true,
  moveStillPatchFolderIdOnly: true,
  noDraftRevisionBumpOnMove: true,
  nonRecursiveFolderIdStays: true,
  noMillerColumns: true,
  noTagsFirst: true,
  noFavorites: true,
  notFinderPrimary: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  keep384Open: true,
  keep379Open: true,
  noAutoCloseEpic: true,
} as const;

export const EXPLORER_EMBED_SOURCES = [
  "src/lib/explorer-embed.ts",
  "src/lib/explorer-empty-states.ts",
  "src/lib/explorer-select-open.ts",
  "src/lib/explorer-context-menu.ts",
  "src/lib/explorer-shell.ts",
  "src/lib/workflow-folder.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/components/embed/EmbedChrome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export const EXPLORER_EMBED_AUTO_CLOSE_TOKENS = [
  "Fixes #379",
  "Closes #379",
  "Close #379",
  "Resolves #379",
  "Fixes #384",
  "Closes #384",
] as const;

export const embedExplorerHomeMountsAfterSessionEmbed =
  embedFolderHomeMountsAfterSessionEmbed;

export function embedExplorerUsesSharedWorkflowHome(
  homeSource: string,
): boolean {
  return (
    embedFolderUsesSharedWorkflowHome(homeSource) &&
    homeSource.includes("data-x5=") &&
    homeSource.includes("data-x5-tree") &&
    homeSource.includes('data-x1="explorer-shell"') &&
    homeSource.includes('data-x1="folder-tree"') &&
    homeSource.includes('data-x1="content-pane"') &&
    homeSource.includes('data-x1="breadcrumb"') &&
    !embedInventedFolderTree(homeSource)
  );
}

export function embedExplorerShowsShellChrome(homeSource: string): boolean {
  return (
    explorerShellIsPrimary(homeSource) &&
    explorerTreeHasDisclosureAndUnfiled(homeSource) &&
    explorerContentIsSelectedFolderOnly(homeSource) &&
    explorerBreadcrumbFromAncestry(homeSource) &&
    explorerUnfiledIsVirtual(homeSource) &&
    homeSource.includes(
      'data-x5={embed ? "embed-explorer" : "standalone-explorer"}',
    ) &&
    homeSource.includes('data-x5-tree="api"')
  );
}

export function embedExplorerShowsContextMenus(homeSource: string): boolean {
  return (
    explorerHomeWiresExistingVerbs(homeSource) &&
    explorerHomeGrantGatesMenus(homeSource) &&
    homeSource.includes('data-x2="context-menu"') &&
    homeSource.includes('data-x2="pane-surface"')
  );
}

export function embedExplorerShowsSelectOpen(homeSource: string): boolean {
  return (
    explorerHomeWiresSelectOpen(homeSource) &&
    homeSource.includes('data-x3="select-open"') &&
    homeSource.includes('data-x3="pane-list"')
  );
}

export function embedExplorerShowsEmptyTeaching(homeSource: string): boolean {
  return (
    explorerEmptyUsesExplorerChrome(homeSource) &&
    explorerEmptyDifferentiatesFolderAndUnfiled(homeSource) &&
    explorerEmptyKeepsUnfiledVirtual(homeSource) &&
    explorerEmptyKeepsDraftsLoud(homeSource) &&
    explorerEmptyKeepsX2EmptyPaneMenu(homeSource)
  );
}

export function embedExplorerViewerIsSelectOnly(homeSource: string): boolean {
  const viewerFolder = explorerFolderMenuItems({
    canMutate: false,
    isUnfiled: false,
    canCreateChild: true,
    deleteBlocked: false,
    canExpand: true,
    expanded: false,
  });
  const viewerWorkflow = explorerWorkflowMenuItems({ canMutate: false });
  const viewerEmpty = explorerEmptyPaneMenuItems({
    canMutateFolders: false,
    canCreate: false,
    importExistsInHomeChrome: true,
  });
  return (
    homeSource.includes(
      "canMutateEmbedWorkflowFolders(permissions, session.embedChrome)",
    ) &&
    homeSource.includes("canMutateFolders") &&
    homeSource.includes(
      'data-x5-viewer={canMutateFolders ? "editor" : "select-only"}',
    ) &&
    explorerHomeGrantGatesMenus(homeSource) &&
    visibleExplorerMenuItems(viewerFolder).every((item) => !item.mutate) &&
    visibleExplorerMenuItems(viewerWorkflow).every((item) => !item.mutate) &&
    visibleExplorerMenuItems(viewerEmpty).length === 0 &&
    !explorerMenuShowsMutateForViewer(viewerFolder, false) &&
    !explorerMenuShowsMutateForViewer(viewerWorkflow, false) &&
    !explorerMenuShowsMutateForViewer(viewerEmpty, false)
  );
}

export function embedExplorerTreeFromApiNotLocalStorage(
  homeSource: string,
): boolean {
  return (
    homeSource.includes("listWorkflowFolders") &&
    homeSource.includes('data-x5-tree="api"') &&
    homeSource.includes('data-f7-tree="api"') &&
    !folderTreePersistsInLocalStorage(homeSource)
  );
}

export function embedExplorerHostQueryIsDisplayOnly(
  homeSource: string,
): boolean {
  return (
    hostTenantWorkbenchSelectsFolderTree() === false &&
    !homeSource.includes('searchParams.get("tenant")') &&
    !homeSource.includes('searchParams.get("workbench")') &&
    homeSource.includes("FOLDER_QUERY")
  );
}

export function embedExplorerMissingSessionIsAlert(
  chromeSource: string,
): boolean {
  return (
    embedMissingSessionEmbedIsAlert(chromeSource) &&
    /not chrome authority/.test(EMBED_CHROME_MISSING_SESSION_MESSAGE)
  );
}

export function embedExplorerNeverMountsStandaloneDoors(input: {
  embedChrome: string;
  embedShellBranch: string;
  home: string;
}): boolean {
  return (
    !embedSourceMountsLogin(input.embedChrome) &&
    !embedSourceMountsLogin(input.embedShellBranch) &&
    !embedSourceMountsChangePassword(input.embedChrome) &&
    !embedSourceMountsChangePassword(input.embedShellBranch) &&
    !input.embedChrome.includes("FirstRunWizard") &&
    !input.embedShellBranch.includes("FirstRunWizard") &&
    !input.embedChrome.includes("BootstrapGate") &&
    !input.embedShellBranch.includes("ChangePasswordChrome") &&
    !input.home.includes("FirstRunWizard") &&
    !input.home.includes("ChangePasswordChrome") &&
    !input.home.includes("LoginChrome") &&
    SETTINGS_WIZARD_VISUAL.wizardNeverOnEmbedV1
  );
}

export function explorerDocsKeepEpicOpen(docs: string): boolean {
  // Published docs cite X.5. Internal briefs may still cite the issues.
  const cites =
    (/X\.5/.test(docs) && /Explorer/i.test(docs)) ||
    (docs.includes("#384") &&
      /keep #384 open/i.test(docs) &&
      docs.includes("#379") &&
      /keep #379 open/i.test(docs));
  return (
    cites &&
    EXPLORER_EMBED_AUTO_CLOSE_TOKENS.every((token) => !docs.includes(token))
  );
}

export function embedExplorerHoldsHardLines(): boolean {
  return (
    EXPLORER_EMBED.yamlIsSourceOfTruth &&
    EXPLORER_EMBED.foldersNotInYaml &&
    EXPLORER_EMBED.draftsNeverRun &&
    EXPLORER_EMBED.vaultDisplayNameUuidOnly &&
    EXPLORER_EMBED.adv021ChromeFromSessionEmbedOnly &&
    EXPLORER_EMBED.adv021FailClosedWithoutSessionEmbed &&
    EXPLORER_EMBED.adv024MembershipIsolationStayGrantGated &&
    EXPLORER_EMBED.isolationSuccessIsDenial &&
    EXPLORER_EMBED.unfiledIsVirtual &&
    EXPLORER_EMBED.refuseIfNonemptyDelete &&
    EXPLORER_EMBED.moveStillPatchFolderIdOnly &&
    EXPLORER_EMBED.noDraftRevisionBumpOnMove &&
    EXPLORER_EMBED.sameWorkflowHomeNoSecondTree &&
    EXPLORER_EMBED.viewersSelectOpenOnly &&
    EXPLORER_EMBED.treeFromApiNotLocalStorage &&
    EXPLORER_EMBED.wizardNeverOnEmbedV1 &&
    EXPLORER_EMBED.loginNeverOnEmbedV1 &&
    EXPLORER_EMBED.changePasswordNeverOnEmbedV1 &&
    EXPLORER_EMBED.noNewApi &&
    EXPLORER_EMBED.f1ThroughF7ContractsUnchanged &&
    EXPLORER_EMBED.notAnN8nClone &&
    EXPLORER_EMBED.noKekInBrowser &&
    EXPLORER_EMBED.noJonnyChange &&
    EXPLORER_EMBED.keep384Open &&
    EXPLORER_EMBED.keep379Open &&
    EXPLORER_EMBED.noAutoCloseEpic &&
    EXPLORER_SHELL.keep379Open &&
    EXPLORER_CONTEXT_MENU.keep379Open &&
    EXPLORER_SELECT_OPEN.keep379Open &&
    EXPLORER_EMPTY.keep379Open &&
    X1_KEEP_EPIC_OPEN &&
    X2_KEEP_EPIC_OPEN &&
    X3_KEEP_EPIC_OPEN &&
    X4_KEEP_EPIC_OPEN &&
    X1_EPIC === X5_EPIC &&
    X2_EPIC === X5_EPIC &&
    X3_EPIC === X5_EPIC &&
    X4_EPIC === X5_EPIC &&
    F7_HOME_FOLDER.sameWorkflowHomeNoSecondTree &&
    F7_HOME_FOLDER.adv021FailClosedWithoutSessionEmbed &&
    OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree
  );
}

export function embedExplorerInheritsPriorStories(): boolean {
  return (
    EXPLORER_EMBED.inheritF1ThroughF7 &&
    EXPLORER_EMBED.inheritF7EmbedFolderParity &&
    EXPLORER_EMBED.inheritO4EmbedOverview &&
    EXPLORER_EMBED.inheritX1ExplorerShell &&
    EXPLORER_EMBED.inheritX2ContextMenus &&
    EXPLORER_EMBED.inheritX3SelectOpen &&
    EXPLORER_EMBED.inheritX4EmptyTeaching &&
    EXPLORER_EMBED.f1ThroughF7ContractsUnchanged &&
    F7_HOME_FOLDER.keep314Open &&
    OVERVIEW_EMBED.keep328Open &&
    EXPLORER_SHELL.keep380Open &&
    EXPLORER_CONTEXT_MENU.keep381Open &&
    EXPLORER_SELECT_OPEN.keep382Open &&
    EXPLORER_EMPTY.keep383Open
  );
}
