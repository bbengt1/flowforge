import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_VAULT_IDENTITY_KEYS } from "./credential-vault.ts";
import {
  EDITOR_DEVELOPER,
  SETTINGS_DEVELOPER_HREF,
} from "./editor-developer.ts";
import { ACTIONS_CATALOG_HREF, EDITOR_LIBRARY } from "./editor-library.ts";
import { EMPTY_WORKFLOW_HOME_FILTERS } from "./workflow-home.ts";
import { WORKFLOW_TEMPLATES } from "./workflow-templates.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import {
  CANVAS_EMPTY_ADD_ACTION_LABEL,
  CANVAS_EMPTY_HELP,
  EMPTY_STATES_SOURCES,
  EMPTY_STATES_TEACH,
  HOME_EMPTY_CREATE_LABEL,
  HOME_EMPTY_HELP,
  HOME_EMPTY_IMPORT_LABEL,
  HOME_EMPTY_TEMPLATE_HELP,
  HOME_EMPTY_TEMPLATE_LABEL,
  HOME_FILTERED_EMPTY_HEADING,
  UXL6_BRIEF,
  UXL6_EPIC,
  UXL6_ID,
  UXL6_KEEP_STORY_OPEN,
  UXL6_STORY,
  VAULT_EMPTY_HELP,
  canvasAddPathExcludesTriggers,
  canvasEmptyAddPathIsPlusOrAddAction,
  canvasEmptyPlacesTriggers,
  canvasEmptySendsOperatorsToActionsToPlace,
  developerSamplesStayUnderSettings,
  emptyStatesHoldHardLines,
  emptyStatesInheritPriorStories,
  homeEmptyKind,
  homeEmptySaysDraftsDoNotRun,
  homeEmptyShowsDeveloperFixtures,
  homeEmptyTeachesDraftCreateImportTemplate,
  vaultEmptyAddsViaMaskedWizard,
  vaultEmptyShowsSampleSecrets,
  vaultSelectorsStayDisplayNameAndUuid,
  workflowHomeFiltersAreActive,
} from "./empty-states-teach-model.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UXL.6 empty states that teach the model", () => {
  it("keeps #293 open and cites epic #287", () => {
    assert.equal(UXL6_STORY, 293);
    assert.equal(UXL6_EPIC, 287);
    assert.equal(UXL6_KEEP_STORY_OPEN, true);
    assert.equal(UXL6_ID, "UXL.6-empty-states");
    assert.equal(UXL6_BRIEF, "docs/architecture/flowforge-ux-laws.md");
    assert.equal(EMPTY_STATES_TEACH.uxl7ThroughUxl8OutOfScope, true);
    assert.equal(EMPTY_STATES_TEACH.marketplaceOutOfScope, true);
    assert.equal(EMPTY_STATES_TEACH.canvasTriggerNodesOutOfScope, true);
    assert.equal(EMPTY_STATES_TEACH.promotingDeveloperFixturesOutOfScope, true);
    assert.equal(EMPTY_STATES_TEACH.jonnyNoneExpected, true);
    assert.equal(EMPTY_STATES_TEACH.d6MigrateInPlace, true);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /drafts do not run/i);
  });

  it("empty home: Create, Import YAML, or a reviewed template each create a draft", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    assert.equal(homeEmptyTeachesDraftCreateImportTemplate(home), true);
    assert.equal(homeEmptySaysDraftsDoNotRun(home), true);
    assert.match(HOME_EMPTY_HELP, /drafts do not run/i);
    assert.match(HOME_EMPTY_TEMPLATE_HELP, /drafts do not run/i);
    assert.equal(HOME_EMPTY_CREATE_LABEL, "Create");
    assert.equal(HOME_EMPTY_IMPORT_LABEL, "Import YAML");
    assert.equal(HOME_EMPTY_TEMPLATE_LABEL, "Create draft");
    assert.match(home, /data-uxl6="home-empty"/);
    assert.match(home, /data-uxl6="home-filtered"/);
    assert.match(home, /HOME_FILTERED_EMPTY_HEADING/);
    assert.equal(HOME_FILTERED_EMPTY_HEADING.includes("template"), false);
    assert.equal(homeEmptyKind({ recordCount: 0, visibleCount: 0 }), "teach");
    assert.equal(homeEmptyKind({ recordCount: 3, visibleCount: 0 }), "filtered");
    assert.equal(homeEmptyKind({ recordCount: 3, visibleCount: 2 }), "populated");
    assert.equal(
      homeEmptyKind({
        recordCount: 0,
        visibleCount: 0,
        folderScopedEmpty: true,
      }),
      "filtered",
    );
    assert.equal(workflowHomeFiltersAreActive(EMPTY_WORKFLOW_HOME_FILTERS), false);
    assert.equal(
      workflowHomeFiltersAreActive({
        ...EMPTY_WORKFLOW_HOME_FILTERS,
        query: "deploy",
      }),
      true,
    );
    assert.equal(WORKFLOW_TEMPLATES.every((item) => item.definitionYaml.includes("kind: Workflow")), true);
    assert.equal(EMPTY_STATES_TEACH.emptyHomeCreateImportTemplateEachCreateDraft, true);
    assert.equal(EMPTY_STATES_TEACH.emptyHomeCopySaysDraftsDoNotRun, true);
    assert.equal(EMPTY_STATES_TEACH.templatesRemainClientYamlThatPostDraft, true);
  });

  it("empty canvas: + / Add action is the add path; not /actions; not triggers", () => {
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.equal(canvasEmptyAddPathIsPlusOrAddAction(canvas), true);
    assert.equal(canvasEmptySendsOperatorsToActionsToPlace(canvas), false);
    assert.equal(canvasEmptyPlacesTriggers(canvas), false);
    assert.match(CANVAS_EMPTY_HELP, /Add action/);
    assert.match(CANVAS_EMPTY_HELP, /\/actions is the catalog reference/);
    assert.match(CANVAS_EMPTY_HELP, /not canvas nodes/);
    assert.equal(CANVAS_EMPTY_ADD_ACTION_LABEL, "Add action");
    assert.equal(ACTIONS_CATALOG_HREF, "/actions");
    assert.equal(EDITOR_LIBRARY.actionsRouteIsCatalogReference, true);
    assert.equal(EDITOR_LIBRARY.triggersExcluded, true);
    const catalog: WorkflowCatalog = {
      apiVersion: "flowforge/v1",
      rules: { triggersAreWorkflowLevel: true },
      triggers: [],
      nodes: [
        { type: "data.set", phase: "core", enabled: true },
        { type: "manual", phase: "core", enabled: true },
      ],
    };
    assert.equal(canvasAddPathExcludesTriggers(catalog), true);
    assert.equal(EMPTY_STATES_TEACH.emptyCanvasPlusOrAddActionIsAddPath, true);
    assert.equal(EMPTY_STATES_TEACH.emptyCanvasDoesNotSendOperatorsToActionsToPlace, true);
    assert.equal(EMPTY_STATES_TEACH.emptyCanvasDoesNotPlaceTriggers, true);
  });

  it("empty vault: masked wizard; display-name + UUID; no sample secrets", () => {
    const vault = source("src/components/credentials/CredentialVault.tsx");
    assert.equal(vaultEmptyAddsViaMaskedWizard(vault), true);
    assert.equal(vaultEmptyShowsSampleSecrets(vault), false);
    assert.equal(vaultSelectorsStayDisplayNameAndUuid(), true);
    assert.deepEqual([...CREDENTIAL_VAULT_IDENTITY_KEYS], ["displayName", "id"]);
    assert.match(VAULT_EMPTY_HELP, /masked wizard/);
    assert.match(VAULT_EMPTY_HELP, /display name \+ UUID/i);
    assert.match(VAULT_EMPTY_HELP, /No sample secrets/);
    assert.equal(EMPTY_STATES_TEACH.emptyVaultAddsViaMaskedWizard, true);
    assert.equal(EMPTY_STATES_TEACH.noSampleSecrets, true);
    assert.equal(EMPTY_STATES_TEACH.noKekInBrowser, true);
  });

  it("does not promote starter/invalid YAML; Developer samples stay under Settings", () => {
    const home = source("src/components/home/WorkflowHome.tsx");
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    const vault = source("src/components/credentials/CredentialVault.tsx");
    const settings = source("src/components/settings/DeveloperSettings.tsx");
    assert.equal(homeEmptyShowsDeveloperFixtures(home), false);
    assert.equal(homeEmptyShowsDeveloperFixtures(canvas), false);
    assert.equal(homeEmptyShowsDeveloperFixtures(vault), false);
    assert.equal(developerSamplesStayUnderSettings(settings), true);
    assert.equal(SETTINGS_DEVELOPER_HREF, "/settings#developer");
    assert.equal(EDITOR_DEVELOPER.starterInvalidNotPrimaryButtons, true);
    assert.equal(EMPTY_STATES_TEACH.noStarterInvalidYamlAsPrimaryButtons, true);
    assert.equal(EMPTY_STATES_TEACH.developerSamplesStayUnderSettings, true);
  });

  it("holds hard lines and inherits prior chrome", () => {
    assert.equal(emptyStatesHoldHardLines(), true);
    assert.equal(emptyStatesInheritPriorStories(), true);
    assert.equal(EMPTY_STATES_TEACH.yamlIsSourceOfTruth, true);
    assert.equal(EMPTY_STATES_TEACH.draftsNeverRun, true);
    assert.equal(EMPTY_STATES_TEACH.notAnN8nClone, true);
    for (const path of EMPTY_STATES_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
