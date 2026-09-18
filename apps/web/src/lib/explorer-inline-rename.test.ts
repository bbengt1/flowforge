import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_INLINE_RENAME,
  EXPLORER_INLINE_RENAME_AUTO_CLOSE_TOKENS,
  EXPLORER_INLINE_RENAME_HELP,
  EXPLORER_INLINE_RENAME_MODAL_TOKENS,
  EXPLORER_INLINE_RENAME_SOURCES,
  X7_BRIEF,
  X7_EPIC,
  X7_ID,
  X7_KEEP_EPIC_OPEN,
  X7_KEEP_STORY_OPEN,
  X7_STORY,
  explorerDocsKeepStoryOpen,
  explorerEventBlocksInlineRenameHotkey,
  explorerHomeCreatesThenInlineRenames,
  explorerHomeRenameStaysInline,
  explorerInlineRenameHoldsHardLines,
  explorerInlineRenameInheritsPriorStories,
  inlineRenameBlurDecision,
  inlineRenameEnterDecision,
  inlineRenameF2Target,
  nextNewFolderName,
} from "./explorer-inline-rename.ts";
import {
  EXPLORER_CONTEXT_MENU,
  explorerHomeWiresExistingVerbs,
} from "./explorer-context-menu.ts";
import { EXPLORER_HOME_COPY } from "./explorer-home-copy.ts";
import {
  FOLDER_SIBLING_HELP,
  NEW_FOLDER_LABEL,
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

const newFolder: WorkflowFolder = {
  ...ops,
  id: "33333333-3333-4333-8333-333333333333",
  name: NEW_FOLDER_LABEL,
};

describe("X.7 Explorer inline rename", () => {
  it("keeps #396 open and cites the folder IA", () => {
    assert.equal(X7_STORY, 396);
    assert.equal(X7_EPIC, 379);
    assert.equal(X7_KEEP_STORY_OPEN, true);
    assert.equal(X7_KEEP_EPIC_OPEN, true);
    assert.equal(X7_ID, "X.7-explorer-inline-rename");
    assert.equal(X7_BRIEF, "docs/architecture/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_INLINE_RENAME.keep396Open, true);
    assert.equal(EXPLORER_INLINE_RENAME.keep379Open, true);
    assert.equal(EXPLORER_INLINE_RENAME.keep393Open, true);
    assert.equal(EXPLORER_INLINE_RENAME.noAutoCloseEpic, true);
    assert.equal(EXPLORER_INLINE_RENAME.noAutoCloseUnrelated, true);
    assert.equal(EXPLORER_INLINE_RENAME.noJonnyChange, true);
    assert.equal(EXPLORER_INLINE_RENAME.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepStoryOpen(frontend), true);
    assert.match(frontend, /inline rename|in-place|in the tree/i);
    const brief = repoSource(X7_BRIEF);
    assert.equal(explorerDocsKeepStoryOpen(brief), true);
    assert.match(brief, /X\.7/);
    for (const token of EXPLORER_INLINE_RENAME_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
      assert.equal(brief.includes(token), false, token);
    }
  });

  it("creates a unique New folder name among siblings", () => {
    assert.equal(nextNewFolderName([], null), NEW_FOLDER_LABEL);
    assert.equal(nextNewFolderName([ops], null), NEW_FOLDER_LABEL);
    assert.equal(
      nextNewFolderName([newFolder], null),
      `${NEW_FOLDER_LABEL} (2)`,
    );
    assert.equal(
      nextNewFolderName(
        [newFolder, { ...newFolder, id: ops.id, name: `${NEW_FOLDER_LABEL} (2)` }],
        null,
      ),
      `${NEW_FOLDER_LABEL} (3)`,
    );
    assert.equal(nextNewFolderName([newFolder], ops.id), NEW_FOLDER_LABEL);
    assert.equal(
      nextNewFolderName([{ ...newFolder, parentId: ops.id }, oncall], ops.id),
      `${NEW_FOLDER_LABEL} (2)`,
    );
  });

  it("keeps the server name on empty Esc/blur and stays on invalid Enter", () => {
    assert.deepEqual(
      inlineRenameEnterDecision([ops], "", null, ops.id, "Ops"),
      { action: "keep" },
    );
    assert.deepEqual(
      inlineRenameEnterDecision([ops], "  Ops  ", null, ops.id, "Ops"),
      { action: "keep" },
    );
    assert.deepEqual(
      inlineRenameEnterDecision([ops], "Platform", null, ops.id, "Ops"),
      { action: "commit", name: "Platform" },
    );
    assert.deepEqual(
      inlineRenameEnterDecision(
        [ops, { ...newFolder, name: "Platform" }],
        "platform",
        null,
        ops.id,
        "Ops",
      ),
      { action: "invalid", error: FOLDER_SIBLING_HELP },
    );
    assert.deepEqual(
      inlineRenameBlurDecision([ops], "", null, ops.id, "Ops"),
      { action: "keep" },
    );
    assert.deepEqual(
      inlineRenameBlurDecision(
        [ops, { ...newFolder, name: "Platform" }],
        "platform",
        null,
        ops.id,
        "Ops",
      ),
      { action: "keep" },
    );
    assert.deepEqual(
      inlineRenameBlurDecision([ops], "Platform", null, ops.id, "Ops"),
      { action: "commit", name: "Platform" },
    );
  });

  it("F2 targets a selected folder and never Unfiled or viewers", () => {
    assert.equal(
      inlineRenameF2Target(true, { kind: "folder", id: ops.id }, null),
      ops.id,
    );
    assert.equal(
      inlineRenameF2Target(
        true,
        { kind: "unfiled" },
        { kind: "folder", id: oncall.id },
      ),
      oncall.id,
    );
    assert.equal(
      inlineRenameF2Target(true, { kind: "unfiled" }, null),
      null,
    );
    assert.equal(
      inlineRenameF2Target(false, { kind: "folder", id: ops.id }, null),
      null,
    );
    assert.equal(
      inlineRenameF2Target(
        true,
        { kind: "folder", id: ops.id },
        { kind: "workflow", id: "wf-1" },
      ),
      null,
    );
    assert.equal(
      explorerEventBlocksInlineRenameHotkey({ tagName: "INPUT" }),
      true,
    );
    assert.equal(
      explorerEventBlocksInlineRenameHotkey({ tagName: "BUTTON" }),
      false,
    );
  });

  it("wires create→inline rename and drops the name modal", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerHomeCreatesThenInlineRenames(home), true);
    assert.equal(explorerHomeRenameStaysInline(home), true);
    assert.equal(explorerHomeWiresExistingVerbs(home), true);
    assert.equal(EXPLORER_INLINE_RENAME.createThenInlineRename, true);
    assert.equal(EXPLORER_INLINE_RENAME.noModalNamePrompt, true);
    assert.equal(EXPLORER_INLINE_RENAME.noWindowPrompt, true);
    assert.equal(EXPLORER_INLINE_RENAME.renameUsesInlineField, true);
    assert.equal(EXPLORER_INLINE_RENAME.f2RenamesSelectedFolder, true);
    assert.equal(EXPLORER_INLINE_RENAME.interactionOnlyNoNewLook, true);
    assert.match(home, /data-home-folder-inline-rename/);
    assert.match(home, /data-x7="inline-rename"/);
    assert.match(home, /nextNewFolderName/);
    assert.match(home, /startInlineRename/);
    assert.doesNotMatch(home, /data-home-folder-dialog/);
    assert.doesNotMatch(home, /window\.prompt/);
    for (const token of EXPLORER_INLINE_RENAME_MODAL_TOKENS) {
      assert.equal(home.includes(token), false, token);
    }
    assert.match(EXPLORER_INLINE_RENAME_HELP, /in the tree/);
    assert.match(EXPLORER_INLINE_RENAME_HELP, /F2/);
    assert.match(EXPLORER_INLINE_RENAME_HELP, /Enter/);
    assert.match(EXPLORER_INLINE_RENAME_HELP, /Escape/);
  });

  it("keeps context-menu verbs, Unfiled lock, and no workflow rename API", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const menu = source("src/lib/explorer-context-menu.ts");
    assert.equal(EXPLORER_CONTEXT_MENU.folderMenuNewRenameDeleteExpand, true);
    assert.equal(EXPLORER_CONTEXT_MENU.unfiledNotDestructivelyMutable, true);
    assert.equal(EXPLORER_CONTEXT_MENU.workflowRenameOmittedNoApi, true);
    assert.equal(EXPLORER_INLINE_RENAME.workflowRenameOmittedNoApi, true);
    assert.equal(EXPLORER_INLINE_RENAME.unfiledCannotRename, true);
    assert.equal(EXPLORER_INLINE_RENAME.refuseIfNonemptyDelete, true);
    assert.match(home, /folderAllowsRenameOrDelete/);
    assert.match(home, /openCreateFolder/);
    assert.match(home, /openRenameFolder/);
    assert.match(home, /removeFolder/);
    assert.match(menu, /"new-folder"/);
    assert.match(menu, /"rename"/);
    assert.doesNotMatch(home, /renameWorkflow\(/);
    assert.doesNotMatch(menu, /workflow-rename/);
  });

  it("holds hard lines and inherits X.1–X.6 / F.1–F.7", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerInlineRenameHoldsHardLines(), true);
    assert.equal(explorerInlineRenameInheritsPriorStories(), true);
    assert.equal(EXPLORER_INLINE_RENAME.inheritV1Tokens, true);
    assert.equal(EXPLORER_HOME_COPY.keep393Open, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of EXPLORER_INLINE_RENAME_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
