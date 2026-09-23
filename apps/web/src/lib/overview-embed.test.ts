import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./embed-contract.ts";
import {
  O4_BRIEF,
  O4_EPIC,
  O4_ID,
  O4_KEEP_STORY_OPEN,
  O4_STORY,
  OVERVIEW_EMBED,
  OVERVIEW_EMBED_HELP,
  OVERVIEW_EMBED_SOURCES,
  embedOverviewHomeMountsAfterSessionEmbed,
  embedOverviewHostQueryIsDisplayOnly,
  embedOverviewHoldsHardLines,
  embedOverviewInheritsPriorStories,
  embedOverviewMissingSessionIsAlert,
  embedOverviewShowsCardsAndFinderRail,
  embedOverviewTreeFromApiNotLocalStorage,
  embedOverviewUsesSharedWorkflowHome,
  embedOverviewViewerIsSelectOnly,
} from "./overview-embed.ts";
import {
  OVERVIEW_EMPTY,
  overviewEmptyUsesCardChrome,
} from "./overview-empty-states.ts";
import {
  OVERVIEW_HOME,
  overviewCardListIsPrimary,
  overviewHasSearchSortFilterRow,
  overviewSkipsDeferredChrome,
} from "./overview-home.ts";
import {
  OVERVIEW_PATH_PILLS,
  overviewCardsShowPathPills,
  overviewFinderRailIsCompactFilterOnly,
} from "./overview-path-pills.ts";
import { parseSessionEmbedChrome } from "./session-embed-contract.ts";
import {
  F7_HOME_FOLDER,
  F7_KEEP_STORY_OPEN,
  canMutateEmbedWorkflowFolders,
  canMutateWorkflowFolders,
  embedInventedFolderTree,
  embedWorkflowsHref,
  folderExpandUsesSessionStorageOnly,
  folderTreePersistsInLocalStorage,
  hostTenantWorkbenchSelectsFolderTree,
} from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
}

describe("O.4 Embed Overview parity", () => {
  const getSession = {
    session: {
      id: "sess-1",
      embed: {
        mode: "embed",
        sdk: "embed.v1",
        tenantId: "ten-1",
        tenantSlug: "acme",
        tenantName: "Acme",
        workbenchKey: "ops",
        workspaceId: "ws-1",
        workspaceName: "Ops",
        capabilities: ["workflow.view"],
      },
    },
    principal: { display_name: "Ada" },
  };
  const embedView = parseSessionEmbedChrome(getSession);
  const embedEdit = parseSessionEmbedChrome({
    session: {
      ...getSession.session,
      embed: {
        ...getSession.session.embed,
        capabilities: ["workflow.view", "workflow.edit"],
      },
    },
    principal: getSession.principal,
  });

  it("keeps #328 open and cites epic #324", () => {
    assert.equal(O4_STORY, 328);
    assert.equal(O4_EPIC, 324);
    assert.equal(O4_KEEP_STORY_OPEN, true);
    assert.equal(O4_ID, "O.4-embed-overview-parity");
    assert.equal(O4_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(OVERVIEW_EMBED.keep328Open, true);
    assert.equal(OVERVIEW_EMBED.noJonnyChange, true);
    assert.equal(OVERVIEW_EMBED.d6MigrateInPlace, true);
    assert.equal(OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.match(frontend, /Overview cards/i);
    assert.match(frontend, /Finder rail/i);
    const brief = repoSource(O4_BRIEF);
    assert.match(brief, /O\.4/);
    assert.match(brief, /No second tree/);
    const page = source("src/app/workflows/page.tsx");
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    assert.doesNotMatch(page, /#328/);
    assert.match(OVERVIEW_EMBED_HELP, /same WorkflowHome/i);
    assert.match(OVERVIEW_EMBED_HELP, /ADV-021/);
    assert.match(OVERVIEW_EMBED_HELP, /localStorage/);
    for (const path of OVERVIEW_EMBED_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });

  it("shows Overview cards + compact Finder rail after session.embed", () => {
    assert.equal(
      embedOverviewHomeMountsAfterSessionEmbed({
        sessionChecked: false,
        sessionActive: false,
        sessionEmbed: null,
      }),
      false,
    );
    assert.equal(
      embedOverviewHomeMountsAfterSessionEmbed({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: null,
      }),
      false,
    );
    assert.equal(
      embedOverviewHomeMountsAfterSessionEmbed({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: embedView,
      }),
      true,
    );
    assert.equal(
      embedOverviewHomeMountsAfterSessionEmbed({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: embedView,
        verified: false,
      }),
      false,
    );
    const home = source("src/components/home/WorkflowHome.tsx");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const rewrite = source("next.config.ts");
    assert.equal(embedOverviewUsesSharedWorkflowHome(home), true);
    assert.equal(embedOverviewShowsCardsAndFinderRail(home), true);
    assert.equal(overviewCardListIsPrimary(home), true);
    assert.equal(overviewHasSearchSortFilterRow(home), true);
    assert.equal(overviewCardsShowPathPills(home), true);
    assert.equal(overviewFinderRailIsCompactFilterOnly(home), true);
    assert.equal(overviewEmptyUsesCardChrome(home), true);
    assert.match(home, /data-o4=\{embed \? "embed-overview" : "standalone-overview"\}/);
    assert.match(home, /data-o4-tree="api"/);
    assert.match(home, /data-o1="card-list"/);
    assert.match(home, /data-o1="overview-header"/);
    assert.match(home, /data-o2="finder-rail"/);
    assert.match(home, /data-o2="path-pills"/);
    assert.match(home, /data-o3="empty-card"/);
    assert.match(home, /useEmbedMode/);
    assert.equal(embedInventedFolderTree(home), false);
    assert.equal(embedInventedFolderTree(shell), false);
    assert.equal(embedWorkflowsHref(), "/embed/v1/workflows");
    assert.match(shell, /isSessionEmbedMode\(session\.embedChrome\)/);
    assert.match(shell, /EmbedTenancyGate>\{children\}/);
    assert.match(rewrite, /source: "\/embed\/v1\/:path\*"/);
    assert.match(rewrite, /destination: "\/:path\*"/);
    const editor = source("src/app/workflows/[id]/page.tsx");
    assert.doesNotMatch(editor, /WorkflowHome/);
    assert.doesNotMatch(editor, /data-o4=/);
    assert.doesNotMatch(home, /\/embed\/v2\/folders|\/studio\/folders|\/portal\/folders/);
    assert.equal(OVERVIEW_EMBED.cardsAndFinderRailAfterSessionEmbed, true);
    assert.equal(OVERVIEW_EMBED.sameWorkflowHomeNoSecondTree, true);
  });

  it("fail-closes without session.embed and keeps host query display-only", () => {
    const chrome = source("src/components/embed/EmbedChrome.tsx");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedOverviewMissingSessionIsAlert(chrome), true);
    assert.match(chrome, /EMBED_CHROME_MISSING_SESSION_MESSAGE/);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /not chrome authority/);
    assert.match(chrome, /role="alert"/);
    assert.match(shell, /EmbedExchangeGate/);
    assert.match(shell, /isSessionEmbedMode\(session\.embedChrome\)/);
    assert.doesNotMatch(
      shell,
      /EmbedTenancyGate>\{children\}[\s\S]*sessionEmbed: null/,
    );
    assert.equal(embedOverviewHostQueryIsDisplayOnly(home), true);
    assert.equal(hostTenantWorkbenchSelectsFolderTree(), false);
    assert.doesNotMatch(home, /searchParams\.get\("tenant"\)/);
    assert.doesNotMatch(home, /searchParams\.get\("workbench"\)/);
    assert.match(home, /FOLDER_QUERY/);
    assert.equal(OVERVIEW_EMBED.missingSessionEmbedIsAlert, true);
    assert.equal(OVERVIEW_EMBED.hostQueryDisplayOnly, true);
    assert.equal(OVERVIEW_EMBED.adv021FailClosedWithoutSessionEmbed, true);
    assert.equal(F7_HOME_FOLDER.adv021ChromeFromSessionEmbedOnly, true);
  });

  it("keeps viewers select-only without minted workflow.edit", () => {
    const workspace = ["workflow.view", "workflow.edit"];
    assert.equal(canMutateWorkflowFolders(["workflow.view"]), false);
    assert.equal(canMutateWorkflowFolders(workspace), true);
    assert.equal(canMutateEmbedWorkflowFolders(workspace, null), false);
    assert.equal(canMutateEmbedWorkflowFolders(workspace, embedView), false);
    assert.equal(
      canMutateEmbedWorkflowFolders(["workflow.view"], embedEdit),
      false,
    );
    assert.equal(canMutateEmbedWorkflowFolders(workspace, embedEdit), true);
    assert.equal(canMutateEmbedWorkflowFolders(null, embedEdit), false);
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedOverviewViewerIsSelectOnly(home), true);
    assert.match(
      home,
      /canMutateEmbedWorkflowFolders\(permissions, session\.embedChrome\)/,
    );
    assert.match(home, /canMutateFolders/);
    assert.match(home, /canCreate/);
    assert.match(
      home,
      /data-o4-viewer=\{canMutateFolders \? "editor" : "select-only"\}/,
    );
    assert.equal(OVERVIEW_EMBED.viewersSelectOnly, true);
    assert.equal(OVERVIEW_EMBED.noMutateWithoutWorkflowEdit, true);
  });

  it("loads the tree from the API, not localStorage", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const folder = source("src/lib/workflow-folder.ts");
    const client = source("src/lib/workflow-folder-client.ts");
    const portal = source("src/components/portal/PortalHost.tsx");
    assert.equal(embedOverviewTreeFromApiNotLocalStorage(home), true);
    assert.equal(folderTreePersistsInLocalStorage(home), false);
    assert.equal(folderTreePersistsInLocalStorage(folder), false);
    assert.equal(folderTreePersistsInLocalStorage(client), false);
    assert.equal(folderExpandUsesSessionStorageOnly(folder), true);
    assert.match(home, /listWorkflowFolders/);
    assert.match(home, /data-o4-tree="api"/);
    assert.match(home, /data-f7-tree="api"/);
    assert.doesNotMatch(client, /localStorage/);
    assert.match(portal, /iframe/);
    assert.doesNotMatch(portal, /localStorage/);
    assert.equal(OVERVIEW_EMBED.treeFromApiNotLocalStorage, true);
    assert.equal(OVERVIEW_EMBED.chipsPortalIframeUsesApiTree, true);
    assert.equal(F7_HOME_FOLDER.treeFromApiNotLocalStorage, true);
  });

  it("does not regress O.1–O.3 chrome or F.7 bind", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedOverviewInheritsPriorStories(), true);
    assert.equal(OVERVIEW_HOME.cardsArePrimaryBrowseSurface, true);
    assert.equal(OVERVIEW_PATH_PILLS.compactFinderRail, true);
    assert.equal(OVERVIEW_EMPTY.emptyHomeUsesCardChrome, true);
    assert.equal(F7_HOME_FOLDER.sameWorkflowHomeNoSecondTree, true);
    assert.equal(F7_KEEP_STORY_OPEN, true);
    assert.equal(OVERVIEW_EMBED.inheritO1CardList, true);
    assert.equal(OVERVIEW_EMBED.inheritO2FinderRail, true);
    assert.equal(OVERVIEW_EMBED.inheritO3EmptyCardChrome, true);
    assert.equal(OVERVIEW_EMBED.inheritF7EmbedFolderParity, true);
    assert.match(home, /data-o1="overview-header"/);
    assert.match(home, /data-o2="finder-rail"/);
    assert.match(home, /data-o3="empty-card"/);
    assert.match(home, /data-f7=\{embed \? "embed-home" : "standalone-home"\}/);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.equal(overviewSkipsDeferredChrome(home), true);
    assert.doesNotMatch(
      home,
      /data-o1="stats"|data-o1="personal"|data-o1="link-count"/,
    );
  });

  it("holds hard lines and stays independent FlowForge chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedOverviewHoldsHardLines(), true);
    assert.equal(OVERVIEW_EMBED.yamlIsSourceOfTruth, true);
    assert.equal(OVERVIEW_EMBED.foldersNotInYaml, true);
    assert.equal(OVERVIEW_EMBED.draftsNeverRun, true);
    assert.equal(OVERVIEW_EMBED.notAnN8nClone, true);
    assert.equal(OVERVIEW_EMBED.noKekInBrowser, true);
    assert.equal(OVERVIEW_EMBED.isolationSuccessIsDenial, true);
    assert.equal(OVERVIEW_EMBED.noJonnyChange, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
  });
});
