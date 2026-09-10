import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  UX9_EPIC,
  UX9_KEEP_STORY_OPEN,
  UX9_STORY,
  WORKFLOW_INSPECTOR,
  WORKFLOW_INSPECTOR_DEFAULT_TAB,
  WORKFLOW_INSPECTOR_HASH,
  WORKFLOW_INSPECTOR_REUSED,
  WORKFLOW_INSPECTOR_SOURCES,
  WORKFLOW_INSPECTOR_TABLIST_ID,
  WORKFLOW_INSPECTOR_TABLIST_LABEL,
  WORKFLOW_INSPECTOR_TABS,
  homeTriggerQueriesUnchanged,
  homeTriggerQueryHrefs,
  operatorHasBelowFoldStacks,
  resolveWorkflowInspectorTab,
  restoreCreatesNewDraftPath,
  triggerContractsUnchanged,
  workflowInspectorReusesPanels,
  workflowInspectorShowsTabs,
  workflowInspectorTabFromHash,
  workflowInspectorTabKeyAction,
} from "./editor-workflow-inspector.ts";
import { EDITOR_INSPECTOR } from "./editor-inspector.ts";
import { MANUAL_START_QUERY, manualStartHref } from "./manual-start-contract.ts";
import {
  SCHEDULE_TRIGGER_QUERY,
  scheduleTriggersHref,
} from "./schedule-trigger-contract.ts";
import {
  WEBHOOK_TRIGGER_QUERY,
  webhookTriggersHref,
} from "./webhook-trigger-contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("UX.9 workflow inspector tabs", () => {
  it("keeps #204 open and cites epic #195", () => {
    assert.equal(UX9_STORY, 204);
    assert.equal(UX9_EPIC, 195);
    assert.equal(UX9_KEEP_STORY_OPEN, true);
    assert.equal(WORKFLOW_INSPECTOR.tabsWhenWorkflowSelected, true);
    assert.equal(WORKFLOW_INSPECTOR.noBelowFoldStacks, true);
    assert.equal(WORKFLOW_INSPECTOR.noAppsApiChanges, true);
    assert.equal(WORKFLOW_INSPECTOR.noDraftExecute, true);
    assert.equal(WORKFLOW_INSPECTOR.noTriggerCanvasNodes, true);
    assert.equal(EDITOR_INSPECTOR.triggersAreNotCanvasNodes, true);
  });

  it("shows Triggers, Versions, and Pins only when the workflow is selected", () => {
    assert.deepEqual([...WORKFLOW_INSPECTOR_TABS], [
      "triggers",
      "versions",
      "pins",
    ]);
    assert.equal(WORKFLOW_INSPECTOR_DEFAULT_TAB, "triggers");
    assert.equal(workflowInspectorShowsTabs({ kind: "workflow" }), true);
    assert.equal(workflowInspectorShowsTabs({ kind: "node" }), false);
    assert.equal(workflowInspectorShowsTabs({ kind: "edge" }), false);
    assert.equal(workflowInspectorShowsTabs(null), true);
    assert.equal(
      resolveWorkflowInspectorTab({ kind: "workflow" }, "versions"),
      "versions",
    );
    assert.equal(
      resolveWorkflowInspectorTab({ kind: "workflow" }, "unknown"),
      "triggers",
    );
    assert.equal(resolveWorkflowInspectorTab({ kind: "node" }, "triggers"), null);
    assert.equal(
      workflowInspectorTabKeyAction("ArrowRight", "triggers"),
      "versions",
    );
    assert.equal(workflowInspectorTabKeyAction("ArrowLeft", "triggers"), "pins");
    assert.equal(workflowInspectorTabKeyAction("Home", "pins"), "triggers");
    assert.equal(workflowInspectorTabKeyAction("End", "triggers"), "pins");
    assert.equal(WORKFLOW_INSPECTOR_TABLIST_ID, "workflow-inspector-tabs");
    assert.equal(WORKFLOW_INSPECTOR_TABLIST_LABEL, "Workflow inspector");
  });

  it("opens editor anchors without below-fold stacks and reuses existing panels", () => {
    assert.deepEqual(WORKFLOW_INSPECTOR_HASH, {
      "webhook-triggers": "triggers",
      "schedule-triggers": "triggers",
      "version-history": "versions",
      "config-pins": "pins",
    });
    assert.equal(workflowInspectorTabFromHash("#webhook-triggers"), "triggers");
    assert.equal(workflowInspectorTabFromHash("#schedule-triggers"), "triggers");
    assert.equal(workflowInspectorTabFromHash("#version-history"), "versions");
    assert.equal(workflowInspectorTabFromHash("#config-pins"), "pins");
    assert.equal(workflowInspectorTabFromHash(""), null);

    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    assert.equal(operatorHasBelowFoldStacks(operator), false);
    assert.equal(operator.includes("Triggers &amp; versions"), false);
    assert.equal(operator.includes("Triggers & versions"), false);
    assert.match(operator, /workflowAdmin=/);
    assert.match(operator, /restoreWorkflowVersion/);

    const tabs = source("src/components/workflows/EditorWorkflowTabs.tsx");
    assert.equal(workflowInspectorReusesPanels(tabs), true);
    assert.match(tabs, /role="tablist"/);
    assert.match(tabs, /WebhookTriggerPanel/);
    assert.match(tabs, /ScheduleTriggerPanel/);
    assert.match(tabs, /VersionHistory/);
    assert.match(tabs, /WorkflowConfigPins/);
    assert.deepEqual([...WORKFLOW_INSPECTOR_REUSED], [
      "WebhookTriggerPanel",
      "ScheduleTriggerPanel",
      "VersionHistory",
      "WorkflowConfigPins",
    ]);

    const inspector = source("src/components/workflows/EditorInspector.tsx");
    assert.match(inspector, /EditorWorkflowTabs/);
    assert.match(inspector, /not canvas nodes/);
  });

  it("keeps /triggers and /schedules contracts and discards webhook secrets after submit", () => {
    assert.equal(WORKFLOW_INSPECTOR.sameTriggersAndSchedulesContracts, true);
    assert.equal(WORKFLOW_INSPECTOR.secretsShownOnceThenDiscarded, true);
    assert.equal(WORKFLOW_INSPECTOR.webhookScheduleInTriggersTab, true);
    assert.equal(triggerContractsUnchanged(), true);

    const webhook = source("src/components/workflows/WebhookTriggerPanel.tsx");
    assert.match(webhook, /forgetWebhookInlineSecret/);
    assert.match(webhook, /id="webhook-triggers"/);
    assert.match(webhook, /createWebhookTrigger/);
    assert.match(webhook, /rotateWebhookTrigger/);

    const schedule = source("src/components/workflows/ScheduleTriggerPanel.tsx");
    assert.match(schedule, /id="schedule-triggers"/);
    assert.match(schedule, /createScheduleTrigger/);
    assert.match(schedule, /listScheduleTriggers/);
  });

  it("keeps version restore as a new draft and pins as authorized metadata", () => {
    assert.equal(WORKFLOW_INSPECTOR.versionsTabHasCompareExportRestore, true);
    assert.equal(WORKFLOW_INSPECTOR.restoreCreatesNewDraft, true);
    assert.equal(WORKFLOW_INSPECTOR.pinsAuthorizedMetadataOnly, true);
    assert.equal(restoreCreatesNewDraftPath(WORKFLOW_ID, VERSION_ID), true);

    const versions = source("src/components/workflows/VersionHistory.tsx");
    assert.match(versions, /Restore as new draft/);
    assert.match(versions, /id="version-history"/);
    assert.match(versions, /never mutates the/);
    assert.match(versions, /onExport/);
    assert.match(versions, /onRestore/);
    assert.match(versions, /onCompare/);

    const pins = source("src/components/workflows/WorkflowConfigPins.tsx");
    assert.match(pins, /id="config-pins"/);
    assert.match(pins, /authorized pin/);
    assert.equal(pins.includes("SecretField"), false);
    assert.equal(pins.includes('type="password"'), false);
    assert.match(pins, /Secrets never appear/);
  });

  it("leaves home ?webhooks= / ?schedules= / ?start=1 on /workflows", () => {
    assert.equal(WORKFLOW_INSPECTOR.homeQueryParamsStillWork, true);
    assert.equal(homeTriggerQueriesUnchanged(), true);
    assert.equal(WEBHOOK_TRIGGER_QUERY, "webhooks");
    assert.equal(SCHEDULE_TRIGGER_QUERY, "schedules");
    assert.equal(MANUAL_START_QUERY, "start");
    assert.deepEqual(homeTriggerQueryHrefs(WORKFLOW_ID), {
      webhooks: `/workflows?webhooks=${WORKFLOW_ID}`,
      schedules: `/workflows?schedules=${WORKFLOW_ID}`,
      start: `/workflows?start=${WORKFLOW_ID}`,
      startDraft: "/workflows?start=1",
    });
    assert.equal(
      webhookTriggersHref(WORKFLOW_ID),
      `/workflows?webhooks=${WORKFLOW_ID}`,
    );
    assert.equal(
      scheduleTriggersHref(WORKFLOW_ID),
      `/workflows?schedules=${WORKFLOW_ID}`,
    );
    assert.equal(manualStartHref("draft"), "/workflows?start=1");

    const home = source("src/components/home/WorkflowHome.tsx");
    assert.match(home, /WEBHOOK_TRIGGER_QUERY/);
    assert.match(home, /SCHEDULE_TRIGGER_QUERY/);
    assert.match(home, /MANUAL_START_QUERY/);
    assert.match(home, /WebhookTriggerPanel/);
    assert.match(home, /ScheduleTriggerPanel/);
    assert.match(home, /ManualStartPanel/);

    assert.deepEqual(
      [...WORKFLOW_INSPECTOR_SOURCES],
      [
        "src/components/workflows/EditorWorkflowTabs.tsx",
        "src/components/workflows/EditorInspector.tsx",
        "src/components/workflows/WorkflowOperator.tsx",
        "src/components/workflows/WebhookTriggerPanel.tsx",
        "src/components/workflows/ScheduleTriggerPanel.tsx",
        "src/components/workflows/VersionHistory.tsx",
        "src/components/workflows/WorkflowConfigPins.tsx",
        "src/components/home/WorkflowHome.tsx",
      ],
    );
  });
});
