import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDITOR_CHROME,
  EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT,
  EDITOR_WORKFLOWS_HREF,
  EDITOR_YAML_OPEN_ON_FIRST_PAINT,
  UX1_EPIC,
  UX1_KEEP_STORY_OPEN,
  UX1_STORY,
  canPublishLastSavedDraft,
  canSaveDraftFromChrome,
  editorCanStartPublished,
  editorDirtyLabel,
  editorEmbedRouteUnchanged,
  editorEmbedWorkflowPath,
  editorHeading,
  editorRevisionLabel,
  editorStartVersions,
} from "./editor-chrome.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import type { WorkflowVersion } from "./workflow-types.ts";

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workflowId: "11111111-1111-4111-8111-111111111111",
    versionNumber: 1,
    digest: "sha256:abc",
    definitionYaml: "apiVersion: flowforge/v1\n",
    publishNote: "ship",
    publishedAt: "2026-01-01T00:00:00Z",
    publishedBy: "op",
    ...overrides,
  };
}

describe("UX.1 editor chrome", () => {
  it("keeps #196 open and cites epic #195", () => {
    assert.equal(UX1_STORY, 196);
    assert.equal(UX1_EPIC, 195);
    assert.equal(UX1_KEEP_STORY_OPEN, true);
  });

  it("hides YAML and WorkflowList from the first-paint viewport", () => {
    assert.equal(EDITOR_YAML_OPEN_ON_FIRST_PAINT, false);
    assert.equal(EDITOR_CHROME.yamlHiddenOnFirstPaint, true);
    assert.equal(EDITOR_CHROME.workflowListInEditor, false);
    assert.equal(EDITOR_CHROME.createImportOnWorkflowsHome, true);
    assert.equal(EDITOR_WORKFLOWS_HREF, "/workflows");
    assert.equal(EDITOR_CHROME.libraryHiddenOnFirstPaint, true);
    assert.equal(EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT, false);
  });

  it("uses the workflow name as the single heading", () => {
    assert.equal(editorHeading("Deploy API"), "Deploy API");
    assert.equal(editorHeading("  "), "Workflow editor");
    assert.equal(editorHeading(null), "Workflow editor");
    assert.equal(editorDirtyLabel(true), "Unsaved");
    assert.equal(editorDirtyLabel(false), "Saved");
    assert.equal(editorRevisionLabel(4), "revision 4");
    assert.equal(editorRevisionLabel(null), "revision —");
  });

  it("disables save while invalid and publish while dirty", () => {
    assert.equal(
      canSaveDraftFromChrome({
        status: "invalid",
        errors: [{ path: "spec.nodes", code: "invalid", message: "bad" }],
        hasWorkflow: true,
        revision: 1,
      }),
      false,
    );
    assert.equal(
      canSaveDraftFromChrome({
        status: "valid",
        errors: [],
        hasWorkflow: true,
        revision: 1,
      }),
      true,
    );
    assert.equal(
      canPublishLastSavedDraft({
        dirty: true,
        hasWorkflow: true,
        revision: 1,
      }),
      false,
    );
    assert.equal(
      canPublishLastSavedDraft({
        dirty: false,
        hasWorkflow: true,
        revision: 1,
      }),
      true,
    );
  });

  it("starts published versions only — drafts cannot run", () => {
    const published = version({ id: "22222222-2222-4222-8222-222222222222" });
    const draftShaped = version({ id: "draft" });
    assert.deepEqual(
      editorStartVersions([draftShaped, published]).map((item) => item.id),
      ["22222222-2222-4222-8222-222222222222"],
    );
    assert.equal(
      editorCanStartPublished({
        versions: [published],
        selectedVersionId: "22222222-2222-4222-8222-222222222222",
      }),
      true,
    );
    assert.equal(
      editorCanStartPublished({
        versions: [published],
        selectedVersionId: "draft",
      }),
      false,
    );
    assert.equal(EDITOR_CHROME.startPublishedVersionsOnly, true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
  });

  it("does not add embed routes or treat host query as authorization", () => {
    assert.equal(editorEmbedWorkflowPath("abc"), "/embed/v1/workflows/abc");
    assert.equal(editorEmbedRouteUnchanged(), true);
    assert.equal(
      EMBED_ROUTES.filter((item) => item.id === "workflow").length,
      1,
    );
    assert.equal(EDITOR_CHROME.noNewEmbedRoutes, true);
    assert.equal(EDITOR_CHROME.hostQueryNotAuthorization, true);
    assert.equal(EDITOR_CHROME.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
    assert.deepEqual(EDITOR_CHROME.keyboard, {
      skipLink: true,
      canvasFocus: true,
      zoomShortcuts: true,
      wizardEscape: true,
    });
  });
});
