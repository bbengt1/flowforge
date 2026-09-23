import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  composeWorkflowActivation,
  editorActivationTopBarLabel,
} from "./editor-activation.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { D5_HARD_LINE, TEST_RUN_SAVE_FIRST_HELP } from "./editor-test-run.ts";
import { EDITOR_TOPBAR_CHUNKING } from "./editor-topbar-chunking.ts";
import {
  EDITOR_WORKING_MEMORY,
  EDITOR_WORKING_MEMORY_DRAFT,
  EDITOR_WORKING_MEMORY_HELP,
  EDITOR_WORKING_MEMORY_NOT_ACTIVE,
  EDITOR_WORKING_MEMORY_SOURCES,
  EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED,
  EDITOR_WORKING_MEMORY_TEST_RUN,
  EDITOR_WORKING_MEMORY_UNSAVED_TEST_RUN,
  UXL2_BRIEF,
  UXL2_EPIC,
  UXL2_ID,
  UXL2_KEEP_STORY_OPEN,
  UXL2_STORY,
  editorHasPublishedVersion,
  editorWorkingMemoryChrome,
  editorWorkingMemoryDraftLabel,
  editorWorkingMemoryExplainsUnsaved,
  editorWorkingMemoryHomeMatchesEditor,
  editorWorkingMemoryHoldsHardLines,
  editorWorkingMemoryInheritsPriorStories,
  editorWorkingMemoryInventedActivation,
  editorWorkingMemoryMentionsTestRunModel,
  editorWorkingMemoryPlacesCanvasTriggers,
  editorWorkingMemoryPublishedLabel,
  editorWorkingMemoryTestRunCopy,
} from "./editor-working-memory.ts";
import {
  HOME_ACTIVATION,
  composeHomeActivation,
  homeActivationFromEditorState,
} from "./home-activation.ts";
import type { WorkflowVersion } from "./workflow-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_A = "22222222-2222-4222-8222-222222222222";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function version(
  id: string,
  versionNumber: number,
  overrides: Partial<WorkflowVersion> = {},
): WorkflowVersion {
  return {
    id,
    workflowId: WORKFLOW_ID,
    versionNumber,
    digest: `sha256:${versionNumber}`,
    publishNote: "ship",
    publishedAt: "2026-09-12T00:00:00Z",
    ...overrides,
  };
}

describe("UXL.2 draft / published / test-run working memory", () => {
  it("keeps #289 open and cites epic #287", () => {
    assert.equal(UXL2_STORY, 289);
    assert.equal(UXL2_EPIC, 287);
    assert.equal(UXL2_KEEP_STORY_OPEN, true);
    assert.equal(UXL2_ID, "UXL.2-working-memory");
    assert.equal(UXL2_BRIEF, "docs/internal/flowforge-ux-laws.md");
    assert.match(EDITOR_WORKING_MEMORY_HELP, /editing a draft/);
    assert.match(EDITOR_WORKING_MEMORY_HELP, /not active/);
    assert.match(EDITOR_WORKING_MEMORY_HELP, /publish a test version/);
    assert.equal(EDITOR_WORKING_MEMORY.uxl3ThroughUxl8OutOfScope, true);
    assert.equal(EDITOR_WORKING_MEMORY.jonnyNoneExpected, true);
    assert.equal(EDITOR_WORKING_MEMORY.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /Editing a draft/);
    assert.match(frontend, /publish a test version, then start it/);
  });

  it("names persistent chrome states in words", () => {
    assert.equal(editorWorkingMemoryDraftLabel(), "Editing a draft");
    assert.equal(EDITOR_WORKING_MEMORY_DRAFT, "Editing a draft");
    assert.equal(
      editorWorkingMemoryTestRunCopy(),
      "Test run: publish a test version, then start it.",
    );
    assert.match(EDITOR_WORKING_MEMORY_TEST_RUN, /publish a test version, then start it/);
    assert.equal(EDITOR_WORKING_MEMORY_NOT_ACTIVE, "not active");

    const draft = composeWorkflowActivation({ versions: [] });
    assert.equal(editorWorkingMemoryPublishedLabel(draft), "Draft — not live");
    assert.equal(editorActivationTopBarLabel(draft), "Draft — not live");
    assert.equal(draft.draftLooksLive, false);
    assert.equal(draft.live, false);

    const inactive = composeWorkflowActivation({
      versions: [version(VERSION_A, 2)],
    });
    assert.equal(editorWorkingMemoryPublishedLabel(inactive), "not active");

    const active = composeWorkflowActivation({
      versions: [version(VERSION_A, 4)],
      pins: [
        {
          kind: "webhook",
          id: "44444444-4444-4444-8444-444444444444",
          workflowVersionId: VERSION_A,
          status: "enabled",
          label: "wh",
        },
      ],
    });
    assert.equal(
      editorWorkingMemoryPublishedLabel(active),
      "published v4 is active",
    );
  });

  it("disables or explains unsaved Test run and Start published without testing open YAML", () => {
    const unsaved = editorWorkingMemoryChrome({
      dirty: true,
      hasWorkflow: true,
      revision: 2,
      hasPublishedVersion: false,
      permissions: ["workflow.publish", "workflow.execute"],
    });
    assert.equal(unsaved.canTestRun, false);
    assert.equal(unsaved.canStartPublished, false);
    assert.equal(unsaved.testRunHelp, EDITOR_WORKING_MEMORY_UNSAVED_TEST_RUN);
    assert.equal(unsaved.startHelp, EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED);
    assert.match(unsaved.testRunCopy, /publish a test version, then start it/);
    assert.match(TEST_RUN_SAVE_FIRST_HELP, /last saved draft/);

    const savedDraft = editorWorkingMemoryChrome({
      dirty: false,
      hasWorkflow: true,
      revision: 2,
      hasPublishedVersion: false,
      permissions: ["workflow.publish", "workflow.execute"],
    });
    assert.equal(savedDraft.canTestRun, true);
    assert.equal(savedDraft.canStartPublished, false);
    assert.equal(savedDraft.testRunHelp, EDITOR_WORKING_MEMORY_TEST_RUN);
    assert.equal(savedDraft.startHelp, EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED);

    const published = editorWorkingMemoryChrome({
      dirty: false,
      hasWorkflow: true,
      revision: 3,
      hasPublishedVersion: true,
      permissions: ["workflow.publish", "workflow.execute"],
    });
    assert.equal(published.canTestRun, true);
    assert.equal(published.canStartPublished, true);
    assert.equal(editorHasPublishedVersion([version(VERSION_A, 1)]), true);
    assert.equal(editorHasPublishedVersion([]), false);
  });

  it("keeps home activation wording matched to the editor", () => {
    const homeDraft = composeHomeActivation({
      workflowId: WORKFLOW_ID,
      latestVersionNumber: 0,
    });
    const editorDraft = composeWorkflowActivation({ versions: [] });
    assert.equal(
      editorWorkingMemoryHomeMatchesEditor(
        editorWorkingMemoryPublishedLabel(editorDraft),
        homeDraft.label,
      ),
      true,
    );
    assert.equal(homeDraft.draftLooksLive, false);
    assert.equal(HOME_ACTIVATION.draftsNeverLookLive, true);

    const editorActive = composeWorkflowActivation({
      versions: [version(VERSION_A, 3)],
      pins: [
        {
          kind: "webhook",
          id: "44444444-4444-4444-8444-444444444444",
          workflowVersionId: VERSION_A,
          status: "enabled",
          label: "wh",
        },
      ],
    });
    const homeActive = homeActivationFromEditorState(WORKFLOW_ID, editorActive);
    assert.equal(
      editorWorkingMemoryHomeMatchesEditor(
        editorWorkingMemoryPublishedLabel(editorActive),
        homeActive.label,
      ),
      true,
    );
    assert.equal(homeActive.label, "published v3 is active");
    assert.equal(homeActive.draftLooksLive, false);
  });

  it("densifies editor + Triggers + home chrome in place and inherits UXL.1 groups", () => {
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const chrome = source("src/components/workflows/EditorActivationChrome.tsx");
    const tabs = source("src/components/workflows/EditorWorkflowTabs.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    const homeStatus = source("src/components/home/HomeActivationStatus.tsx");

    assert.match(topBar, /data-editor-working-memory="draft"/);
    assert.match(topBar, /data-editor-working-memory="test-run"/);
    assert.match(topBar, /editorWorkingMemoryChrome/);
    assert.match(topBar, /memory\.canStartPublished/);
    assert.match(topBar, /EDITOR_TOPBAR_GROUP_LABELS.run/);
    assert.equal(EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers, true);
    assert.equal(editorWorkingMemoryInheritsPriorStories(), true);

    assert.match(chrome, /editorWorkingMemoryDraftLabel/);
    assert.match(chrome, /data-editor-working-memory="draft"/);
    assert.match(chrome, /data-editor-working-memory="published"/);
    assert.match(chrome, /state\.label/);
    assert.match(tabs, /EditorActivationChrome/);
    assert.ok(
      tabs.indexOf("EditorActivationChrome") < tabs.indexOf("WebhookTriggerPanel"),
    );

    assert.match(home, /EDITOR_WORKING_MEMORY_TEST_RUN/);
    assert.match(home, /data-home-working-memory="test-run"/);
    assert.match(homeStatus, /data-home-working-memory="published"/);
    assert.equal(editorWorkingMemoryMentionsTestRunModel(topBar), true);
    assert.equal(editorWorkingMemoryExplainsUnsaved(topBar), true);
  });

  it("holds hard lines and does not invent activation or canvas triggers", () => {
    assert.equal(editorWorkingMemoryHoldsHardLines(), true);
    assert.equal(EDITOR_WORKING_MEMORY.noNewActivationResource, true);
    assert.equal(EDITOR_WORKING_MEMORY.noCanvasTriggerNodes, true);
    assert.equal(EDITOR_WORKING_MEMORY.d5NeverRunUnsavedDraftBuffer, true);
    assert.equal(D5_HARD_LINE.noSilentTestOpenEditorYaml, true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const chrome = source("src/components/workflows/EditorActivationChrome.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(editorWorkingMemoryInventedActivation(topBar), false);
    assert.equal(editorWorkingMemoryPlacesCanvasTriggers(chrome), false);
    assert.equal(editorWorkingMemoryPlacesCanvasTriggers(home), false);
    for (const path of EDITOR_WORKING_MEMORY_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
