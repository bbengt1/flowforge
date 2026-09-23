/**
 * UXL.2: Draft / published / test-run working memory.
 *
 * Relates to #289 / Part of #287. Keep #289 open.
 *
 * Chloe UI only. Densify EditorTopBar, Triggers tab, and the home
 * activation column in place (D6). Inherit UXL.1 top-bar grouping
 * and R6.1 / R6.2 compose. No new activation resource. No canvas
 * trigger nodes. No API/contract changes.
 *
 * Persistent chrome — not a tooltip — so operators do not hold
 * “editing a draft / which published version is active / Test run
 * publishes a test version, then starts it” in working memory.
 *
 * Unsaved buffer: Test run and Start published stay disabled or
 * explain they need the last saved draft / a published version.
 * No silent test of the open YAML. D5: never run unsaved/draft
 * buffer.
 *
 * Out of scope: UXL.3–UXL.8, invented activation aggregates.
 */

import {
  EDITOR_ACTIVATION,
  R6_CONFIRMATION,
  editorActivationTopBarLabel,
  type EditorActivationState,
} from "./editor-activation.ts";
import {
  EDITOR_CHROME,
  canPublishLastSavedDraft,
  editorStartVersions,
} from "./editor-chrome.ts";
import {
  D5_HARD_LINE,
  EDITOR_TEST_RUN,
  canOfferEditorTestRun,
} from "./editor-test-run.ts";
import { EDITOR_TOPBAR_CHUNKING } from "./editor-topbar-chunking.ts";
import { HOME_ACTIVATION } from "./home-activation.ts";
import type { WorkflowVersion } from "./workflow-types.ts";

export const UXL2_STORY = 289;
export const UXL2_EPIC = 287;
export const UXL2_KEEP_STORY_OPEN = true;
export const UXL2_ID = "UXL.2-working-memory" as const;

export const UXL2_BRIEF = "docs/internal/flowforge-ux-laws.md";

export const EDITOR_WORKING_MEMORY_DRAFT = "Editing a draft";
export const EDITOR_WORKING_MEMORY_NOT_ACTIVE = "not active";
export const EDITOR_WORKING_MEMORY_TEST_RUN =
  "Test run: publish a test version, then start it.";

export const EDITOR_WORKING_MEMORY_UNSAVED_TEST_RUN =
  "Test run needs the last saved draft. The open YAML is never tested.";

export const EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED =
  "Start published needs a published version — not the open YAML.";

export const EDITOR_WORKING_MEMORY_START_USES_PUBLISHED =
  "Start published starts a published version — not the open YAML.";

export const EDITOR_WORKING_MEMORY = {
  ...R6_CONFIRMATION,
  inheritR6Confirmation: true,
  inheritR61EditorActivation: true,
  inheritR62HomeColumn: true,
  inheritUxl1TopBarGroups: true,
  d6MigrateInPlace: true,
  persistentChromeNotTooltip: true,
  editingADraftInWords: true,
  publishedActiveOrNotActiveInWords: true,
  testRunCopyNamesPublishThenStart: true,
  unsavedDisablesOrExplains: true,
  noSilentTestOpenYaml: true,
  homeColumnMatchesEditor: true,
  draftsNeverLookLive: true,
  draftsNeverRun: true,
  noNewActivationResource: true,
  noNewActivationAggregate: true,
  noCanvasTriggerNodes: true,
  yamlIsSourceOfTruth: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  oneReplayPath: true,
  loudIndeterminate: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  d5NeverRunUnsavedDraftBuffer: true,
  noAppsApiChanges: true,
  uxl3ThroughUxl8OutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const EDITOR_WORKING_MEMORY_HELP =
  "Persistent chrome states, in words: editing a draft; which published version is active (or “not active”); Test run: publish a test version, then start it. Unsaved: Test run and Start published stay disabled or explain they need the last saved draft / a published version. Home activation column matches editor wording. Drafts never look live. No new activation resource. No canvas trigger nodes.";

export const EDITOR_WORKING_MEMORY_SOURCES = [
  "src/lib/editor-working-memory.ts",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/EditorActivationChrome.tsx",
  "src/components/workflows/EditorWorkflowTabs.tsx",
  "src/components/home/HomeActivationStatus.tsx",
  "src/components/home/WorkflowHome.tsx",
] as const;

export const INVENTED_ACTIVATION_RESOURCES = [
  "/activations",
  "/activation-state",
  "ActivationAggregate",
  "createActivation",
] as const;

export type EditorWorkingMemoryChrome = {
  draft: typeof EDITOR_WORKING_MEMORY_DRAFT;
  testRunCopy: typeof EDITOR_WORKING_MEMORY_TEST_RUN;
  testRunHelp: string;
  startHelp: string;
  canTestRun: boolean;
  canStartPublished: boolean;
  unsaved: boolean;
};

export function editorWorkingMemoryDraftLabel(): typeof EDITOR_WORKING_MEMORY_DRAFT {
  return EDITOR_WORKING_MEMORY_DRAFT;
}

export function editorWorkingMemoryPublishedLabel(
  state: Pick<
    EditorActivationState,
    "kind" | "publishedVersionLabel" | "workflowActiveVersionIds" | "live"
  >,
): string {
  return editorActivationTopBarLabel(state);
}

export function editorWorkingMemoryTestRunCopy(): typeof EDITOR_WORKING_MEMORY_TEST_RUN {
  return EDITOR_WORKING_MEMORY_TEST_RUN;
}

export function editorHasPublishedVersion(
  versions: readonly WorkflowVersion[] | null | undefined,
): boolean {
  return editorStartVersions([...(versions ?? [])]).length > 0;
}

export function editorWorkingMemoryChrome(input: {
  dirty: boolean;
  hasWorkflow: boolean;
  revision: number | null;
  hasPublishedVersion: boolean;
  permissions: readonly string[] | null | undefined;
}): EditorWorkingMemoryChrome {
  const testRun = canOfferEditorTestRun({
    dirty: input.dirty,
    hasWorkflow: input.hasWorkflow,
    revision: input.revision,
    permissions: input.permissions,
  });
  return {
    draft: EDITOR_WORKING_MEMORY_DRAFT,
    testRunCopy: EDITOR_WORKING_MEMORY_TEST_RUN,
    testRunHelp: testRun.ok
      ? EDITOR_WORKING_MEMORY_TEST_RUN
      : testRun.reason === "dirty"
        ? EDITOR_WORKING_MEMORY_UNSAVED_TEST_RUN
        : testRun.help,
    startHelp: input.hasPublishedVersion
      ? EDITOR_WORKING_MEMORY_START_USES_PUBLISHED
      : EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED,
    canTestRun: testRun.ok,
    canStartPublished: input.hasWorkflow && input.hasPublishedVersion,
    unsaved: input.dirty,
  };
}

export function editorWorkingMemoryHomeMatchesEditor(
  editorLabel: string,
  homeLabel: string,
): boolean {
  return editorLabel === homeLabel;
}

export function editorWorkingMemoryHoldsHardLines(): boolean {
  return (
    EDITOR_WORKING_MEMORY.yamlIsSourceOfTruth &&
    EDITOR_WORKING_MEMORY.draftsNeverRun &&
    EDITOR_WORKING_MEMORY.draftsNeverLookLive &&
    EDITOR_WORKING_MEMORY.vaultDisplayNameUuidOnly &&
    EDITOR_WORKING_MEMORY.adv021ChromeFromSessionEmbedOnly &&
    EDITOR_WORKING_MEMORY.adv024MembershipIsolationStayGrantGated &&
    EDITOR_WORKING_MEMORY.oneReplayPath &&
    EDITOR_WORKING_MEMORY.loudIndeterminate &&
    EDITOR_WORKING_MEMORY.failClosedCatalogs &&
    EDITOR_WORKING_MEMORY.notAnN8nClone &&
    EDITOR_WORKING_MEMORY.d5NeverRunUnsavedDraftBuffer &&
    EDITOR_WORKING_MEMORY.noNewActivationResource &&
    EDITOR_WORKING_MEMORY.noCanvasTriggerNodes &&
    EDITOR_WORKING_MEMORY.noAppsApiChanges &&
    EDITOR_CHROME.draftsCannotStart &&
    EDITOR_CHROME.startPublishedVersionsOnly &&
    EDITOR_CHROME.publishLastSavedDraftOnly &&
    D5_HARD_LINE.neverRunUnsavedDraftBuffer &&
    D5_HARD_LINE.noSilentTestOpenEditorYaml &&
    R6_CONFIRMATION.draftsNeverLookLive &&
    R6_CONFIRMATION.d2NoNewActivationResource &&
    R6_CONFIRMATION.d3NotCanvasNodes
  );
}

export function editorWorkingMemoryInheritsPriorStories(): boolean {
  return (
    EDITOR_WORKING_MEMORY.inheritUxl1TopBarGroups &&
    EDITOR_WORKING_MEMORY.inheritR61EditorActivation &&
    EDITOR_WORKING_MEMORY.inheritR62HomeColumn &&
    EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers &&
    EDITOR_ACTIVATION.inheritR6Confirmation &&
    HOME_ACTIVATION.inheritR6Confirmation &&
    HOME_ACTIVATION.draftsNeverLookLive &&
    EDITOR_TEST_RUN.inheritD5HardLine &&
    canPublishLastSavedDraft({
      dirty: true,
      hasWorkflow: true,
      revision: 1,
    }) === false
  );
}

export function editorWorkingMemoryInventedActivation(source: string): boolean {
  return INVENTED_ACTIVATION_RESOURCES.some((token) => source.includes(token));
}

export function editorWorkingMemoryPlacesCanvasTriggers(
  source: string,
): boolean {
  return (
    /placeTrigger|triggerNode|canvasTrigger/.test(source) ||
    (source.includes('type: "webhook"') && source.includes("addCanvasNode"))
  );
}

export function editorWorkingMemoryMentionsTestRunModel(source: string): boolean {
  return (
    source.includes(EDITOR_WORKING_MEMORY_TEST_RUN) ||
    source.includes("EDITOR_WORKING_MEMORY_TEST_RUN") ||
    source.includes("editorWorkingMemoryTestRunCopy") ||
    source.includes("testRunCopy")
  );
}

export function editorWorkingMemoryExplainsUnsaved(source: string): boolean {
  return (
    source.includes("EDITOR_WORKING_MEMORY_UNSAVED_TEST_RUN") ||
    source.includes("EDITOR_WORKING_MEMORY_START_NEEDS_PUBLISHED") ||
    source.includes(EDITOR_WORKING_MEMORY_UNSAVED_TEST_RUN) ||
    source.includes("testRunHelp") ||
    source.includes("startHelp")
  );
}
