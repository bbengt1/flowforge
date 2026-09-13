import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  F2_BRIEF,
  F2_EPIC,
  F2_HOME_FOLDER,
  F2_HOME_FOLDER_SOURCES,
  F2_ID,
  F2_KEEP_STORY_OPEN,
  F2_STORY,
  F3_BRIEF,
  F3_EPIC,
  F3_HOME_FOLDER,
  F3_ID,
  F3_KEEP_STORY_OPEN,
  F3_STORY,
  FOLDER_DEPTH_HELP,
  FOLDER_NAME_RULES_HELP,
  FOLDER_NOT_EMPTY_HELP,
  FOLDER_QUERY,
  FOLDER_SIBLING_HELP,
  FOLDER_UNFILED_LOCKED_HELP,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_GRAPHEMES,
  UNFILED_FOLDER_ID,
  UNFILED_FOLDER_LABEL,
  ancestorIdsForSelection,
  applyFolderQuery,
  breadcrumbSegments,
  buildFolderTree,
  canCreateChildFolder,
  canMutateWorkflowFolders,
  childFolderCount,
  consumeFolderWorkspaceChange,
  createFolderParentId,
  folderAllowsRenameOrDelete,
  folderDeleteBlocked,
  folderExpandStorageKey,
  folderMutateBegin,
  folderMutateFinish,
  folderMutateLabel,
  folderNameMap,
  folderNameSubmitError,
  folderNotEmptyCounts,
  folderNotEmptyDetail,
  folderPath,
  folderPathLabel,
  folderQueryValue,
  folderSelectionsEqual,
  homeFolderRailHasMoveVerb,
  homeFolderRailHasOrganizeVerbs,
  homeFolderRailNestsMain,
  homeUsesPrefixInNameAsPrimaryOrganizer,
  isWorkflowFolder,
  isWorkflowFolderProxySegments,
  listWorkflowsPath,
  normalizeFolderName,
  parseFolderQuery,
  readExpandedFolderIds,
  resolveFolderSelection,
  selectionAfterFolderDelete,
  siblingFolderNameTaken,
  workflowsFolderIdQuery,
  writeExpandedFolderIds,
  type WorkflowFolder,
} from "./workflow-folder.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
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

const platform: WorkflowFolder = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: ops.workspaceId,
  parentId: null,
  name: "Platform",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
};

describe("F.2 home folder rail + select", () => {
  it("keeps #309 open and cites the folder IA", () => {
    assert.equal(F2_STORY, 309);
    assert.equal(F2_EPIC, 307);
    assert.equal(F2_KEEP_STORY_OPEN, true);
    assert.equal(F2_ID, "F.2-home-folder-rail-select");
    assert.equal(F2_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(F2_HOME_FOLDER.keep309Open, true);
    assert.equal(F2_HOME_FOLDER.selectOnly, true);
    assert.equal(F2_HOME_FOLDER.unfiledIsVirtual, true);
    assert.equal(F2_HOME_FOLDER.foldersNotInYaml, true);
    assert.equal(F2_HOME_FOLDER.draftsNeverRun, true);
    assert.equal(F2_HOME_FOLDER.noCascadeDelete, true);
    assert.equal(F2_HOME_FOLDER.isolationSuccessIsDenial, true);
    assert.equal(F2_HOME_FOLDER.noNewApi, true);
    const brief = repoSource("docs/architecture/flowforge-workflow-folders.md");
    assert.match(brief, /F\.2/);
    assert.match(brief, /Unfiled/);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.match(frontend, /#309/);
    assert.match(frontend, /keep #309 open/i);
    assert.match(frontend, /GET \/workflow-folders/);
    assert.match(frontend, /\?folder=/);
  });

  it("treats Unfiled as virtual and builds a sibling-sorted tree", () => {
    assert.equal(UNFILED_FOLDER_LABEL, "Unfiled");
    assert.equal(UNFILED_FOLDER_ID, "unfiled");
    assert.equal(isWorkflowFolder({ ...ops, parentId: null }), true);
    assert.equal(
      isWorkflowFolder({ ...ops, id: "not-a-uuid", parentId: null }),
      false,
    );
    const tree = buildFolderTree([oncall, platform, ops]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ["Ops", "Platform"],
    );
    assert.deepEqual(
      tree[0]?.children.map((node) => node.name),
      ["On-call"],
    );
    assert.equal(
      tree.some((node) => node.name === UNFILED_FOLDER_LABEL),
      false,
    );
    assert.deepEqual(
      folderPath([ops, oncall, platform], oncall.id).map((item) => item.name),
      ["Ops", "On-call"],
    );
    assert.equal(folderPathLabel(folderPath([ops, oncall], oncall.id)), "Ops / On-call");
    assert.equal(folderNameMap([ops, oncall]).get(oncall.id), "Ops / On-call");
    assert.deepEqual(ancestorIdsForSelection([ops, oncall], { kind: "folder", id: oncall.id }), [
      ops.id,
    ]);
    const crumbs = breadcrumbSegments([ops, oncall], {
      kind: "folder",
      id: oncall.id,
    });
    assert.deepEqual(
      crumbs.map((item) => item.label),
      ["Ops", "On-call"],
    );
    assert.deepEqual(breadcrumbSegments([], { kind: "unfiled" }), [
      { selection: { kind: "unfiled" }, label: UNFILED_FOLDER_LABEL },
    ]);
  });

  it("selects Unfiled or a folder and maps GET /workflows?folderId=", () => {
    assert.deepEqual(parseFolderQuery(null), { kind: "unfiled" });
    assert.deepEqual(parseFolderQuery(""), { kind: "unfiled" });
    assert.deepEqual(parseFolderQuery("unfiled"), { kind: "unfiled" });
    assert.deepEqual(parseFolderQuery("not-a-folder"), { kind: "unfiled" });
    assert.deepEqual(parseFolderQuery(ops.id), { kind: "folder", id: ops.id });
    assert.equal(folderQueryValue({ kind: "unfiled" }), "unfiled");
    assert.equal(workflowsFolderIdQuery({ kind: "folder", id: ops.id }), ops.id);
    assert.equal(listWorkflowsPath(), "/workflows");
    assert.equal(listWorkflowsPath("unfiled"), "/workflows?folderId=unfiled");
    assert.equal(
      listWorkflowsPath(ops.id),
      `/workflows?folderId=${ops.id}`,
    );
    assert.deepEqual(
      resolveFolderSelection({ kind: "folder", id: ops.id }, [ops, oncall]),
      { kind: "folder", id: ops.id },
    );
    assert.deepEqual(
      resolveFolderSelection({ kind: "folder", id: ops.id }, [platform]),
      { kind: "unfiled" },
    );
    assert.equal(
      folderSelectionsEqual({ kind: "unfiled" }, { kind: "unfiled" }),
      true,
    );
    assert.equal(
      folderSelectionsEqual({ kind: "folder", id: ops.id }, { kind: "folder", id: oncall.id }),
      false,
    );
  });

  it("syncs ?folder= deep links and drops previous-workspace folder state", () => {
    assert.equal(FOLDER_QUERY, "folder");
    assert.equal(
      applyFolderQuery("?start=1&webhooks=abc", { kind: "unfiled" }),
      "?start=1&webhooks=abc&folder=unfiled",
    );
    assert.equal(
      applyFolderQuery("?folder=unfiled&schedules=1", { kind: "folder", id: ops.id }),
      `?folder=${ops.id}&schedules=1`,
    );
    assert.equal(
      applyFolderQuery(`?folder=${ops.id}&start=1`, { kind: "unfiled" }, { drop: true }),
      "?start=1",
    );
    const storage = new Map<string, string>();
    const memory = {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
    };
    assert.equal(consumeFolderWorkspaceChange("acme|ops", memory), false);
    assert.equal(consumeFolderWorkspaceChange("acme|ops", memory), false);
    assert.equal(consumeFolderWorkspaceChange("acme|prod", memory), true);
    assert.equal(consumeFolderWorkspaceChange("acme|prod", memory), false);
    writeExpandedFolderIds("acme|ops", [ops.id, "nope"], memory);
    assert.deepEqual(readExpandedFolderIds("acme|ops", memory), [ops.id]);
    assert.deepEqual(readExpandedFolderIds("acme|prod", memory), []);
    assert.equal(
      folderExpandStorageKey("acme|ops").startsWith("ff.home.folder.expand:"),
      true,
    );
  });

  it("lets viewers select; F.2 select/deep-link stay intact", () => {
    assert.equal(canMutateWorkflowFolders(["workflow.view"]), false);
    assert.equal(canMutateWorkflowFolders(["workflow.view", "workflow.edit"]), true);
    assert.equal(canMutateWorkflowFolders(null), false);
    assert.equal(F2_HOME_FOLDER.viewerCanSelect, true);
    assert.equal(F2_HOME_FOLDER.noMutateVerbs, true);
    const home = source("src/components/home/WorkflowHome.tsx");
    const client = source("src/lib/workflow-folder-client.ts");
    assert.equal(homeUsesPrefixInNameAsPrimaryOrganizer(home), false);
    assert.equal(homeFolderRailNestsMain(home), false);
    assert.match(home, /aria-label=\{FOLDER_RAIL_LABEL\}/);
    assert.match(home, /data-home-folder-rail="unfiled"/);
    assert.match(home, /data-home-folder-crumb/);
    assert.match(home, /listWorkflowFolders/);
    assert.match(home, /folderId: workflowsFolderIdQuery/);
    assert.match(home, /FOLDER_QUERY/);
    assert.match(home, /consumeFolderWorkspaceChange/);
    assert.match(home, /MANUAL_START_QUERY/);
    assert.match(home, /WEBHOOK_TRIGGER_QUERY/);
    assert.match(home, /SCHEDULE_TRIGGER_QUERY/);
    assert.match(home, /HomeActivationStatus/);
    assert.match(home, /HomeLastRunStatus/);
    assert.match(client, /WORKFLOW_FOLDERS_PATH/);
    assert.doesNotMatch(client, /\/workflows\/.+\/folder/);
    assert.equal(isWorkflowFolderProxySegments(["workflow-folders"]), true);
    assert.equal(
      isWorkflowFolderProxySegments([
        "workflow-folders",
        "11111111-1111-4111-8111-111111111111",
      ]),
      true,
    );
    assert.equal(
      isWorkflowFolderProxySegments([
        "workflows",
        "11111111-1111-4111-8111-111111111111",
        "folder",
      ]),
      true,
    );
    const proxy = source("src/lib/identity-proxy.ts");
    assert.match(proxy, /WORKFLOW_FOLDER_PROXY_ROUTES/);
    for (const path of F2_HOME_FOLDER_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});

describe("F.3 create / rename / delete folders", () => {
  it("keeps #310 open and cites the folder IA", () => {
    assert.equal(F3_STORY, 310);
    assert.equal(F3_EPIC, 307);
    assert.equal(F3_KEEP_STORY_OPEN, true);
    assert.equal(F3_ID, "F.3-create-rename-delete-folders");
    assert.equal(F3_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(F3_HOME_FOLDER.keep310Open, true);
    assert.equal(F3_HOME_FOLDER.foldersNotInYaml, true);
    assert.equal(F3_HOME_FOLDER.draftsNeverRun, true);
    assert.equal(F3_HOME_FOLDER.noCascadeDelete, true);
    assert.equal(F3_HOME_FOLDER.noYamlOrSlugRewrite, true);
    assert.equal(F3_HOME_FOLDER.noActionsDetour, true);
    assert.equal(F3_HOME_FOLDER.noNewApi, true);
    assert.equal(F2_HOME_FOLDER.keep310Open, true);
    const brief = repoSource("docs/architecture/flowforge-workflow-folders.md");
    assert.match(brief, /F\.3/);
    assert.match(brief, /409/);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.match(frontend, /#310/);
    assert.match(frontend, /keep #310 open/i);
  });

  it("validates name rules and sibling uniqueness", () => {
    assert.equal(MAX_FOLDER_NAME_GRAPHEMES, 64);
    assert.deepEqual(normalizeFolderName("  Ops  "), {
      ok: true,
      name: "Ops",
    });
    assert.deepEqual(normalizeFolderName(""), {
      ok: false,
      error: "Enter a folder name.",
    });
    assert.deepEqual(normalizeFolderName("ops/nightly"), {
      ok: false,
      error: FOLDER_NAME_RULES_HELP,
    });
    assert.deepEqual(normalizeFolderName("a".repeat(65)), {
      ok: false,
      error: FOLDER_NAME_RULES_HELP,
    });
    assert.equal(siblingFolderNameTaken([ops, platform], "ops", null), true);
    assert.equal(siblingFolderNameTaken([ops, oncall], "On-call", ops.id), true);
    assert.equal(
      siblingFolderNameTaken([ops, oncall], "On-call", ops.id, oncall.id),
      false,
    );
    assert.equal(folderNameSubmitError([ops], "Ops", null), FOLDER_SIBLING_HELP);
    assert.equal(folderNameSubmitError([ops], "Platform", null), null);
    assert.equal(createFolderParentId({ kind: "unfiled" }), null);
    assert.equal(createFolderParentId({ kind: "folder", id: ops.id }), ops.id);
    assert.equal(canCreateChildFolder([ops, oncall], null), true);
    assert.equal(canCreateChildFolder([ops, oncall], oncall.id), true);
    assert.equal(MAX_FOLDER_DEPTH, 4);
    const deep = [ops, oncall];
    let parent = oncall.id;
    for (let level = 3; level <= 4; level += 1) {
      const id = `${level}3333333-3333-4333-8333-33333333333${level}`;
      deep.push({
        ...platform,
        id,
        parentId: parent,
        name: `L${level}`,
      });
      parent = id;
    }
    assert.equal(canCreateChildFolder(deep, parent), false);
    assert.equal(FOLDER_DEPTH_HELP.includes("4"), true);
  });

  it("disables non-empty delete and returns empty delete to parent/Unfiled", () => {
    assert.equal(folderAllowsRenameOrDelete({ kind: "unfiled" }), false);
    assert.equal(
      folderAllowsRenameOrDelete({ kind: "folder", id: ops.id }),
      true,
    );
    assert.equal(FOLDER_UNFILED_LOCKED_HELP.includes("Unfiled"), true);
    assert.equal(childFolderCount([ops, oncall, platform], ops.id), 1);
    assert.equal(childFolderCount([ops, oncall], oncall.id), 0);
    assert.equal(
      folderDeleteBlocked({ childFolderCount: 1, workflowCount: 0 }),
      true,
    );
    assert.equal(
      folderDeleteBlocked({ childFolderCount: 0, workflowCount: 2 }),
      true,
    );
    assert.equal(
      folderDeleteBlocked({ childFolderCount: 0, workflowCount: null }),
      false,
    );
    assert.equal(
      folderDeleteBlocked({ childFolderCount: 0, workflowCount: 0 }),
      false,
    );
    assert.deepEqual(
      selectionAfterFolderDelete(oncall.id, [ops, oncall], {
        kind: "folder",
        id: oncall.id,
      }),
      { kind: "folder", id: ops.id },
    );
    assert.deepEqual(
      selectionAfterFolderDelete(ops.id, [ops, platform], {
        kind: "folder",
        id: ops.id,
      }),
      { kind: "unfiled" },
    );
    assert.deepEqual(
      selectionAfterFolderDelete(ops.id, [ops, platform], {
        kind: "folder",
        id: platform.id,
      }),
      { kind: "folder", id: platform.id },
    );
    const counts = folderNotEmptyCounts({
      workflowCount: 2,
      childFolderCount: 1,
    });
    assert.deepEqual(counts, { workflowCount: 2, childFolderCount: 1 });
    assert.match(folderNotEmptyDetail(counts!), /2 workflows/);
    assert.match(folderNotEmptyDetail(counts!), /1 child folder/);
    assert.equal(FOLDER_NOT_EMPTY_HELP, "Move or delete contents first.");
  });

  it("shows organize verbs for editors, hides them for viewers, and skips Move", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const client = source("src/lib/workflow-folder-client.ts");
    assert.equal(canMutateWorkflowFolders(["workflow.view"]), false);
    assert.equal(
      canMutateWorkflowFolders(["workflow.view", "workflow.edit"]),
      true,
    );
    assert.equal(F3_HOME_FOLDER.viewersHaveNoOrganizeVerbs, true);
    assert.equal(F3_HOME_FOLDER.organizeVerbsOnRail, true);
    assert.equal(F3_HOME_FOLDER.noWorkflowMove, true);
    assert.equal(F3_HOME_FOLDER.renameOnlyNoReparent, true);
    assert.equal(homeFolderRailHasOrganizeVerbs(home), true);
    assert.equal(homeFolderRailHasMoveVerb(home), false);
    assert.match(home, /canMutateWorkflowFolders/);
    assert.match(home, /canMutateFolders/);
    assert.match(home, /data-home-folder-verb="new"/);
    assert.match(home, /data-home-folder-verb="rename"/);
    assert.match(home, /data-home-folder-verb="delete"/);
    assert.match(home, /\{canMutate \?/);
    assert.match(home, /createWorkflowFolder/);
    assert.match(home, /renameWorkflowFolder/);
    assert.match(home, /deleteWorkflowFolder/);
    assert.match(home, /selectionAfterFolderDelete/);
    assert.match(home, /folderNotEmptyDetail/);
    assert.match(home, /data-doherty-phase/);
    assert.match(home, /folderMutateBegin/);
    assert.doesNotMatch(home, /\/actions/);
    assert.doesNotMatch(home, /parentId:/);
    assert.match(client, /method:\s*"POST"/);
    assert.match(client, /method:\s*"PATCH"/);
    assert.match(client, /method:\s*"DELETE"/);
    assert.match(client, /body:\s*\{\s*name\s*\}/);
    assert.doesNotMatch(client, /workspaceId:/);
    assert.doesNotMatch(client, /\/workflows\/.+\/folder/);
    assert.equal(folderMutateLabel(folderMutateBegin("create")), "Creating folder…");
    assert.equal(
      folderMutateLabel(folderMutateFinish("delete", true)),
      "Folder deleted.",
    );
    assert.equal(
      folderMutateLabel(folderMutateFinish("rename", false)),
      "Folder was not renamed.",
    );
  });
});
