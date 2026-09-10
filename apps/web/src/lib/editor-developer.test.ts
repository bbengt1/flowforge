import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandHref } from "./command-palette.ts";
import {
  EDITOR_DEVELOPER,
  EDITOR_TOP_BAR_PRIMARY_ACTIONS,
  EDITOR_YAML_DISCLOSURE_TOOLS,
  EDITOR_YAML_FILE_MENU,
  EDITOR_YAML_OPTIONAL_MENU,
  EDITOR_YAML_PRIMARY_TOOLS,
  INVALID_YAML_FIXTURE_ERRORS,
  SETTINGS_DEVELOPER_HREF,
  UX2_EPIC,
  UX2_KEEP_STORY_OPEN,
  UX2_STORY,
  WORKFLOWS_IMPORT_HREF,
  isDemotedDeveloperTool,
  isPrimaryEditorAction,
  loadDeveloperYaml,
} from "./editor-developer.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML } from "./workflow.ts";

describe("UX.2 editor developer chrome", () => {
  it("keeps #197 open and cites epic #195", () => {
    assert.equal(UX2_STORY, 197);
    assert.equal(UX2_EPIC, 195);
    assert.equal(UX2_KEEP_STORY_OPEN, true);
  });

  it("keeps starter and invalid YAML out of primary chrome", () => {
    assert.equal(EDITOR_DEVELOPER.starterInvalidNotPrimaryButtons, true);
    assert.equal(
      EDITOR_DEVELOPER.starterInvalidPlacement,
      "yaml-disclosure-or-settings-developer",
    );
    assert.deepEqual([...EDITOR_TOP_BAR_PRIMARY_ACTIONS], [
      "yaml",
      "save-draft",
      "publish",
      "start-published",
    ]);
    assert.equal(isPrimaryEditorAction("load-starter-yaml"), false);
    assert.equal(isPrimaryEditorAction("load-invalid-yaml"), false);
    assert.equal(isPrimaryEditorAction("normalize"), false);
    assert.deepEqual([...EDITOR_YAML_DISCLOSURE_TOOLS], [
      "load-starter-yaml",
      "load-invalid-yaml",
    ]);
    assert.equal(SETTINGS_DEVELOPER_HREF, "/settings#developer");
  });

  it("exposes normalize from YAML mode or Commands, not as a Save peer", () => {
    assert.equal(EDITOR_DEVELOPER.normalizePlacement, "yaml-mode-or-commands");
    assert.equal(EDITOR_DEVELOPER.normalizeNotSavePeer, true);
    assert.deepEqual([...EDITOR_YAML_PRIMARY_TOOLS], ["validate", "normalize"]);
    assert.equal(commandHref({ type: "normalize" }), null);
    assert.equal(isDemotedDeveloperTool("save-draft"), false);
    assert.equal(isDemotedDeveloperTool("normalize"), true);
    assert.equal(isDemotedDeveloperTool("load-starter-yaml"), true);
    assert.ok(!EDITOR_TOP_BAR_PRIMARY_ACTIONS.includes("normalize" as never));
  });

  it("keeps import on workflow home and optional YAML-mode menu", () => {
    assert.equal(EDITOR_DEVELOPER.importOnHome, true);
    assert.equal(EDITOR_DEVELOPER.importOptionalYamlMenu, true);
    assert.equal(EDITOR_DEVELOPER.importValidatesBeforeCreate, true);
    assert.equal(EDITOR_CHROME.createImportOnWorkflowsHome, true);
    assert.equal(WORKFLOWS_IMPORT_HREF, "/workflows?import=1");
    assert.equal(commandHref({ type: "import-yaml" }), WORKFLOWS_IMPORT_HREF);
    assert.deepEqual([...EDITOR_YAML_OPTIONAL_MENU], ["import-yaml"]);
    assert.equal(EDITOR_YAML_FILE_MENU, "YAML file");
  });

  it("loads starter and invalid fixtures without guessing a graph", () => {
    const starter = loadDeveloperYaml("starter");
    assert.equal(starter.yaml, STARTER_WORKFLOW_YAML);
    assert.equal(starter.status, "idle");
    assert.deepEqual(starter.errors, []);
    assert.equal(starter.clearGraph, false);

    const invalid = loadDeveloperYaml("invalid");
    assert.equal(invalid.yaml, INVALID_WORKFLOW_YAML);
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.clearGraph, true);
    assert.deepEqual(invalid.errors, INVALID_YAML_FIXTURE_ERRORS);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
  });

  it("keeps local seed Example workflows open-and-save on the existing draft loop", () => {
    assert.equal(EDITOR_DEVELOPER.localSeedExamplesOpenAndSave, true);
    assert.equal(EDITOR_CHROME.saveNormalizesThenPutsDraft, true);
  });
});
