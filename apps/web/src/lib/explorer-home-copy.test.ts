import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLORER_HOME_COPY,
  EXPLORER_HOME_COPY_AUTO_CLOSE_TOKENS,
  EXPLORER_HOME_COPY_SOURCES,
  WORKFLOWS_HOME_PAGE_HELP,
  X6_BRIEF,
  X6_EPIC,
  X6_ID,
  X6_KEEP_EPIC_OPEN,
  X6_KEEP_STORY_OPEN,
  X6_STORY,
  explorerDocsKeepStoryOpen,
  explorerHomeCopyHoldsHardLines,
  explorerHomeCopyInheritsPriorStories,
  explorerPageLeaksCommentary,
  explorerPageUsesOperatorHelp,
} from "./explorer-home-copy.ts";
import {
  EXPLORER_DRAFTS_DO_NOT_RUN,
  EXPLORER_EMPTY,
  EXPLORER_FOLDER_TEACH,
  EXPLORER_UNFILED_TEACH,
} from "./explorer-empty-states.ts";
import { EXPLORER_EMBED } from "./explorer-embed.ts";
import { EXPLORER_SELECT_OPEN } from "./explorer-select-open.ts";
import { EXPLORER_SHELL } from "./explorer-shell.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function repoSource(relative: string): string {
  return readFileSync(join(here, "..", "..", "..", "..", relative), "utf8");
}

describe("X.6 Explorer home copy", () => {
  it("keeps #393 open and cites the folder IA", () => {
    assert.equal(X6_STORY, 393);
    assert.equal(X6_EPIC, 379);
    assert.equal(X6_KEEP_STORY_OPEN, true);
    assert.equal(X6_KEEP_EPIC_OPEN, true);
    assert.equal(X6_ID, "X.6-explorer-home-copy");
    assert.equal(X6_BRIEF, "docs/internal/flowforge-workflow-folders.md");
    assert.equal(EXPLORER_HOME_COPY.keep393Open, true);
    assert.equal(EXPLORER_HOME_COPY.keep379Open, true);
    assert.equal(EXPLORER_HOME_COPY.noAutoCloseEpic, true);
    assert.equal(EXPLORER_HOME_COPY.noAutoCloseUnrelated, true);
    assert.equal(EXPLORER_HOME_COPY.noJonnyChange, true);
    assert.equal(EXPLORER_HOME_COPY.d6MigrateInPlace, true);
    const frontend = repoSource("docs/reference/frontend-ui.md");
    assert.equal(explorerDocsKeepStoryOpen(frontend), true);
    assert.match(frontend, /operator help|product-commentary/i);
    const brief = repoSource(X6_BRIEF);
    assert.equal(explorerDocsKeepStoryOpen(brief), true);
    assert.match(brief, /X\.6/);
    for (const token of EXPLORER_HOME_COPY_AUTO_CLOSE_TOKENS) {
      assert.equal(frontend.includes(token), false, token);
      assert.equal(brief.includes(token), false, token);
    }
  });

  it("strips the epic commentary dump from the visible workflows page", () => {
    const page = source("src/app/workflows/page.tsx");
    const embed = source("src/lib/explorer-embed.ts");
    assert.equal(explorerPageUsesOperatorHelp(page), true);
    assert.equal(explorerPageLeaksCommentary(page), false);
    assert.doesNotMatch(page, /keep #\d+ open/i);
    assert.doesNotMatch(page, /Part of #/);
    assert.doesNotMatch(page, /X\.[1-5] \//);
    assert.doesNotMatch(page, /O\.[1-4] \//);
    assert.doesNotMatch(page, /V\.[0-9] \//);
    assert.match(page, /WORKFLOWS_HOME_PAGE_HELP/);
    assert.match(page, /WorkflowHome/);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /Explorer/i);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /Unfiled/);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /Right-click/);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /Single-click/);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /double-click/i);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /Empty folders/);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /Drafts do not run/);
    assert.match(WORKFLOWS_HOME_PAGE_HELP, /activation/i);
    assert.doesNotMatch(WORKFLOWS_HOME_PAGE_HELP, /keep #\d+ open/i);
    assert.doesNotMatch(WORKFLOWS_HOME_PAGE_HELP, /Part of #/);
    assert.match(embed, /same WorkflowHome/i);
    assert.equal(EXPLORER_HOME_COPY.visiblePageHasNoEpicCommentary, true);
    assert.equal(EXPLORER_HOME_COPY.sameWorkflowHomeNoSecondTree, true);
  });

  it("keeps Explorer chrome and empty / Unfiled teaching", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /data-x1="explorer-shell"/);
    assert.match(home, /data-x1="folder-tree"/);
    assert.match(home, /data-x1="content-pane"/);
    assert.match(home, /data-x1="breadcrumb"/);
    assert.match(home, /data-x2="context-menu"/);
    assert.match(home, /data-x3="select-open"/);
    assert.match(home, /data-x4="empty-home"/);
    assert.match(home, /data-x4="empty-folder"/);
    assert.match(home, /data-x4="empty-unfiled"/);
    assert.match(home, /data-x4="drafts-do-not-run"/);
    assert.match(home, /EXPLORER_FOLDER_TEACH|EXPLORER_UNFILED_TEACH/);
    assert.match(EXPLORER_FOLDER_TEACH, /real folder/i);
    assert.match(EXPLORER_UNFILED_TEACH, /cannot rename or delete/i);
    assert.match(EXPLORER_DRAFTS_DO_NOT_RUN, /Drafts do not run/);
    assert.equal(EXPLORER_HOME_COPY.emptyTeachingStays, true);
  });

  it("holds hard lines and inherits X.1–X.5", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(explorerHomeCopyHoldsHardLines(), true);
    assert.equal(explorerHomeCopyInheritsPriorStories(), true);
    assert.equal(EXPLORER_HOME_COPY.yamlIsSourceOfTruth, true);
    assert.equal(EXPLORER_HOME_COPY.draftsNeverRun, true);
    assert.equal(EXPLORER_HOME_COPY.inheritV1Tokens, true);
    assert.equal(EXPLORER_HOME_COPY.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(EXPLORER_SHELL.inheritV1Tokens, true);
    assert.equal(EXPLORER_SELECT_OPEN.singleClickSelectsWithoutNavigate, true);
    assert.equal(EXPLORER_EMPTY.draftsDoNotRunStaysLoud, true);
    assert.equal(EXPLORER_EMBED.sameWorkflowHomeNoSecondTree, true);
    assert.equal(EXPLORER_EMBED.adv021FailClosedWithoutSessionEmbed, true);
    assert.doesNotMatch(home, /#ff6d5a|#ea4b71|#e99854/);
    assert.doesNotMatch(home, /n8n-logo|Execute workflow/);
    assert.doesNotMatch(home, /CREDENTIAL_KEK|keyReference/);
    for (const path of EXPLORER_HOME_COPY_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
