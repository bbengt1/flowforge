import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_ACTIVATION,
  EDITOR_ACTIVATION_ACTIVE_HELP,
  EDITOR_ACTIVATION_COMMON_PATH_HELP,
  EDITOR_ACTIVATION_COMPOSE,
  EDITOR_ACTIVATION_DRAFT_HELP,
  EDITOR_ACTIVATION_HASH,
  EDITOR_ACTIVATION_HEADING_ID,
  EDITOR_ACTIVATION_MANUAL_HELP,
  EDITOR_ACTIVATION_NO_PINS_HELP,
  EDITOR_ACTIVATION_PANEL_ID,
  EDITOR_ACTIVATION_REUSED,
  EDITOR_ACTIVATION_SOURCES,
  INVENTED_ACTIVATION_ROUTES,
  R61_EPIC,
  R61_KEEP_STORY_OPEN,
  R61_STORY,
  activationPinsFromRecords,
  activationTogglePlan,
  canManageEditorActivation,
  canViewEditorActivation,
  composeEditorActivation,
  composeWorkflowActivation,
  defaultActivationVersionId,
  editorActivationCommonPathUsesHomeDrawers,
  editorActivationCsrfOnMutations,
  editorActivationHomeDrawersStillWork,
  editorActivationHref,
  editorActivationInventedRoute,
  editorActivationLooksLive,
  editorActivationTopBarLabel,
  editorActivationUsesExistingEnableRoutes,
  pinsForPublishedVersion,
  publishedActivationVersions,
  publishedVersionLabel,
} from "./editor-activation.ts";
import { EDITOR_INSPECTOR } from "./editor-inspector.ts";
import type { ScheduleTriggerRecord } from "./schedule-trigger-contract.ts";
import type { WebhookTriggerRecord } from "./webhook-trigger-contract.ts";
import type { WorkflowVersion } from "./workflow-types.ts";

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

describe("R6.1 editor activation chrome", () => {
  it("keeps #270 open and cites epic #232", () => {
    assert.equal(R61_STORY, 270);
    assert.equal(R61_EPIC, 232);
    assert.equal(R61_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_ACTIVATION.composeEnablePlusVersionPin, true);
    assert.equal(EDITOR_ACTIVATION.noNewActivationResource, true);
    assert.equal(EDITOR_ACTIVATION.noInventedActivationApi, true);
    assert.equal(EDITOR_ACTIVATION.triggersStayWorkflowLevel, true);
    assert.equal(EDITOR_ACTIVATION.draftsNeverRun, true);
    assert.equal(EDITOR_ACTIVATION.draftsNeverLookLive, true);
    assert.equal(EDITOR_ACTIVATION.densifyTriggersTab, true);
    assert.equal(EDITOR_ACTIVATION.doNotTeachThreeDrawers, true);
    assert.equal(EDITOR_ACTIVATION.homeDrawersStillWork, true);
    assert.equal(EDITOR_ACTIVATION.homeActivationColumnOutOfScope, true);
    assert.equal(EDITOR_ACTIVATION.oneGestureTestRunOutOfScope, true);
    assert.equal(EDITOR_ACTIVATION.manualStartIsNotActivation, true);
    assert.equal(EDITOR_ACTIVATION.noCanvasTriggerNodes, true);
    assert.equal(EDITOR_ACTIVATION.noAppsApiChanges, true);
    assert.equal(EDITOR_ACTIVATION.noDraftExecute, true);
    assert.equal(EDITOR_ACTIVATION.readModelGap, false);
    assert.equal(EDITOR_ACTIVATION.jonnyStandbyOnlyIfReadModelGap, true);
    assert.equal(EDITOR_ACTIVATION.clientComposesExistingLists, true);
    assert.equal(EDITOR_INSPECTOR.triggersAreNotCanvasNodes, true);
  });

  it("composes active from enabled webhook/schedule pins on a published version", () => {
    const versions = [version(VERSION_A, 3), version(VERSION_B, 4)];
    const pins = activationPinsFromRecords({
      webhooks: [webhook()],
      schedules: [schedule({ workflowVersionId: VERSION_B })],
    });
    assert.equal(pins.length, 2);
    assert.equal(pins[0]?.kind, "webhook");
    assert.equal(pins[1]?.kind, "schedule");
    assert.deepEqual(
      publishedActivationVersions([
        version("draft", 0),
        version(VERSION_A, 3),
      ]).map((item) => item.id),
      [VERSION_A],
    );

    const active = composeEditorActivation({
      versions,
      pins,
      selectedVersionId: VERSION_A,
    });
    assert.equal(active.kind, "active");
    assert.equal(active.live, true);
    assert.equal(active.draftLooksLive, false);
    assert.equal(editorActivationLooksLive(active), true);
    assert.equal(active.publishedVersionId, VERSION_A);
    assert.equal(active.publishedVersionLabel, "published v3");
    assert.equal(active.label, "This published v3 is active");
    assert.equal(active.help, EDITOR_ACTIVATION_ACTIVE_HELP);
    assert.equal(active.canDeactivate, true);
    assert.equal(active.canActivate, false);
    assert.match(EDITOR_ACTIVATION_COMPOSE, /published version/);
    assert.match(EDITOR_ACTIVATION_MANUAL_HELP, /not activation/);
  });

  it("never treats drafts as live and ignores unpublished pins", () => {
    const none = composeEditorActivation({
      versions: [version("draft", 0), version("current", 0)],
      webhooks: [webhook({ workflowVersionId: "draft" })],
      schedules: [schedule({ workflowVersionId: "draft:1" })],
    });
    assert.equal(none.kind, "no-published");
    assert.equal(none.live, false);
    assert.equal(none.draftLooksLive, false);
    assert.equal(editorActivationLooksLive(none), false);
    assert.equal(none.label, "Draft — not live");
    assert.equal(none.help, EDITOR_ACTIVATION_DRAFT_HELP);
    assert.equal(none.canActivate, false);
    assert.equal(pinsForPublishedVersion(none.pins, "draft").length, 0);

    const noPins = composeEditorActivation({
      versions: [version(VERSION_A, 1)],
      pins: [],
    });
    assert.equal(noPins.kind, "no-pins");
    assert.equal(noPins.live, false);
    assert.equal(noPins.label, "published v1 is not active");
    assert.equal(noPins.help, EDITOR_ACTIVATION_NO_PINS_HELP);

    const inactive = composeEditorActivation({
      versions: [version(VERSION_A, 2)],
      schedules: [schedule({ status: "disabled" })],
    });
    assert.equal(inactive.kind, "inactive");
    assert.equal(inactive.live, false);
    assert.equal(inactive.canActivate, true);
    assert.equal(inactive.canDeactivate, false);
    assert.match(inactive.help, /not active/);
  });

  it("labels the top bar without implying the draft is live", () => {
    const draft = composeWorkflowActivation({ versions: [] });
    assert.equal(editorActivationTopBarLabel(draft), "Draft — not live");

    const inactive = composeWorkflowActivation({
      versions: [version(VERSION_A, 1)],
      webhooks: [webhook({ status: "disabled" })],
    });
    assert.equal(editorActivationTopBarLabel(inactive), "Not active");

    const active = composeWorkflowActivation({
      versions: [version(VERSION_A, 8), version(VERSION_B, 9)],
      webhooks: [webhook({ status: "enabled" })],
    });
    assert.equal(
      editorActivationTopBarLabel(active),
      "Active · published v8",
    );

    const two = composeWorkflowActivation({
      versions: [version(VERSION_A, 8), version(VERSION_B, 9)],
      webhooks: [
        webhook({ status: "enabled" }),
        webhook({
          id: "77777777-7777-4777-8777-777777777777",
          workflowVersionId: VERSION_B,
          status: "enabled",
        }),
      ],
    });
    assert.equal(
      editorActivationTopBarLabel(two),
      "Active · 2 published versions",
    );
    assert.equal(two.draftLooksLive, false);
  });

  it("plans enable/disable only for pins on the selected published version", () => {
    const pins = activationPinsFromRecords({
      webhooks: [
        webhook({ status: "disabled" }),
        webhook({
          id: "88888888-8888-4888-8888-888888888888",
          workflowVersionId: VERSION_B,
          status: "disabled",
        }),
      ],
      schedules: [schedule({ status: "enabled", workflowVersionId: VERSION_A })],
    });
    assert.deepEqual(activationTogglePlan(pins, VERSION_A, "enable"), [
      { kind: "webhook", id: WEBHOOK_ID, action: "enable" },
    ]);
    assert.deepEqual(activationTogglePlan(pins, VERSION_A, "disable"), [
      { kind: "schedule", id: SCHEDULE_ID, action: "disable" },
    ]);
    assert.deepEqual(activationTogglePlan(pins, "draft", "enable"), []);
    assert.equal(
      defaultActivationVersionId({
        versions: [version(VERSION_B, 2), version(VERSION_A, 1)],
        pins,
      }),
      VERSION_A,
    );
    assert.equal(publishedVersionLabel([version(VERSION_B, 4)], VERSION_B), "published v4");
  });

  it("reuses existing enable + version pin routes and requires CSRF", () => {
    assert.equal(editorActivationUsesExistingEnableRoutes(), true);
    assert.equal(editorActivationCsrfOnMutations(), true);
    assert.equal(EDITOR_ACTIVATION.csrfOnEnableDisable, true);
    assert.deepEqual([...EDITOR_ACTIVATION_REUSED], [
      "enableWebhookTrigger",
      "disableWebhookTrigger",
      "enableScheduleTrigger",
      "disableScheduleTrigger",
      "listWebhookTriggers",
      "listScheduleTriggers",
    ]);
    assert.equal(canViewEditorActivation(null), false);
    assert.equal(canViewEditorActivation(["workflow.view"]), true);
    assert.equal(canManageEditorActivation(["workflow.view"]), false);
    assert.equal(
      canManageEditorActivation(["workflow.view", "workflow.edit"]),
      true,
    );

    const client = source("src/lib/editor-activation-client.ts");
    for (const name of EDITOR_ACTIVATION_REUSED) {
      assert.match(client, new RegExp(name));
    }
    assert.equal(editorActivationInventedRoute(client), false);
    for (const route of INVENTED_ACTIVATION_ROUTES) {
      assert.equal(client.includes(route), false);
    }
  });

  it("densifies editor chrome without teaching three drawers", () => {
    assert.equal(EDITOR_ACTIVATION_HASH, "activation");
    assert.equal(EDITOR_ACTIVATION_PANEL_ID, "editor-activation");
    assert.equal(EDITOR_ACTIVATION_HEADING_ID, "editor-activation-heading");
    assert.equal(
      editorActivationHref(WORKFLOW_ID),
      `/workflows/${WORKFLOW_ID}#activation`,
    );
    assert.equal(editorActivationHref("draft"), "/workflows");
    assert.equal(editorActivationHomeDrawersStillWork(), true);
    assert.match(EDITOR_ACTIVATION_COMMON_PATH_HELP, /common path/);

    const chrome = source(
      "src/components/workflows/EditorActivationChrome.tsx",
    );
    assert.match(chrome, /This published version is active|state\.label/);
    assert.match(chrome, /draftLooksLive/);
    assert.equal(editorActivationCommonPathUsesHomeDrawers(chrome), false);
    assert.equal(editorActivationInventedRoute(chrome), false);
    assert.equal(chrome.includes("manual") && chrome.includes("canvas"), false);

    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    assert.match(topBar, /EditorActivationChrome/);
    assert.match(topBar, /"activation"/);
    assert.equal(editorActivationCommonPathUsesHomeDrawers(topBar), false);

    const tabs = source("src/components/workflows/EditorWorkflowTabs.tsx");
    assert.match(tabs, /EditorActivationChrome/);
    assert.match(tabs, /WebhookTriggerPanel/);
    assert.match(tabs, /ScheduleTriggerPanel/);
    assert.ok(
      tabs.indexOf("EditorActivationChrome") <
        tabs.indexOf("WebhookTriggerPanel"),
    );

    const inspector = source("src/lib/editor-workflow-inspector.ts");
    assert.match(inspector, /activation/);
    assert.match(inspector, /"triggers"/);

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    assert.match(operator, /openActivationChrome|onOpenActivation/);
    assert.match(operator, /EDITOR_ACTIVATION_HASH|#activation/);
    assert.equal(operator.includes("?webhooks="), false);
    assert.equal(operator.includes("?schedules="), false);

    const inspectorUi = source("src/components/workflows/EditorInspector.tsx");
    assert.match(inspectorUi, /not canvas nodes/);

    assert.deepEqual([...EDITOR_ACTIVATION_SOURCES], [
      "src/lib/editor-activation.ts",
      "src/lib/editor-activation-client.ts",
      "src/components/workflows/EditorActivationChrome.tsx",
      "src/components/workflows/EditorTopBar.tsx",
      "src/components/workflows/EditorWorkflowTabs.tsx",
      "src/components/workflows/WorkflowOperator.tsx",
    ]);
    for (const path of EDITOR_ACTIVATION_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
