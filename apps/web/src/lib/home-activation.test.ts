import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_ACTIVATION,
  R6_CONFIRMATION,
  R6_LATER_STORY_NOTES,
  composeWorkflowActivation,
} from "./editor-activation.ts";
import {
  HOME_ACTIVATION,
  HOME_ACTIVATION_COLUMN_ID,
  HOME_ACTIVATION_COMMON_PATH_HELP,
  HOME_ACTIVATION_COMPOSE,
  HOME_ACTIVATION_DRAFT_LABEL,
  HOME_ACTIVATION_HELP,
  HOME_ACTIVATION_LIST_PROJECTION_NOTE,
  HOME_ACTIVATION_SOURCES,
  HOME_ACTIVATION_UNKNOWN_LABEL,
  R62_EPIC,
  R62_KEEP_STORY_OPEN,
  R62_STORY,
  WORKFLOW_HOME_LIST_COLUMNS,
  composeHomeActivation,
  homeActivationColumnIsFirstClass,
  homeActivationCommonPathUsesHomeDrawers,
  homeActivationEmbedUnchanged,
  homeActivationFromEditorState,
  homeActivationFromListHint,
  homeActivationHoldsR6Confirmation,
  homeActivationHref,
  homeActivationInventedRoute,
  homeActivationLeavesLaterStories,
  homeActivationLooksLive,
  homeActivationNeedsTriggerJoin,
  matchesHomeActivationFilter,
} from "./home-activation.ts";
import { productHomeCapabilities, workflowHomeRowActions } from "./product-home.ts";
import type { ScheduleTriggerRecord } from "./schedule-trigger-contract.ts";
import type { WebhookTriggerRecord } from "./webhook-trigger-contract.ts";
import { EMPTY_WORKFLOW_HOME_FILTERS, buildWorkflowHomeItems, filterWorkflowHomeItems } from "./workflow-home.ts";
import type { WorkflowRecord, WorkflowVersion } from "./workflow-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_A = "22222222-2222-4222-8222-222222222222";
const VERSION_B = "33333333-3333-4333-8333-333333333333";
const WEBHOOK_ID = "44444444-4444-4444-8444-444444444444";
const SCHEDULE_ID = "55555555-5555-4555-8555-555555555555";

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

function webhook(
  overrides: Partial<WebhookTriggerRecord> = {},
): WebhookTriggerRecord {
  return {
    id: WEBHOOK_ID,
    publicId: "wh_" + "ab".repeat(32),
    ingressPath: "/api/v1/hooks/wh_ab",
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_A,
    type: "webhook",
    status: "enabled",
    secretCredentialId: "66666666-6666-4666-8666-666666666666",
    contentType: "application/json",
    maxBodyBytes: 65536,
    clockSkewSeconds: 300,
    replayRetentionSeconds: 600,
    rateLimitPerMinute: 60,
    workspaceRatePerMinute: 60,
    maxConcurrency: 5,
    workspaceMaxConcurrency: 5,
    fieldMapping: {},
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
    ...overrides,
  };
}

function schedule(
  overrides: Partial<ScheduleTriggerRecord> = {},
): ScheduleTriggerRecord {
  return {
    id: SCHEDULE_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_A,
    type: "schedule",
    status: "disabled",
    timezone: "UTC",
    cron: "0 0 * * *",
    interval: "",
    overlapPolicy: "skip",
    misfirePolicy: "ignore",
    catchUp: 0,
    ...overrides,
  };
}

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: WORKFLOW_ID,
    slug: "ops-deploy",
    name: "Deploy app",
    status: "published",
    draftRevision: 3,
    draftDigest: "sha256:aaaa",
    latestVersionNumber: 2,
    latestVersionId: VERSION_A,
    createdBy: "chloe",
    updatedBy: "chloe",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("R6.2 home activation column", () => {
  it("inherits the Gracie + jonny R6 confirmation and keeps #271 open", () => {
    assert.equal(R62_STORY, 271);
    assert.equal(R62_EPIC, 232);
    assert.equal(R62_KEEP_STORY_OPEN, true);
    assert.equal(homeActivationHoldsR6Confirmation(), true);
    assert.equal(HOME_ACTIVATION.inheritR6Confirmation, true);
    assert.equal(R6_CONFIRMATION.d2ComposeEnablePlusVersionPin, true);
    assert.equal(R6_CONFIRMATION.d2NoNewActivationResource, true);
    assert.equal(R6_CONFIRMATION.d3TriggersStayWorkflowLevel, true);
    assert.equal(R6_CONFIRMATION.draftsNeverLookLive, true);
    assert.equal(HOME_ACTIVATION.composeEnablePlusVersionPin, true);
    assert.equal(HOME_ACTIVATION.noNewActivationResource, true);
    assert.equal(HOME_ACTIVATION.noNewActivationAggregate, true);
    assert.equal(HOME_ACTIVATION.triggersStayWorkflowLevel, true);
    assert.equal(HOME_ACTIVATION.draftsNeverRun, true);
    assert.equal(HOME_ACTIVATION.draftsNeverLookLive, true);
    assert.equal(HOME_ACTIVATION.densifyHomeListInPlace, true);
    assert.equal(HOME_ACTIVATION.firstClassColumn, true);
    assert.equal(HOME_ACTIVATION.doNotTeachThreeDrawers, true);
    assert.equal(HOME_ACTIVATION.homeDrawersStillWork, true);
    assert.equal(HOME_ACTIVATION.rowActionsStayRoleGated, true);
    assert.equal(HOME_ACTIVATION.advRbacEmbedUnchanged, true);
    assert.equal(HOME_ACTIVATION.readModelGap, false);
    assert.equal(HOME_ACTIVATION.listProjectionHasComputedActivation, false);
    assert.equal(HOME_ACTIVATION.jonnyStandbyOnlyIfReadModelGap, true);
    assert.equal(HOME_ACTIVATION.doNotInventActivationResource, true);
    assert.equal(homeActivationLeavesLaterStories(), true);
    assert.match(R6_LATER_STORY_NOTES.r62, /#271/);
    assert.match(R6_LATER_STORY_NOTES.r63, /#272/);
    assert.equal(EDITOR_ACTIVATION.homeActivationColumnOutOfScope, true);
    assert.match(HOME_ACTIVATION_LIST_PROJECTION_NOTE, /not a real list-projection gap/i);
    assert.match(HOME_ACTIVATION_LIST_PROJECTION_NOTE, /do not invent/i);
  });

  it("composes D2 published-only activation and never lets drafts look live", () => {
    const draft = composeHomeActivation({
      workflowId: WORKFLOW_ID,
      latestVersionNumber: 0,
    });
    assert.equal(draft.kind, "no-published");
    assert.equal(draft.live, false);
    assert.equal(draft.draftLooksLive, false);
    assert.equal(homeActivationLooksLive(draft), false);
    assert.equal(draft.label, HOME_ACTIVATION_DRAFT_LABEL);
    assert.equal(homeActivationNeedsTriggerJoin({ latestVersionNumber: 0 }), false);

    const unpublishedHint = homeActivationFromListHint({
      id: WORKFLOW_ID,
      latestVersionNumber: 0,
    });
    assert.equal(unpublishedHint.label, HOME_ACTIVATION_DRAFT_LABEL);
    assert.equal(homeActivationLooksLive(unpublishedHint), false);

    const enabledOnDraftPin = composeHomeActivation({
      workflowId: WORKFLOW_ID,
      versions: [version("draft", 0)],
      webhooks: [webhook({ workflowVersionId: "draft", status: "enabled" })],
    });
    assert.equal(homeActivationLooksLive(enabledOnDraftPin), false);
    assert.equal(enabledOnDraftPin.draftLooksLive, false);

    const active = composeHomeActivation({
      workflowId: WORKFLOW_ID,
      versions: [version(VERSION_A, 3)],
      webhooks: [webhook({ status: "enabled" })],
      schedules: [schedule({ status: "disabled" })],
    });
    assert.equal(active.kind, "active");
    assert.equal(homeActivationLooksLive(active), true);
    assert.equal(active.draftLooksLive, false);
    assert.match(active.label, /Active/);
    assert.match(active.label, /published v3/);
    assert.match(HOME_ACTIVATION_COMPOSE, /published version/);

    const inactive = composeHomeActivation({
      workflowId: WORKFLOW_ID,
      versions: [version(VERSION_A, 2)],
      schedules: [schedule({ status: "disabled" })],
    });
    assert.equal(inactive.kind, "inactive");
    assert.equal(homeActivationLooksLive(inactive), false);
    assert.equal(inactive.label, "Not active");

    const unknown = composeHomeActivation({
      workflowId: WORKFLOW_ID,
      latestVersionNumber: 4,
      known: false,
    });
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.label, HOME_ACTIVATION_UNKNOWN_LABEL);
    assert.equal(homeActivationLooksLive(unknown), false);

    const failedPublished = homeActivationFromEditorState(
      WORKFLOW_ID,
      composeWorkflowActivation({ versions: [] }),
      false,
      { latestVersionNumber: 2 },
    );
    assert.equal(failedPublished.kind, "unknown");
    assert.equal(homeActivationLooksLive(failedPublished), false);
  });

  it("filters the home list by composed activation without inventing live drafts", () => {
    const draftItem = buildWorkflowHomeItems([
      record({
        id: "66666666-6666-4666-8666-666666666666",
        slug: "draft-only",
        name: "Draft only",
        status: "draft",
        latestVersionNumber: 0,
        latestVersionId: undefined,
      }),
    ])[0];
    const activeItem = buildWorkflowHomeItems([record()], {
      activations: new Map([
        [
          WORKFLOW_ID,
          composeHomeActivation({
            workflowId: WORKFLOW_ID,
            versions: [version(VERSION_A, 2), version(VERSION_B, 3)],
            webhooks: [webhook({ status: "enabled" })],
          }),
        ],
      ]),
    })[0];
    assert.equal(draftItem?.activation.label, HOME_ACTIVATION_DRAFT_LABEL);
    assert.equal(homeActivationLooksLive(draftItem!.activation), false);
    assert.equal(homeActivationLooksLive(activeItem!.activation), true);

    const activeOnly = filterWorkflowHomeItems(
      [draftItem!, activeItem!],
      { ...EMPTY_WORKFLOW_HOME_FILTERS, activation: "active" },
    );
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0]?.id, WORKFLOW_ID);

    const draftOnly = filterWorkflowHomeItems(
      [draftItem!, activeItem!],
      { ...EMPTY_WORKFLOW_HOME_FILTERS, activation: "draft" },
    );
    assert.equal(draftOnly.length, 1);
    assert.equal(draftOnly[0]?.name, "Draft only");

    assert.equal(matchesHomeActivationFilter(activeItem!.activation, "inactive"), false);
    assert.equal(
      matchesHomeActivationFilter(
        composeHomeActivation({
          workflowId: WORKFLOW_ID,
          versions: [version(VERSION_A, 1)],
          webhooks: [webhook({ status: "disabled" })],
        }),
        "inactive",
      ),
      true,
    );
  });

  it("opens the editor activation chrome instead of teaching three drawers", () => {
    assert.equal(homeActivationHref(WORKFLOW_ID), `/workflows/${WORKFLOW_ID}#activation`);
    assert.equal(homeActivationHref("draft"), "/workflows");
    assert.match(HOME_ACTIVATION_COMMON_PATH_HELP, /#activation/);
    assert.match(HOME_ACTIVATION_HELP, /first-class column/);
    assert.equal(homeActivationColumnIsFirstClass(), true);
    assert.equal(WORKFLOW_HOME_LIST_COLUMNS[1]?.id, HOME_ACTIVATION_COLUMN_ID);

    const home = source("src/components/home/WorkflowHome.tsx");
    const status = source("src/components/home/HomeActivationStatus.tsx");
    const page = source("src/app/workflows/page.tsx");
    assert.match(home, /HomeActivationStatus/);
    assert.match(home, /activation/);
    assert.match(home, /loadHomeActivationStates/);
    assert.match(status, /homeActivationLooksLive/);
    assert.match(status, /#activation|column\.href/);
    assert.equal(homeActivationCommonPathUsesHomeDrawers(status), false);
    assert.equal(status.includes("?webhooks="), false);
    assert.equal(status.includes("?schedules="), false);
    assert.equal(homeActivationInventedRoute(home), false);
    assert.equal(homeActivationInventedRoute(status), false);
    assert.match(page, /activation/i);

    assert.match(home, /canExecute/);
    assert.match(home, /canViewWebhooks/);
    assert.match(home, /canViewSchedules/);
    assert.match(home, /Start published/);
    assert.match(home, /setWebhookWorkflowId/);
    assert.match(home, /setScheduleWorkflowId/);
    assert.match(home, /MANUAL_START_QUERY|WEBHOOK_TRIGGER_QUERY|SCHEDULE_TRIGGER_QUERY/);
  });

  it("keeps row actions role-gated and ADV/RBAC/embed unchanged", () => {
    const viewer = productHomeCapabilities(["workflow.view"]);
    const locked = workflowHomeRowActions({
      published: true,
      workflowId: WORKFLOW_ID,
      capabilities: viewer,
    });
    assert.equal(locked.startPublished, false);
    assert.equal(locked.webhooks, true);
    assert.equal(locked.schedules, true);
    assert.equal(locked.lastRunHref, null);
    assert.equal(locked.activationHref, `/workflows/${WORKFLOW_ID}#activation`);
    assert.equal(locked.activationHref.includes("webhooks="), false);
    assert.equal(locked.activationHref.includes("schedules="), false);

    const editor = productHomeCapabilities([
      "workflow.view",
      "workflow.execute",
      "execution.view",
    ]);
    const published = workflowHomeRowActions({
      published: true,
      lastRunId: WEBHOOK_ID,
      workflowId: WORKFLOW_ID,
      capabilities: editor,
    });
    assert.equal(published.startPublished, true);
    assert.equal(published.lastRunHref, `/executions/${WEBHOOK_ID}`);
    assert.equal(published.activationHref, `/workflows/${WORKFLOW_ID}#activation`);

    assert.equal(homeActivationEmbedUnchanged(WORKFLOW_ID), true);
    assert.equal(HOME_ACTIVATION.noAppsApiChanges, true);
    assert.equal(HOME_ACTIVATION.advRbacEmbedUnchanged, true);

    const client = source("src/lib/home-activation-client.ts");
    assert.match(client, /loadEditorActivation/);
    assert.equal(homeActivationInventedRoute(client), false);
    assert.equal(client.includes("/activations"), false);

    for (const path of HOME_ACTIVATION_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
