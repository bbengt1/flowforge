/**
 * UX.9: workflow inspector tabs for Triggers, Versions, Pins.
 *
 * Relates to #204 / Part of #195. Keep #204 open until merge.
 *
 * Chloe UI only. Moves webhook/schedule admin, version history, and
 * config pins from below-fold stacks into the right rail when the
 * workflow (not a node) is selected. Same `/triggers` and `/schedules`
 * contracts; secrets shown once then discarded. Restore still creates
 * a new draft. Home `?webhooks=` / `?schedules=` / `?start=1` still
 * work. No apps/api changes, no trigger-as-canvas-nodes, no draft
 * execute.
 */

import { inspectorFocus, type InspectorFocus } from "./editor-inspector.ts";
import { MANUAL_START_QUERY, manualStartHref } from "./manual-start-contract.ts";
import {
  SCHEDULE_TRIGGER_COLLECTION,
  SCHEDULE_TRIGGER_DEFAULT_ADMIN,
  SCHEDULE_TRIGGER_QUERY,
  scheduleTriggersHref,
} from "./schedule-trigger-contract.ts";
import {
  WEBHOOK_TRIGGER_COLLECTION,
  WEBHOOK_TRIGGER_DEFAULT_ADMIN,
  WEBHOOK_TRIGGER_QUERY,
  webhookTriggersHref,
} from "./webhook-trigger-contract.ts";
import { workflowRestorePath } from "./workflow-client.ts";

export const UX9_STORY = 204;
export const UX9_EPIC = 195;
export const UX9_KEEP_STORY_OPEN = true;

export const WORKFLOW_INSPECTOR_TABS = ["triggers", "versions", "pins"] as const;
export type WorkflowInspectorTab = (typeof WORKFLOW_INSPECTOR_TABS)[number];

export const WORKFLOW_INSPECTOR_DEFAULT_TAB: WorkflowInspectorTab = "triggers";
export const WORKFLOW_INSPECTOR_TABLIST_ID = "workflow-inspector-tabs";
export const WORKFLOW_INSPECTOR_TABLIST_LABEL = "Workflow inspector";

export const WORKFLOW_INSPECTOR_HASH: Record<string, WorkflowInspectorTab> = {
  "webhook-triggers": "triggers",
  "schedule-triggers": "triggers",
  "version-history": "versions",
  "config-pins": "pins",
};

export const WORKFLOW_INSPECTOR = {
  tabsWhenWorkflowSelected: true,
  noBelowFoldStacks: true,
  webhookScheduleInTriggersTab: true,
  sameTriggersAndSchedulesContracts: true,
  secretsShownOnceThenDiscarded: true,
  versionsTabHasCompareExportRestore: true,
  restoreCreatesNewDraft: true,
  pinsAuthorizedMetadataOnly: true,
  homeQueryParamsStillWork: true,
  noTriggerCanvasNodes: true,
  noAppsApiChanges: true,
  noDraftExecute: true,
} as const;

export const WORKFLOW_INSPECTOR_SOURCES = [
  "src/components/workflows/EditorWorkflowTabs.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
  "src/components/workflows/WebhookTriggerPanel.tsx",
  "src/components/workflows/ScheduleTriggerPanel.tsx",
  "src/components/workflows/VersionHistory.tsx",
  "src/components/workflows/WorkflowConfigPins.tsx",
  "src/components/home/WorkflowHome.tsx",
] as const;

export const WORKFLOW_INSPECTOR_REUSED = [
  "WebhookTriggerPanel",
  "ScheduleTriggerPanel",
  "VersionHistory",
  "WorkflowConfigPins",
] as const;

const BELOW_FOLD_STACK =
  /Triggers\s*&(?:amp;)?\s*versions|<details[^>]*>[\s\S]*Config pins/;

export function workflowInspectorShowsTabs(
  selection: { kind: InspectorFocus } | null | undefined,
): boolean {
  return inspectorFocus(selection) === "workflow";
}

export function isWorkflowInspectorTab(
  value: string | null | undefined,
): value is WorkflowInspectorTab {
  return (
    value === "triggers" || value === "versions" || value === "pins"
  );
}

export function resolveWorkflowInspectorTab(
  selection: { kind: InspectorFocus } | null | undefined,
  tab: string | null | undefined,
): WorkflowInspectorTab | null {
  if (!workflowInspectorShowsTabs(selection)) {
    return null;
  }
  return isWorkflowInspectorTab(tab) ? tab : WORKFLOW_INSPECTOR_DEFAULT_TAB;
}

export function workflowInspectorTabFromHash(
  hash: string | null | undefined,
): WorkflowInspectorTab | null {
  const id = (hash ?? "").replace(/^#/, "").trim();
  return WORKFLOW_INSPECTOR_HASH[id] ?? null;
}

export function workflowInspectorTabKeyAction(
  key: string,
  current: WorkflowInspectorTab,
): WorkflowInspectorTab {
  const index = WORKFLOW_INSPECTOR_TABS.indexOf(current);
  const last = WORKFLOW_INSPECTOR_TABS.length - 1;
  if (key === "Home") {
    return WORKFLOW_INSPECTOR_TABS[0];
  }
  if (key === "End") {
    return WORKFLOW_INSPECTOR_TABS[last];
  }
  if (key === "ArrowRight" || key === "ArrowDown") {
    return WORKFLOW_INSPECTOR_TABS[(index + 1) % WORKFLOW_INSPECTOR_TABS.length];
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return WORKFLOW_INSPECTOR_TABS[
      (index - 1 + WORKFLOW_INSPECTOR_TABS.length) % WORKFLOW_INSPECTOR_TABS.length
    ];
  }
  return current;
}

export function operatorHasBelowFoldStacks(source: string): boolean {
  return BELOW_FOLD_STACK.test(source);
}

export function workflowInspectorReusesPanels(source: string): boolean {
  return WORKFLOW_INSPECTOR_REUSED.every((name) => source.includes(name));
}

export function homeTriggerQueryHrefs(workflowId: string): {
  webhooks: string;
  schedules: string;
  start: string;
  startDraft: string;
} {
  return {
    webhooks: webhookTriggersHref(workflowId),
    schedules: scheduleTriggersHref(workflowId),
    start: manualStartHref(workflowId),
    startDraft: manualStartHref("draft"),
  };
}

export function homeTriggerQueriesUnchanged(): boolean {
  return (
    WEBHOOK_TRIGGER_QUERY === "webhooks" &&
    SCHEDULE_TRIGGER_QUERY === "schedules" &&
    MANUAL_START_QUERY === "start"
  );
}

export function triggerContractsUnchanged(): boolean {
  return (
    WEBHOOK_TRIGGER_COLLECTION === "triggers" &&
    WEBHOOK_TRIGGER_DEFAULT_ADMIN.listRoute ===
      "/workflows/{workflowId}/triggers" &&
    WEBHOOK_TRIGGER_DEFAULT_ADMIN.itemRoute === "/triggers/{triggerId}" &&
    SCHEDULE_TRIGGER_COLLECTION === "schedules" &&
    SCHEDULE_TRIGGER_DEFAULT_ADMIN.listRoute === "/schedules" &&
    SCHEDULE_TRIGGER_DEFAULT_ADMIN.itemRoute === "/schedules/{scheduleId}"
  );
}

export function restoreCreatesNewDraftPath(
  workflowId: string,
  versionId: string,
): boolean {
  return (
    workflowRestorePath(workflowId, versionId) ===
    `/workflows/${workflowId}/versions/${versionId}/restore`
  );
}
