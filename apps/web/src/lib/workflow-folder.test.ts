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
  FOLDER_QUERY,
  UNFILED_FOLDER_ID,
  UNFILED_FOLDER_LABEL,
  ancestorIdsForSelection,
  applyFolderQuery,
  breadcrumbSegments,
  buildFolderTree,
  canMutateWorkflowFolders,
  consumeFolderWorkspaceChange,
  folderExpandStorageKey,
  folderNameMap,
  folderPath,
  folderPathLabel,
  folderQueryValue,
  folderSelectionsEqual,
  homeFolderRailHasMutateVerbs,
  homeFolderRailNestsMain,
  homeUsesPrefixInNameAsPrimaryOrganizer,
  isWorkflowFolder,
  isWorkflowFolderProxySegments,
  listWorkflowsPath,
  parseFolderQuery,
  readExpandedFolderIds,
  resolveFolderSelection,
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

  it("lets viewers select and locks F.2 to no mutate verbs", () => {
    assert.equal(canMutateWorkflowFolders(["workflow.view"]), false);
    assert.equal(canMutateWorkflowFolders(["workflow.view", "workflow.edit"]), true);
    assert.equal(canMutateWorkflowFolders(null), false);
    assert.equal(F2_HOME_FOLDER.viewerCanSelect, true);
    assert.equal(F2_HOME_FOLDER.noMutateVerbs, true);
    const home = source("src/components/home/WorkflowHome.tsx");
    const client = source("src/lib/workflow-folder-client.ts");
    assert.equal(homeFolderRailHasMutateVerbs(home), false);
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
    assert.doesNotMatch(home, /method:\s*"POST"/);
    assert.doesNotMatch(client, /method:\s*"(POST|PATCH|DELETE)"/);
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
