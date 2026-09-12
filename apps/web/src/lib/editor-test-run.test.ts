import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_ACTIVATION,
  R6_CONFIRMATION,
  R6_LATER_STORY_NOTES,
} from "./editor-activation.ts";
import {
  EDITOR_TEST_RUN,
  EDITOR_TEST_RUN_REUSED,
  EDITOR_TEST_RUN_SOURCES,
  INVENTED_TEST_RUN_ROUTES,
  R63_EPIC,
  R63_KEEP_STORY_OPEN,
  R63_STORY,
  TEST_RUN_CONTROL_ID,
  TEST_RUN_FLAVOR_HELP,
  TEST_RUN_FORBIDDEN_HELP,
  TEST_RUN_HELP,
  TEST_RUN_LABEL,
  TEST_RUN_PUBLISH_KIND,
  TEST_RUN_PUBLISH_KIND_GAP,
  TEST_RUN_PUBLISH_NOTE,
  TEST_RUN_REVISION_HELP,
  TEST_RUN_SAVE_FIRST_HELP,
  canOfferEditorTestRun,
  canOfferHomeTestRun,
  editorTestRunCsrfOnMutations,
  editorTestRunDraftExecute,
  editorTestRunHoldsR6Confirmation,
  editorTestRunInventedRoute,
  editorTestRunPublishPath,
  editorTestRunStartPath,
  editorTestRunUsesExistingClients,
  testRunPublishBody,
  testRunStartUsesPublishedVersion,
} from "./editor-test-run.ts";
import { canPublishLastSavedDraft } from "./editor-chrome.ts";
import { HOME_ACTIVATION } from "./home-activation.ts";
import { productHomeCapabilities, workflowHomeRowActions } from "./product-home.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("R6.3 one-gesture test-run (D5)", () => {
  it("inherits the Gracie + jonny R6 confirmation and keeps #272 open", () => {
    assert.equal(R63_STORY, 272);
    assert.equal(R63_EPIC, 232);
    assert.equal(R63_KEEP_STORY_OPEN, true);
    assert.equal(editorTestRunHoldsR6Confirmation(), true);
    assert.equal(EDITOR_TEST_RUN.inheritR6Confirmation, true);
    assert.equal(R6_CONFIRMATION.d2ComposeEnablePlusVersionPin, true);
    assert.equal(R6_CONFIRMATION.d2NoNewActivationResource, true);
    assert.equal(R6_CONFIRMATION.d3TriggersStayWorkflowLevel, true);
    assert.equal(R6_CONFIRMATION.draftsNeverRun, true);
    assert.equal(R6_CONFIRMATION.draftsNeverLookLive, true);
    assert.equal(EDITOR_TEST_RUN.d5OneGestureMintsPublishedTestVersionThenStarts, true);
    assert.equal(EDITOR_TEST_RUN.d5PublishFlavorThenStart, true);
    assert.equal(EDITOR_TEST_RUN.d5NotRunDraftFlag, true);
    assert.equal(EDITOR_TEST_RUN.d5NotPinData, true);
    assert.equal(EDITOR_TEST_RUN.d5NotUnsavedBuffer, true);
    assert.equal(EDITOR_TEST_RUN.draftsNeverRun, true);
    assert.equal(EDITOR_TEST_RUN.noDraftExecute, true);
    assert.equal(EDITOR_TEST_RUN.reusePublishAndStartClients, true);
    assert.equal(EDITOR_TEST_RUN.noInventedResume, true);
    assert.equal(EDITOR_TEST_RUN.noInventedReplayRoute, true);
    assert.equal(EDITOR_TEST_RUN.noNewActivationResource, true);
    assert.equal(EDITOR_TEST_RUN.densifyInPlace, true);
    assert.equal(EDITOR_TEST_RUN.editorIsCommonPath, true);
    assert.equal(EDITOR_TEST_RUN.homeWhereNatural, true);
    assert.equal(EDITOR_TEST_RUN.lastSavedDraftOnly, true);
    assert.equal(EDITOR_TEST_RUN.startUsesMintedWorkflowVersionId, true);
    assert.equal(EDITOR_TEST_RUN.noAppsApiChanges, true);
    assert.equal(EDITOR_TEST_RUN.publishFlavorGapBlocking, false);
    assert.equal(EDITOR_TEST_RUN.doNotInventDraftRun, true);
    assert.equal(EDITOR_ACTIVATION.inheritR6Confirmation, true);
    assert.equal(HOME_ACTIVATION.inheritR6Confirmation, true);
    assert.match(R6_LATER_STORY_NOTES.r63, /#272/);
  });

  it("mints a published test version via existing publish note (D5 flavor)", () => {
    assert.equal(TEST_RUN_PUBLISH_NOTE, "test");
    assert.equal(TEST_RUN_PUBLISH_KIND, "test");
    assert.deepEqual(testRunPublishBody(3), {
      revision: 3,
      note: "test",
      kind: "test",
    });
    assert.equal(EDITOR_TEST_RUN.publishKindFieldOnApi, false);
    assert.equal(EDITOR_TEST_RUN.publishKindIsAdditiveIgnored, true);
    assert.equal(EDITOR_TEST_RUN.equivalentIsPublishNote, true);
    assert.equal(EDITOR_TEST_RUN.retentionUnchanged, true);
    assert.match(TEST_RUN_FLAVOR_HELP, /test note/);
    assert.match(TEST_RUN_PUBLISH_KIND_GAP, /not a blocking gap/);
    assert.match(TEST_RUN_PUBLISH_KIND_GAP, /do not invent draft-run/i);
    assert.equal(
      editorTestRunPublishPath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/publish`,
    );
    assert.equal(
      editorTestRunStartPath(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}/executions`,
    );
  });

  it("refuses dirty drafts, missing revision, and missing publish/execute", () => {
    const allowed = ["workflow.publish", "workflow.execute"];
    const ready = canOfferEditorTestRun({
      dirty: false,
      hasWorkflow: true,
      revision: 2,
      permissions: allowed,
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.reason, null);
    assert.equal(ready.help, TEST_RUN_HELP);
    assert.equal(
      canPublishLastSavedDraft({
        dirty: false,
        hasWorkflow: true,
        revision: 2,
      }),
      true,
    );

    const dirty = canOfferEditorTestRun({
      dirty: true,
      hasWorkflow: true,
      revision: 2,
      permissions: allowed,
    });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.reason, "dirty");
    assert.equal(dirty.help, TEST_RUN_SAVE_FIRST_HELP);

    const missingRev = canOfferEditorTestRun({
      dirty: false,
      hasWorkflow: true,
      revision: null,
      permissions: allowed,
    });
    assert.equal(missingRev.ok, false);
    assert.equal(missingRev.reason, "no-revision");
    assert.equal(missingRev.help, TEST_RUN_REVISION_HELP);

    const publishOnly = canOfferEditorTestRun({
      dirty: false,
      hasWorkflow: true,
      revision: 2,
      permissions: ["workflow.publish"],
    });
    assert.equal(publishOnly.ok, false);
    assert.equal(publishOnly.reason, "forbidden");
    assert.equal(publishOnly.help, TEST_RUN_FORBIDDEN_HELP);

    const executeOnly = canOfferEditorTestRun({
      dirty: false,
      hasWorkflow: true,
      revision: 2,
      permissions: ["workflow.execute"],
    });
    assert.equal(executeOnly.ok, false);
    assert.equal(executeOnly.canPublish, false);
    assert.equal(executeOnly.canExecute, true);

    const homeReady = canOfferHomeTestRun({
      draftRevision: 4,
      permissions: allowed,
    });
    assert.equal(homeReady.ok, true);
    const homeDraft = canOfferHomeTestRun({
      draftRevision: 1,
      permissions: allowed,
    });
    assert.equal(homeDraft.ok, true);
  });

  it("starts only the minted published workflowVersionId — never a draft", () => {
    assert.equal(testRunStartUsesPublishedVersion(VERSION_ID), true);
    assert.equal(testRunStartUsesPublishedVersion("draft"), false);
    assert.equal(testRunStartUsesPublishedVersion("draft:1"), false);
    assert.equal(testRunStartUsesPublishedVersion(""), false);
    assert.equal(testRunStartUsesPublishedVersion(null), false);
    assert.equal(EDITOR_TEST_RUN.noDraftExecute, true);
    assert.match(TEST_RUN_HELP, /Drafts never run/);
  });

  it("reuses existing publish + start clients and requires CSRF", () => {
    assert.equal(editorTestRunUsesExistingClients(), true);
    assert.equal(editorTestRunCsrfOnMutations(), true);
    assert.equal(EDITOR_TEST_RUN.csrfOnPublishAndStart, true);
    assert.deepEqual([...EDITOR_TEST_RUN_REUSED], [
      "publishWorkflow",
      "startWorkflowExecution",
    ]);

    const client = source("src/lib/editor-test-run-client.ts");
    for (const name of EDITOR_TEST_RUN_REUSED) {
      assert.match(client, new RegExp(name));
    }
    assert.equal(editorTestRunInventedRoute(client), false);
    assert.equal(editorTestRunDraftExecute(client), false);
    assert.doesNotMatch(client, /"draft"\s*:\s*true/);
    for (const route of INVENTED_TEST_RUN_ROUTES) {
      assert.equal(client.includes(route), false);
    }
    assert.match(client, /testRunPublishBody/);
    assert.match(client, /startWorkflowExecution/);
  });

  it("densifies editor top bar and home row without teaching start drawers as the test-run path", () => {
    assert.equal(TEST_RUN_CONTROL_ID, "test-run");
    assert.equal(TEST_RUN_LABEL, "Test run");
    assert.match(TEST_RUN_HELP, /published/);

    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.match(topBar, /test-run/);
    assert.match(topBar, /onTestRun/);
    assert.equal(editorTestRunInventedRoute(topBar), false);
    assert.equal(editorTestRunDraftExecute(topBar), false);

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    assert.match(operator, /runPublishedTestVersion/);
    assert.match(operator, /onTestRun/);
    assert.equal(operator.includes("/replay"), false);
    assert.equal(editorTestRunInventedRoute(operator), false);

    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /Test run/);
    assert.match(home, /onTestRun|runPublishedTestVersion/);
    assert.equal(home.includes("?test-run="), false);
    assert.equal(EDITOR_TEST_RUN.doNotTeachStartDrawerAsTestRun, true);
    assert.equal(EDITOR_TEST_RUN.homeDrawersStillWork, true);

    const caps = productHomeCapabilities([
      "workflow.view",
      "workflow.publish",
      "workflow.execute",
    ]);
    const draftRow = workflowHomeRowActions({
      published: false,
      workflowId: WORKFLOW_ID,
      capabilities: caps,
    });
    assert.equal(draftRow.startPublished, false);
    assert.equal(draftRow.testRun, true);

    const locked = workflowHomeRowActions({
      published: false,
      workflowId: WORKFLOW_ID,
      capabilities: productHomeCapabilities(["workflow.view"]),
    });
    assert.equal(locked.testRun, false);

    assert.deepEqual([...EDITOR_TEST_RUN_SOURCES], [
      "src/lib/editor-test-run.ts",
      "src/lib/editor-test-run-client.ts",
      "src/components/workflows/EditorTopBar.tsx",
      "src/components/workflows/WorkflowOperator.tsx",
      "src/components/home/WorkflowHome.tsx",
    ]);
    for (const path of EDITOR_TEST_RUN_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
