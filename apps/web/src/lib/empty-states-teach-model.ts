/**
 * UXL.6: Empty states that teach the model.
 *
 * Relates to #293 / Part of #287. Keep #293 open.
 *
 * Chloe UI only. Densify home `/workflows`, empty canvas, and vault
 * `/credentials` in place (D6). Templates remain client YAML that
 * POST a draft. No marketplace. No canvas trigger nodes. Developer
 * fixtures stay under Settings / YAML disclosure — not primary
 * empty-state buttons.
 *
 * Mental Model: empty home/canvas/vault teach YAML-as-projection
 * and drafts-never-run. Paradox of the Active User: first useful
 * action is Create / Import YAML / reviewed template / canvas **+**
 * / add credential. Cognitive Load: do not dump starter/invalid
 * YAML or send operators to `/actions` to place a node.
 *
 * Out of scope: UXL.7–8, marketplace, canvas trigger nodes,
 * promoting Developer fixtures.
 */

import { CREDENTIAL_VAULT, CREDENTIAL_VAULT_IDENTITY_KEYS } from "./credential-vault.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import {
  EDITOR_DEVELOPER,
  EDITOR_YAML_DEVELOPER_DISCLOSURE,
  SETTINGS_DEVELOPER_HREF,
} from "./editor-developer.ts";
import {
  ACTIONS_CATALOG_HREF,
  EDITOR_LIBRARY,
  canvasAddAffordance,
} from "./editor-library.ts";
import { EDITOR_WORKING_MEMORY } from "./editor-working-memory.ts";
import { HOME_ACTIVATION } from "./home-activation.ts";
import { HOME_ROW_DEVELOPER_FIXTURE_TOKENS, HOME_ROW_SCAN } from "./home-row-scan.ts";
import { PRODUCT_HOME } from "./product-home.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  filterEnabledActionNodes,
  isTriggerActionType,
} from "./workflow-action-library.ts";
import type { WorkflowHomeFilters } from "./workflow-home.ts";
import { WORKFLOW_TEMPLATES } from "./workflow-templates.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

export const UXL6_STORY = 293;
export const UXL6_EPIC = 287;
export const UXL6_KEEP_STORY_OPEN = true;
export const UXL6_ID = "UXL.6-empty-states" as const;

export const UXL6_BRIEF = "docs/architecture/flowforge-ux-laws.md";

export const HOME_EMPTY_HEADING = "No workflows yet";
export const HOME_EMPTY_CREATE_LABEL = "Create";
export const HOME_EMPTY_IMPORT_LABEL = "Import YAML";
export const HOME_EMPTY_TEMPLATE_LABEL = "Create draft";
export const HOME_EMPTY_HELP =
  "Create, Import YAML, or pick a reviewed template. Each creates a draft. Drafts do not run — publish, then start a published version.";
export const HOME_EMPTY_TEMPLATE_HELP =
  "Reviewed templates create a draft in this workspace. Drafts do not run — publish, then start a published version. There is no template API on main.";
export const HOME_FILTERED_EMPTY_HEADING = "No workflows match these filters";
export const HOME_FILTERED_EMPTY_HELP =
  "Clear filters to see existing drafts and published versions. Creating still POSTs a draft — drafts do not run.";

export const CANVAS_EMPTY_PLUS_LABEL = "Open action library";
export const CANVAS_EMPTY_ADD_ACTION_LABEL = "Add action";
export const CANVAS_EMPTY_HELP =
  "Use + or Add action to place a node on this canvas. /actions is the catalog reference — not the add path. Triggers stay on the Triggers tab; they are not canvas nodes.";

export const VAULT_EMPTY_HEADING = "No credentials yet";
export const VAULT_EMPTY_ADD_LABEL = "Open the add-credential wizard";
export const VAULT_EMPTY_HELP =
  "Add a credential through the masked wizard. Selectors stay display name + UUID. No sample secrets.";

export const EMPTY_STATE_DEVELOPER_FIXTURE_TOKENS = [
  ...HOME_ROW_DEVELOPER_FIXTURE_TOKENS,
  "Load starter YAML",
  "Load invalid YAML",
] as const;

export const EMPTY_STATE_SAMPLE_SECRET_TOKENS = [
  "-----BEGIN",
  "kubeconfig:",
  "sk-live",
  "sk-test",
  "example-token",
  "sample-secret",
  "changeme",
  "password123",
  "AKIA",
] as const;

export const EMPTY_STATES_TEACH = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritUxl2Wording: true,
  inheritUxl5HomeScan: true,
  inheritEditorLibraryAddPath: true,
  inheritEditorDeveloperPlacement: true,
  inheritVaultDisplayNameUuid: true,
  d6MigrateInPlace: true,
  emptyHomeCreateImportTemplateEachCreateDraft: true,
  emptyHomeCopySaysDraftsDoNotRun: true,
  emptyCanvasPlusOrAddActionIsAddPath: true,
  emptyCanvasDoesNotSendOperatorsToActionsToPlace: true,
  emptyCanvasDoesNotPlaceTriggers: true,
  emptyVaultAddsViaMaskedWizard: true,
  vaultSelectorsStayDisplayNameAndUuid: true,
  noSampleSecrets: true,
  noStarterInvalidYamlAsPrimaryButtons: true,
  developerSamplesStayUnderSettings: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  draftsNeverLookLive: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  oneReplayPath: true,
  loudIndeterminate: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  noKekInBrowser: true,
  noMarketplace: true,
  noCanvasTriggerNodes: true,
  noAppsApiChanges: true,
  templatesRemainClientYamlThatPostDraft: true,
  uxl7ThroughUxl8OutOfScope: true,
  marketplaceOutOfScope: true,
  canvasTriggerNodesOutOfScope: true,
  promotingDeveloperFixturesOutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const EMPTY_STATES_SOURCES = [
  "src/lib/empty-states-teach-model.ts",
  "src/lib/workflow-templates.ts",
  "src/lib/editor-library.ts",
  "src/lib/editor-developer.ts",
  "src/lib/credential-vault.ts",
  "src/components/home/WorkflowHome.tsx",
  "src/components/workflows/WorkflowCanvas.tsx",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/settings/DeveloperSettings.tsx",
  "src/app/workflows/page.tsx",
  "src/app/credentials/page.tsx",
] as const;

export type HomeEmptyKind = "teach" | "filtered" | "populated";

export function workflowHomeFiltersAreActive(
  filters: WorkflowHomeFilters,
): boolean {
  return (
    filters.query.trim() !== "" ||
    filters.folder !== "" ||
    filters.tag !== "" ||
    filters.owner !== "" ||
    filters.trigger !== "" ||
    filters.environment !== "" ||
    filters.status !== "" ||
    filters.lastRun !== "" ||
    filters.lastModified !== "" ||
    filters.activation !== ""
  );
}

export function homeEmptyKind(input: {
  recordCount: number;
  visibleCount: number;
}): HomeEmptyKind {
  if (input.recordCount <= 0) {
    return "teach";
  }
  if (input.visibleCount <= 0) {
    return "filtered";
  }
  return "populated";
}

export function homeEmptyTeachesDraftCreateImportTemplate(source: string): boolean {
  return (
    source.includes('data-uxl6="home-empty"') &&
    source.includes("HOME_EMPTY_HEADING") &&
    source.includes("HOME_EMPTY_CREATE_LABEL") &&
    source.includes("HOME_EMPTY_IMPORT_LABEL") &&
    source.includes("HOME_EMPTY_TEMPLATE_LABEL") &&
    source.includes("createFromYaml") &&
    source.includes("importValidatedWorkflow") &&
    source.includes("createFromTemplate") &&
    source.includes("createWorkflow")
  );
}

export function homeEmptySaysDraftsDoNotRun(source: string): boolean {
  return (
    (source.includes("HOME_EMPTY_HELP") || source.includes(HOME_EMPTY_HELP)) &&
    /drafts do not run/i.test(HOME_EMPTY_HELP) &&
    /drafts do not run/i.test(HOME_EMPTY_TEMPLATE_HELP) &&
    (source.includes("HOME_EMPTY_TEMPLATE_HELP") ||
      source.includes(HOME_EMPTY_TEMPLATE_HELP))
  );
}

export function homeEmptyShowsDeveloperFixtures(source: string): boolean {
  return EMPTY_STATE_DEVELOPER_FIXTURE_TOKENS.some((token) =>
    source.includes(token),
  );
}

export function canvasEmptyAddPathIsPlusOrAddAction(source: string): boolean {
  return (
    source.includes('data-uxl6="canvas-empty"') &&
    source.includes("CANVAS_EMPTY_HELP") &&
    source.includes("+") &&
    source.includes(CANVAS_EMPTY_ADD_ACTION_LABEL) &&
    source.includes("onOpenLibrary") &&
    source.includes("onAddAction")
  );
}

export function canvasEmptySendsOperatorsToActionsToPlace(source: string): boolean {
  return (
    /href=["'`]\/actions/.test(source) ||
    /router\.(push|replace)\(["'`]\/actions/.test(source) ||
    /maybeEmbedDeepLink\(["'`]\/actions/.test(source)
  );
}

export function canvasEmptyPlacesTriggers(source: string): boolean {
  return (
    /onInsertType\(["'`]manual/.test(source) ||
    /onInsertType\(["'`]webhook/.test(source) ||
    /onInsertType\(["'`]schedule/.test(source) ||
    source.includes("placeTriggerOnCanvas")
  );
}

export function canvasAddPathExcludesTriggers(
  catalog: WorkflowCatalog | null | undefined,
): boolean {
  if (filterEnabledActionNodes(catalog?.nodes).some((item) => isTriggerActionType(item.type))) {
    return false;
  }
  const empty = canvasAddAffordance({
    invalid: false,
    nodeCount: 0,
  });
  return (
    empty.emptyPlus &&
    empty.addAction &&
    EDITOR_LIBRARY.plusOpensLibrary &&
    EDITOR_LIBRARY.addActionOpensWizard &&
    EDITOR_LIBRARY.triggersExcluded &&
    EDITOR_LIBRARY.actionsRouteIsCatalogReference
  );
}

export function vaultEmptyAddsViaMaskedWizard(source: string): boolean {
  return (
    source.includes('data-uxl6="vault-empty"') &&
    source.includes("VAULT_EMPTY_HEADING") &&
    source.includes("VAULT_EMPTY_HELP") &&
    source.includes("VAULT_EMPTY_ADD_LABEL") &&
    source.includes("/credentials/new")
  );
}

export function vaultEmptyShowsSampleSecrets(source: string): boolean {
  return EMPTY_STATE_SAMPLE_SECRET_TOKENS.some((token) => source.includes(token));
}

export function vaultSelectorsStayDisplayNameAndUuid(): boolean {
  return (
    CREDENTIAL_VAULT_IDENTITY_KEYS[0] === "displayName" &&
    CREDENTIAL_VAULT_IDENTITY_KEYS[1] === "id" &&
    CREDENTIAL_VAULT.displayNamePlusUuidOnly &&
    EMPTY_STATES_TEACH.vaultSelectorsStayDisplayNameAndUuid &&
    /display name \+ UUID/i.test(VAULT_EMPTY_HELP)
  );
}

export function developerSamplesStayUnderSettings(settingsSource: string): boolean {
  return (
    settingsSource.includes("Developer") &&
    settingsSource.includes(SETTINGS_DEVELOPER_HREF) &&
    (settingsSource.includes("Starter YAML") ||
      settingsSource.includes("Developer samples")) &&
    EDITOR_DEVELOPER.starterInvalidNotPrimaryButtons &&
    EDITOR_DEVELOPER.starterInvalidPlacement ===
      "yaml-disclosure-or-settings-developer" &&
    EDITOR_YAML_DEVELOPER_DISCLOSURE === "Developer samples"
  );
}

export function emptyStatesHoldHardLines(): boolean {
  return (
    EMPTY_STATES_TEACH.yamlIsSourceOfTruth &&
    EMPTY_STATES_TEACH.draftsNeverRun &&
    EMPTY_STATES_TEACH.draftsNeverLookLive &&
    EMPTY_STATES_TEACH.vaultDisplayNameUuidOnly &&
    EMPTY_STATES_TEACH.adv021ChromeFromSessionEmbedOnly &&
    EMPTY_STATES_TEACH.adv024MembershipIsolationStayGrantGated &&
    EMPTY_STATES_TEACH.oneReplayPath &&
    EMPTY_STATES_TEACH.loudIndeterminate &&
    EMPTY_STATES_TEACH.failClosedCatalogs &&
    EMPTY_STATES_TEACH.notAnN8nClone &&
    EMPTY_STATES_TEACH.noKekInBrowser &&
    EMPTY_STATES_TEACH.noMarketplace &&
    EMPTY_STATES_TEACH.noCanvasTriggerNodes &&
    EMPTY_STATES_TEACH.noAppsApiChanges &&
    EDITOR_CHROME.draftsCannotStart &&
    EDITOR_WORKING_MEMORY.draftsNeverRun &&
    HOME_ACTIVATION.draftsNeverLookLive &&
    CREDENTIAL_VAULT.displayNamePlusUuidOnly &&
    CREDENTIAL_VAULT.noKekInBrowser &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    ACTIONS_CATALOG_HREF === "/actions"
  );
}

export function emptyStatesInheritPriorStories(): boolean {
  return (
    EMPTY_STATES_TEACH.inheritUxl2Wording &&
    EMPTY_STATES_TEACH.inheritUxl5HomeScan &&
    EMPTY_STATES_TEACH.inheritEditorLibraryAddPath &&
    EMPTY_STATES_TEACH.inheritEditorDeveloperPlacement &&
    EMPTY_STATES_TEACH.inheritVaultDisplayNameUuid &&
    EMPTY_STATES_TEACH.d6MigrateInPlace &&
    EMPTY_STATES_TEACH.templatesRemainClientYamlThatPostDraft &&
    HOME_ROW_SCAN.noDeveloperFixturesOnHomeEmptyOrPopulated &&
    EDITOR_WORKING_MEMORY.editingADraftInWords &&
    PRODUCT_HOME.templatesPostDraftThenOpenEditor &&
    WORKFLOW_TEMPLATES.length >= 4 &&
    WORKFLOW_TEMPLATES.every((item) => item.definitionYaml.includes("flowforge/v1"))
  );
}
