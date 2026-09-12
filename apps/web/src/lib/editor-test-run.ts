/**
 * R6.3: One-gesture test-run (D5) from editor/home.
 *
 * Relates to #272 / Part of #232. Keep #272 open.
 * Follow-up #284 (Terry QA): unchanged digest / 409 already-published
 * starts the existing published version. Keep #284 open.
 *
 * Chloe UI only. Inherit the Gracie + jonny R6 confirmation from
 * R6.1 (`editor-activation.ts`). Do not weaken.
 *
 * D5 locked: one-gesture test-run = mint a **published test version**
 * then start it. When the saved draft digest already equals the
 * latest published digest, start that existing published version
 * instead of forcing a publish that 409s. Drafts still never run.
 * Reuse existing `publishWorkflow` + `startWorkflowExecution` plus
 * GET workflow/version clients to resolve the published id. No
 * invented resume/`/replay` or idempotent test-run endpoint. No
 * draft execute. Densify in place (D6).
 *
 * Gracie D5 hard line (bake here): one gesture may mint a published
 * test version then start it — never run the unsaved/draft buffer.
 * No draft execute path. No silent “test the open editor YAML.”
 *
 * jonny: `POST /workflows/{id}/publish` has no `kind: test` field.
 * That is not a blocking gap — the locked equivalent is the existing
 * publish `note` (test note). `kind: "test"` is sent as additive and
 * is ignored by today's decoder. Retention is unchanged. Do not
 * invent draft-run. Do not ping jonny for an idempotent test-run
 * endpoint — UI composes existing clients first.
 */

import { R6_CONFIRMATION } from "./editor-activation.ts";
import { canPublishLastSavedDraft } from "./editor-chrome.ts";
import { isDraftRunSelection } from "./execution-replay.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { csrfRequiredFor } from "./session-contract.ts";
import {
  workflowExecutionsPath,
  workflowPublishPath,
} from "./workflow-client.ts";
import type { PublishWorkflowBody } from "./workflow-types.ts";
import {
  canExecuteWorkflows,
  canPublishWorkflows,
} from "./workspace-nav.ts";

export const R63_STORY = 272;
export const R63_EPIC = 232;
export const R63_KEEP_STORY_OPEN = true;
export const TEST_RUN_FOLLOWUP_ISSUE = 284;
export const TEST_RUN_KEEP_FOLLOWUP_OPEN = true;

export const TEST_RUN_PUBLISH_NOTE = "test";
export const TEST_RUN_PUBLISH_KIND = "test" as const;
export const TEST_RUN_CONTROL_ID = "test-run";
export const TEST_RUN_LABEL = "Test run";

/**
 * Gracie D5 hard line — bake into R6.3 / #272.
 * Inherit R6_CONFIRMATION (D2/D3/drafts-never-live). Do not weaken.
 */
export const D5_HARD_LINE = {
  oneGestureMintsPublishedTestVersionThenStarts: true,
  neverRunUnsavedDraftBuffer: true,
  noDraftExecutePath: true,
  noSilentTestOpenEditorYaml: true,
} as const;

export const D5_HARD_LINE_HELP =
  "One gesture may mint a published test version then start it — never run the unsaved/draft buffer. No draft execute path. No silent test of the open editor YAML.";

export const TEST_RUN_HELP =
  "Test run publishes a test version from the last saved draft, then starts that published version. If the saved digest is already published, start that existing published version. Never the unsaved/draft buffer. No silent test of the open editor YAML. Drafts never run.";

export const TEST_RUN_ALREADY_PUBLISHED_HELP =
  "This normalized definition is already published. Start the existing published version — drafts never run.";

export const TEST_RUN_ALREADY_PUBLISHED_UNRESOLVED_HELP =
  "This definition is already published, but no published workflowVersionId could be resolved. Drafts never run.";

export const TEST_RUN_SAVE_FIRST_HELP =
  "Save the draft before a test run. Publish uses the last saved draft — never the unsaved buffer or open editor YAML. Drafts never run.";

export const TEST_RUN_OPEN_EDITOR_YAML_HELP =
  "Test run never executes the open editor YAML. Save the draft, then mint a published test version. No silent test of the unsaved buffer.";

export const TEST_RUN_FORBIDDEN_HELP =
  "Test run requires workflow.publish and workflow.execute. Drafts never run.";

export const TEST_RUN_REVISION_HELP =
  "Test run needs a saved draft revision so it can mint a published test version. The open editor YAML is never started. Drafts never run.";

export const TEST_RUN_OPEN_EDITOR_YAML_KEYS = [
  "yaml",
  "definitionYaml",
  "draftYaml",
  "unsavedYaml",
  "bufferYaml",
] as const;

export const TEST_RUN_FLAVOR_HELP =
  "D5 publish flavor is a test note on POST /workflows/{id}/publish (additive kind: test is sent and ignored today). The minted version is still immutable and digest-pinned. Retention is unchanged. Start is POST /workflows/{id}/executions with that workflowVersionId.";

export const TEST_RUN_PUBLISH_KIND_GAP =
  "POST /workflows/{id}/publish has no kind field. That is not a blocking gap — the locked equivalent is the existing note (test). kind: test is additive and ignored by today's decoder. Retention is unchanged. Do not invent draft-run.";

/**
 * Inherit R6.1 confirmation. Do not weaken. D5 is this story.
 */
export const EDITOR_TEST_RUN = {
  ...R6_CONFIRMATION,
  ...D5_HARD_LINE,
  inheritR6Confirmation: true,
  inheritD5HardLine: true,
  d5OneGestureMintsPublishedTestVersionThenStarts: true,
  d5PublishFlavorThenStart: true,
  d5NotRunDraftFlag: true,
  d5NotPinData: true,
  d5NotUnsavedBuffer: true,
  d5NeverRunUnsavedDraftBuffer: true,
  d5NoDraftExecutePath: true,
  d5NoSilentTestOpenEditorYaml: true,
  draftsNeverRun: true,
  draftsNeverLookLive: true,
  noDraftExecute: true,
  noDraftExecutePath: true,
  reusePublishAndStartClients: true,
  noInventedResume: true,
  noInventedReplayRoute: true,
  noNewActivationResource: true,
  noNewActivationAggregate: true,
  triggersStayWorkflowLevel: true,
  densifyInPlace: true,
  editorIsCommonPath: true,
  homeWhereNatural: true,
  homeDrawersStillWork: true,
  doNotTeachStartDrawerAsTestRun: true,
  lastSavedDraftOnly: true,
  startUsesMintedWorkflowVersionId: true,
  preferDetectUnchangedDigestBeforePublish: true,
  unchangedDigestStartsExistingPublished: true,
  alreadyPublished409StartsLatestPublished: true,
  doNotInventIdempotentTestRunEndpoint: true,
  publishKindFieldOnApi: false,
  publishKindIsAdditiveIgnored: true,
  equivalentIsPublishNote: true,
  retentionUnchanged: true,
  noAppsApiChanges: true,
  csrfOnPublishAndStart: true,
  jonnyStandbyOnlyIfPublishFlavorGap: true,
  publishFlavorGapBlocking: false,
  doNotInventDraftRun: true,
} as const;

export const EDITOR_TEST_RUN_SOURCES = [
  "src/lib/editor-test-run.ts",
  "src/lib/editor-test-run-client.ts",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
  "src/components/home/WorkflowHome.tsx",
] as const;

export const EDITOR_TEST_RUN_REUSED = [
  "publishWorkflow",
  "startWorkflowExecution",
  "getWorkflow",
  "getWorkflowVersion",
  "listWorkflowVersions",
] as const;

export const INVENTED_TEST_RUN_ROUTES = [
  "/replay",
  "/test-run",
  "/draft-execute",
  "/workflows/{id}/test-run",
  "/workflows/{workflowId}/test-run",
  "/workflows/{id}/replay",
  "/activations",
] as const;

export type TestRunRefusalReason =
  | "dirty"
  | "no-revision"
  | "forbidden"
  | "no-workflow";

export type TestRunGate = {
  ok: boolean;
  canPublish: boolean;
  canExecute: boolean;
  lastSaved: boolean;
  reason: TestRunRefusalReason | null;
  help: string;
};

export function canOfferEditorTestRun(input: {
  dirty: boolean;
  hasWorkflow: boolean;
  revision: number | null;
  permissions: readonly string[] | null | undefined;
}): TestRunGate {
  const canPublish = canPublishWorkflows(input.permissions);
  const canExecute = canExecuteWorkflows(input.permissions);
  const lastSaved = canPublishLastSavedDraft({
    dirty: input.dirty,
    hasWorkflow: input.hasWorkflow,
    revision: input.revision,
  });
  if (!input.hasWorkflow) {
    return {
      ok: false,
      canPublish,
      canExecute,
      lastSaved,
      reason: "no-workflow",
      help: TEST_RUN_REVISION_HELP,
    };
  }
  if (!canPublish || !canExecute) {
    return {
      ok: false,
      canPublish,
      canExecute,
      lastSaved,
      reason: "forbidden",
      help: TEST_RUN_FORBIDDEN_HELP,
    };
  }
  if (input.revision === null) {
    return {
      ok: false,
      canPublish,
      canExecute,
      lastSaved,
      reason: "no-revision",
      help: TEST_RUN_REVISION_HELP,
    };
  }
  if (input.dirty || !lastSaved) {
    return {
      ok: false,
      canPublish,
      canExecute,
      lastSaved: false,
      reason: "dirty",
      help: TEST_RUN_SAVE_FIRST_HELP,
    };
  }
  return {
    ok: true,
    canPublish,
    canExecute,
    lastSaved: true,
    reason: null,
    help: TEST_RUN_HELP,
  };
}

export function canOfferHomeTestRun(input: {
  draftRevision: number | null | undefined;
  permissions: readonly string[] | null | undefined;
}): TestRunGate {
  return canOfferEditorTestRun({
    dirty: false,
    hasWorkflow: (input.draftRevision ?? null) !== null,
    revision:
      typeof input.draftRevision === "number" ? input.draftRevision : null,
    permissions: input.permissions,
  });
}

export function testRunPublishBody(revision: number): PublishWorkflowBody {
  return {
    revision,
    note: TEST_RUN_PUBLISH_NOTE,
    kind: TEST_RUN_PUBLISH_KIND,
  };
}

export function testRunStartUsesPublishedVersion(
  workflowVersionId: string | null | undefined,
): boolean {
  return (
    isResourceId(workflowVersionId ?? undefined) &&
    !isDraftRunSelection(workflowVersionId)
  );
}

export function testRunDigestUnchanged(
  draftDigest: string | null | undefined,
  latestVersionDigest: string | null | undefined,
): boolean {
  const draft = draftDigest?.trim() ?? "";
  const published = latestVersionDigest?.trim() ?? "";
  return draft.length > 0 && draft === published;
}

export function testRunCanReusePublishedVersion(input: {
  draftDigest?: string | null;
  latestVersionDigest?: string | null;
  latestVersionId?: string | null;
}): boolean {
  return (
    testRunDigestUnchanged(input.draftDigest, input.latestVersionDigest) &&
    testRunStartUsesPublishedVersion(input.latestVersionId)
  );
}

export function isAlreadyPublishedTestRunConflict(problem: {
  status?: number;
  code?: string | null;
  detail?: string | null;
  title?: string | null;
}): boolean {
  const status = problem.status ?? 0;
  const code = (problem.code ?? "").toLowerCase();
  if (status !== 409 && code !== "conflict") {
    return false;
  }
  const haystack = `${problem.detail ?? ""} ${problem.title ?? ""}`.toLowerCase();
  return haystack.includes("already published");
}

export function latestPublishedTestVersion<
  T extends { id: string; versionNumber: number },
>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (!testRunStartUsesPublishedVersion(item.id)) {
      continue;
    }
    if (!best || item.versionNumber > best.versionNumber) {
      best = item;
    }
  }
  return best;
}

export function editorTestRunHoldsR6Confirmation(): boolean {
  return (
    EDITOR_TEST_RUN.inheritR6Confirmation &&
    EDITOR_TEST_RUN.d2ActiveIsEnableOnPublishedVersion &&
    EDITOR_TEST_RUN.d2ComposeEnablePlusVersionPin &&
    EDITOR_TEST_RUN.d2NoNewActivationResource &&
    EDITOR_TEST_RUN.d2NoNewActivationAggregate &&
    EDITOR_TEST_RUN.d3TriggersStayWorkflowLevel &&
    EDITOR_TEST_RUN.d3NotCanvasNodes &&
    EDITOR_TEST_RUN.draftsNeverRun &&
    EDITOR_TEST_RUN.draftsNeverLookLive &&
    EDITOR_TEST_RUN.doNotInventActivationResource &&
    EDITOR_TEST_RUN.d5OneGestureMintsPublishedTestVersionThenStarts &&
    EDITOR_TEST_RUN.noDraftExecute &&
    EDITOR_TEST_RUN.reusePublishAndStartClients &&
    EDITOR_TEST_RUN.noInventedResume &&
    EDITOR_TEST_RUN.publishFlavorGapBlocking === false
  );
}

export function editorTestRunHoldsD5HardLine(): boolean {
  return (
    editorTestRunHoldsR6Confirmation() &&
    EDITOR_TEST_RUN.inheritD5HardLine &&
    D5_HARD_LINE.oneGestureMintsPublishedTestVersionThenStarts &&
    D5_HARD_LINE.neverRunUnsavedDraftBuffer &&
    D5_HARD_LINE.noDraftExecutePath &&
    D5_HARD_LINE.noSilentTestOpenEditorYaml &&
    EDITOR_TEST_RUN.d5NeverRunUnsavedDraftBuffer &&
    EDITOR_TEST_RUN.d5NoDraftExecutePath &&
    EDITOR_TEST_RUN.d5NoSilentTestOpenEditorYaml &&
    EDITOR_TEST_RUN.d5NotUnsavedBuffer &&
    EDITOR_TEST_RUN.noDraftExecutePath &&
    EDITOR_TEST_RUN.lastSavedDraftOnly &&
    EDITOR_TEST_RUN.startUsesMintedWorkflowVersionId &&
    EDITOR_TEST_RUN.preferDetectUnchangedDigestBeforePublish &&
    EDITOR_TEST_RUN.unchangedDigestStartsExistingPublished &&
    EDITOR_TEST_RUN.alreadyPublished409StartsLatestPublished &&
    EDITOR_TEST_RUN.doNotInventIdempotentTestRunEndpoint
  );
}

export function testRunInputUsesOpenEditorYaml(input: object): boolean {
  return TEST_RUN_OPEN_EDITOR_YAML_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(input, key),
  );
}

export function editorTestRunUsesExistingClients(): boolean {
  return (
    EDITOR_TEST_RUN.reusePublishAndStartClients &&
    EDITOR_TEST_RUN_REUSED.includes("publishWorkflow") &&
    EDITOR_TEST_RUN_REUSED.includes("startWorkflowExecution")
  );
}

export function editorTestRunCsrfOnMutations(): boolean {
  return (
    csrfRequiredFor("POST", "/workflows/{workflowId}/publish") &&
    csrfRequiredFor("POST", "/workflows/{workflowId}/executions")
  );
}

export function editorTestRunInventedRoute(source: string): boolean {
  return INVENTED_TEST_RUN_ROUTES.some((route) => {
    return source.includes(`"${route}"`) || source.includes(`\`${route}\``);
  });
}

export function editorTestRunDraftExecute(source: string): boolean {
  return (
    /draft:\s*true/.test(source) ||
    source.includes("workflowDraftId") ||
    /\bexecuteDraft\b/.test(source) ||
    /\brunDraft\b/.test(source) ||
    /\brunUnsaved\b/.test(source) ||
    /\bdraftExecute\s*[(:]/.test(source)
  );
}

export function editorTestRunSilentOpenEditorYaml(source: string): boolean {
  const calls = source.match(/runPublishedTestVersion\s*\(([\s\S]*?)\)\s*;/g) ?? [];
  return calls.some((call) => {
    return TEST_RUN_OPEN_EDITOR_YAML_KEYS.some((key) =>
      new RegExp(`\\b${key}\\s*:`).test(call),
    );
  });
}

export function editorTestRunStartSendsYaml(source: string): boolean {
  const calls = source.match(/startWorkflowExecution\s*\(([\s\S]*?)\)\s*;/g) ?? [];
  return calls.some((call) => {
    return (
      /\bdefinitionYaml\s*:/.test(call) ||
      /\byaml\s*:/.test(call) ||
      /\bdraftYaml\s*:/.test(call)
    );
  });
}

export function editorTestRunPublishPath(workflowId: string): string {
  return workflowPublishPath(workflowId);
}

export function editorTestRunStartPath(workflowId: string): string {
  return workflowExecutionsPath(workflowId);
}
