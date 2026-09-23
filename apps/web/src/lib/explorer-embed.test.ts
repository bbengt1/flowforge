import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { embedSourceMountsChangePassword } from "./change-password.ts";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./embed-contract.ts";
import {
  EXPLORER_EMBED,
  EXPLORER_EMBED_AUTO_CLOSE_TOKENS,
  EXPLORER_EMBED_HELP,
  EXPLORER_EMBED_SOURCES,
  X5_BRIEF,
  X5_EPIC,
  X5_ID,
  X5_KEEP_EPIC_OPEN,
  X5_KEEP_STORY_OPEN,
  X5_STORY,
  embedExplorerHomeMountsAfterSessionEmbed,
  embedExplorerHostQueryIsDisplayOnly,
  embedExplorerHoldsHardLines,
  embedExplorerInheritsPriorStories,
  embedExplorerMissingSessionIsAlert,
  embedExplorerNeverMountsStandaloneDoors,
  embedExplorerShowsContextMenus,
  embedExplorerShowsEmptyTeaching,
  embedExplorerShowsSelectOpen,
  embedExplorerShowsShellChrome,
  embedExplorerTreeFromApiNotLocalStorage,
  embedExplorerUsesSharedWorkflowHome,
  embedExplorerViewerIsSelectOnly,
  explorerDocsKeepEpicOpen,
} from "./explorer-embed.ts";
import {
  explorerEmptyPaneMenuItems,
  explorerFolderMenuItems,
  explorerWorkflowMenuItems,
  visibleExplorerMenuItems,
} from "./explorer-context-menu.ts";
import { embedSourceMountsLogin } from "./local-login.ts";
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

describe("X.5 Explorer embed parity", () => {
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

  it("keeps #384 and #379 open and cites the folder IA", () => {
    assert.equal(X5_STORY, 384);
    assert.equal(X5_EPIC, 379);
    assert.equal(X5_KEEP_STORY_OPEN, true);
    assert.equal(X5_KEEP_EPIC_OPEN, true);
    assert.equal(X5_ID, "X.5-explorer-embed-parity");
    assert.equal(X5_BRIEF, "docs/internal/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_EMBED.keep384Open, true);
    assert.equal(EXPLORER_EMBED.keep379Open, true);
    assert.equal(EXPLORER_EMBED.noAutoCloseEpic, true);
    assert.equal(EXPLORER_EMBED.noJonnyChange, true);
    assert.equal(EXPLORER_EMBED.d6MigrateInPlace, true);
    assert.equal(EXPLORER_EMBED.sameWorkflowHomeNoSecondTree, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepEpicOpen(frontend), true);
    assert.match(frontend, /Explorer/i);
    const brief = repoSource(X5_BRIEF);
    assert.match(brief, /X\.5/);
    assert.match(brief, /No second tree/);
    const page = source("src/app/workflows/page.tsx");
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    assert.doesNotMatch(page, /#384/);
    assert.match(EXPLORER_EMBED_HELP, /same WorkflowHome/i);
    assert.match(EXPLORER_EMBED_HELP, /ADV-021/);
    assert.match(EXPLORER_EMBED_HELP, /localStorage/);
    assert.match(EXPLORER_EMBED_HELP, /Change-password/i);
    for (const token of EXPLORER_EMBED_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
      assert.equal(brief.includes(token), false, token);
    }
    for (const path of EXPLORER_EMBED_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });

  it("shows the shared Explorer shell after session.embed", () => {
    assert.equal(
      embedExplorerHomeMountsAfterSessionEmbed({
        sessionChecked: false,
        sessionActive: false,
        sessionEmbed: null,
      }),
      false,
    );
    assert.equal(
      embedExplorerHomeMountsAfterSessionEmbed({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: null,
      }),
      false,
    );
    assert.equal(
      embedExplorerHomeMountsAfterSessionEmbed({
        sessionChecked: true,
        sessionActive: true,
        sessionEmbed: embedView,
      }),
      true,
    );
    assert.equal(
      embedExplorerHomeMountsAfterSessionEmbed({
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
    assert.equal(embedExplorerUsesSharedWorkflowHome(home), true);
    assert.equal(embedExplorerShowsShellChrome(home), true);
    assert.equal(embedExplorerShowsContextMenus(home), true);
    assert.equal(embedExplorerShowsSelectOpen(home), true);
    assert.equal(embedExplorerShowsEmptyTeaching(home), true);
    assert.match(
      home,
      /data-x5=\{embed \? "embed-explorer" : "standalone-explorer"\}/,
    );
    assert.match(home, /data-x5-tree="api"/);
    assert.match(home, /data-x1="explorer-shell"/);
    assert.match(home, /data-x1="folder-tree"/);
    assert.match(home, /data-x1="content-pane"/);
    assert.match(home, /data-x1="breadcrumb"/);
    assert.match(home, /data-x2="context-menu"/);
    assert.match(home, /data-x3="select-open"/);
    assert.match(home, /data-x4="empty-unfiled"/);
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
    assert.doesNotMatch(editor, /data-x5=/);
    assert.doesNotMatch(home, /\/embed\/v2\/folders|\/studio\/folders|\/portal\/folders/);
    assert.equal(EXPLORER_EMBED.explorerChromeAfterSessionEmbed, true);
    assert.equal(EXPLORER_EMBED.sameWorkflowHomeNoSecondTree, true);
  });

  it("fail-closes without session.embed and keeps host query display-only", () => {
    const chrome = source("src/components/embed/EmbedChrome.tsx");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedExplorerMissingSessionIsAlert(chrome), true);
    assert.match(chrome, /EMBED_CHROME_MISSING_SESSION_MESSAGE/);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /not chrome authority/);
    assert.match(chrome, /role="alert"/);
    assert.match(shell, /EmbedExchangeGate/);
    assert.match(shell, /isSessionEmbedMode\(session\.embedChrome\)/);
    assert.doesNotMatch(
      shell,
      /EmbedTenancyGate>\{children\}[\s\S]*sessionEmbed: null/,
    );
    assert.equal(embedExplorerHostQueryIsDisplayOnly(home), true);
    assert.equal(hostTenantWorkbenchSelectsFolderTree(), false);
    assert.doesNotMatch(home, /searchParams\.get\("tenant"\)/);
    assert.doesNotMatch(home, /searchParams\.get\("workbench"\)/);
    assert.match(home, /FOLDER_QUERY/);
    assert.equal(EXPLORER_EMBED.missingSessionEmbedIsAlert, true);
    assert.equal(EXPLORER_EMBED.hostQueryDisplayOnly, true);
    assert.equal(EXPLORER_EMBED.adv021FailClosedWithoutSessionEmbed, true);
    assert.equal(F7_HOME_FOLDER.adv021ChromeFromSessionEmbedOnly, true);
  });

  it("keeps viewers select/open only without minted workflow.edit", () => {
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
    assert.equal(embedExplorerViewerIsSelectOnly(home), true);
    assert.match(
      home,
      /canMutateEmbedWorkflowFolders\(permissions, session\.embedChrome\)/,
    );
    assert.match(home, /canMutateFolders/);
    assert.match(
      home,
      /data-x5-viewer=\{canMutateFolders \? "editor" : "select-only"\}/,
    );
    assert.deepEqual(
      visibleExplorerMenuItems(
        explorerFolderMenuItems({
          canMutate: false,
          isUnfiled: false,
          canCreateChild: true,
          deleteBlocked: false,
          canExpand: true,
          expanded: false,
        }),
      ).map((item) => item.id),
      ["expand"],
    );
    assert.deepEqual(
      visibleExplorerMenuItems(
        explorerWorkflowMenuItems({ canMutate: false }),
      ).map((item) => item.id),
      ["open"],
    );
    assert.deepEqual(
      visibleExplorerMenuItems(
        explorerEmptyPaneMenuItems({
          canMutateFolders: false,
          canCreate: false,
          importExistsInHomeChrome: true,
        }),
      ),
      [],
    );
    assert.equal(EXPLORER_EMBED.viewersSelectOpenOnly, true);
    assert.equal(EXPLORER_EMBED.noMutateWithoutWorkflowEdit, true);
  });

  it("loads the tree from the API, not host-side folder state", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const folder = source("src/lib/workflow-folder.ts");
    const client = source("src/lib/workflow-folder-client.ts");
    const portal = source("src/components/portal/PortalHost.tsx");
    assert.equal(embedExplorerTreeFromApiNotLocalStorage(home), true);
    assert.equal(folderTreePersistsInLocalStorage(home), false);
    assert.equal(folderTreePersistsInLocalStorage(folder), false);
    assert.equal(folderTreePersistsInLocalStorage(client), false);
    assert.equal(folderExpandUsesSessionStorageOnly(folder), true);
    assert.match(home, /listWorkflowFolders/);
    assert.match(home, /data-x5-tree="api"/);
    assert.match(home, /data-f7-tree="api"/);
    assert.doesNotMatch(client, /localStorage/);
    assert.match(portal, /iframe/);
    assert.doesNotMatch(portal, /localStorage/);
    assert.equal(EXPLORER_EMBED.treeFromApiNotLocalStorage, true);
    assert.equal(EXPLORER_EMBED.workspaceScopedNoHostFolderState, true);
    assert.equal(EXPLORER_EMBED.chipsPortalIframeUsesApiTree, true);
    assert.equal(F7_HOME_FOLDER.treeFromApiNotLocalStorage, true);
  });

  it("never mounts wizard, Login, or Change-password on embed", () => {
    const chrome = source("src/components/embed/EmbedChrome.tsx");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(
      embedExplorerNeverMountsStandaloneDoors({
        embedChrome: chrome,
        embedShellBranch: embedBranch,
        home,
      }),
      true,
    );
    assert.equal(embedSourceMountsLogin(embedBranch), false);
    assert.equal(embedSourceMountsChangePassword(embedBranch), false);
    assert.equal(embedBranch.includes("FirstRunWizard"), false);
    assert.equal(embedBranch.includes("ChangePasswordChrome"), false);
    assert.equal(embedBranch.includes("MustChangePasswordGate"), false);
    assert.equal(embedBranch.includes("LoginChrome"), false);
    assert.equal(embedSourceMountsLogin(chrome), false);
    assert.equal(embedSourceMountsChangePassword(chrome), false);
    assert.equal(chrome.includes("FirstRunWizard"), false);
    assert.equal(EXPLORER_EMBED.wizardNeverOnEmbedV1, true);
    assert.equal(EXPLORER_EMBED.loginNeverOnEmbedV1, true);
    assert.equal(EXPLORER_EMBED.changePasswordNeverOnEmbedV1, true);
  });

  it("does not regress X.1–X.4 chrome or F.7 / O.4 bind", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedExplorerInheritsPriorStories(), true);
    assert.equal(EXPLORER_EMBED.inheritX1ExplorerShell, true);
    assert.equal(EXPLORER_EMBED.inheritX2ContextMenus, true);
    assert.equal(EXPLORER_EMBED.inheritX3SelectOpen, true);
    assert.equal(EXPLORER_EMBED.inheritX4EmptyTeaching, true);
    assert.equal(EXPLORER_EMBED.inheritF7EmbedFolderParity, true);
    assert.equal(EXPLORER_EMBED.f1ThroughF7ContractsUnchanged, true);
    assert.equal(F7_HOME_FOLDER.sameWorkflowHomeNoSecondTree, true);
    assert.equal(F7_KEEP_STORY_OPEN, true);
    assert.match(home, /data-x1="explorer-shell"/);
    assert.match(home, /data-x2="context-menu"/);
    assert.match(home, /data-x3="select-open"/);
    assert.match(home, /data-x4="empty-folder"/);
    assert.match(home, /data-f7=\{embed \? "embed-home" : "standalone-home"\}/);
    assert.match(home, /data-o4=\{embed \? "embed-overview" : "standalone-overview"\}/);
    assert.doesNotMatch(home, /includeDescendants|recursiveFolder|treeWalk/i);
    assert.doesNotMatch(
      home,
      /data-x5="favorites"|data-x5="tags-first"|data-x5="miller"/,
    );
  });

  it("holds hard lines and stays independent FlowForge chrome", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(embedExplorerHoldsHardLines(), true);
    assert.equal(EXPLORER_EMBED.yamlIsSourceOfTruth, true);
    assert.equal(EXPLORER_EMBED.foldersNotInYaml, true);
    assert.equal(EXPLORER_EMBED.draftsNeverRun, true);
    assert.equal(EXPLORER_EMBED.notAnN8nClone, true);
    assert.equal(EXPLORER_EMBED.noKekInBrowser, true);
    assert.equal(EXPLORER_EMBED.isolationSuccessIsDenial, true);
    assert.equal(EXPLORER_EMBED.noJonnyChange, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
  });
});
