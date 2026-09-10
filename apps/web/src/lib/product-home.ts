/**
 * UX.8: `/workflows` is the product home. `/` and the editor are
 * not lists.
 *
 * Relates to #203 / Part of #195. Keep #203 open until merge.
 *
 * Chloe UI only. Health and OpenAPI live under Settings. Home rows
 * open the editor, start a published version, configure webhook /
 * schedule triggers when the role can see them, and jump to the last
 * run. Templates still POST a draft and then route into the editor.
 * Deep links to `/workflows/{id}` stay valid standalone and embed.
 */

import { editorEmbedWorkflowPath, isWorkflowEditorPath } from "./editor-chrome.ts";
import { listExecutionsPath } from "./execution-contract.ts";
import { canSeeExecutionsNav } from "./execution.ts";
import { canViewScheduleTriggers } from "./schedule-trigger-contract.ts";
import { canViewWebhookTriggers } from "./webhook-trigger-contract.ts";
import { canExecuteWorkflows, canSeeWorkflowsNav } from "./workspace-nav.ts";

export const UX8_STORY = 203;
export const UX8_EPIC = 195;
export const UX8_KEEP_STORY_OPEN = true;

export const PRODUCT_HOME_HREF = "/workflows";
export const SETTINGS_HEALTH_HREF = "/settings#health";
export const SETTINGS_OPENAPI_HREF = "/settings#api-docs";
export const SETTINGS_HREF = "/settings";

export const PRODUCT_HOME = {
  rootWithWorkflowViewLandsOnWorkflows: true,
  healthAndOpenApiLiveUnderSettings: true,
  editorIsNotASecondHome: true,
  deepLinksStayValidStandaloneAndEmbed: true,
  templatesPostDraftThenOpenEditor: true,
  noAppsApiChanges: true,
} as const;

export const PRODUCT_HOME_SOURCES = [
  "src/app/page.tsx",
  "src/components/home/ProductHomeLanding.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/app/settings/page.tsx",
  "src/app/templates/page.tsx",
  "src/app/workflows/page.tsx",
  "src/app/workflows/[id]/page.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
] as const;

export type WorkflowHomeRowCapabilities = {
  canExecute: boolean;
  canViewWebhooks: boolean;
  canViewSchedules: boolean;
  canSeeLastRun: boolean;
};

export function productHomeCapabilities(
  permissions: readonly string[] | null | undefined,
): WorkflowHomeRowCapabilities {
  return {
    canExecute: canExecuteWorkflows(permissions),
    canViewWebhooks: canViewWebhookTriggers(permissions),
    canViewSchedules: canViewScheduleTriggers(permissions),
    canSeeLastRun: canSeeExecutionsNav(permissions ?? []),
  };
}

/** `/` with `workflow.view` lands on `/workflows`. */
export function shouldLandOnWorkflowsHome(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeWorkflowsNav(permissions);
}

export function productHomeHref(
  permissions: readonly string[] | null | undefined,
): string {
  return shouldLandOnWorkflowsHome(permissions)
    ? PRODUCT_HOME_HREF
    : SETTINGS_HREF;
}

export function workflowEditorHref(workflowId: string): string {
  return `/workflows/${workflowId}`;
}

/** Templates POST a draft, then route into the editor — not back to a list. */
export function templateCreatedEditorHref(
  workflowId?: string | null,
): string {
  const id = workflowId?.trim();
  return id ? workflowEditorHref(id) : PRODUCT_HOME_HREF;
}

export function workflowHomeLastRunHref(input: {
  workflowId: string;
  lastRunId?: string | null;
}): string {
  const lastRunId = input.lastRunId?.trim();
  if (lastRunId) {
    return `/executions/${lastRunId}`;
  }
  return listExecutionsPath({ workflowId: input.workflowId });
}

export function workflowHomeRowActions(input: {
  published: boolean;
  lastRunId?: string | null;
  workflowId: string;
  capabilities: WorkflowHomeRowCapabilities;
}): {
  openEditor: string;
  startPublished: boolean;
  webhooks: boolean;
  schedules: boolean;
  lastRunHref: string | null;
} {
  return {
    openEditor: workflowEditorHref(input.workflowId),
    startPublished: input.published && input.capabilities.canExecute,
    webhooks: input.capabilities.canViewWebhooks,
    schedules: input.capabilities.canViewSchedules,
    lastRunHref: input.capabilities.canSeeLastRun
      ? workflowHomeLastRunHref({
          workflowId: input.workflowId,
          lastRunId: input.lastRunId,
        })
      : null,
  };
}

/** The editor is never the product home — `/workflows` is. */
export function isProductHomePath(
  pathname: string | null | undefined,
): boolean {
  const path = (pathname ?? "").split("?")[0];
  return path === PRODUCT_HOME_HREF;
}

export function editorIsProductHome(
  pathname: string | null | undefined,
): boolean {
  return isWorkflowEditorPath(pathname) && isProductHomePath(pathname);
}

export function editorDeepLinkUnchanged(workflowId = "{id}"): boolean {
  return (
    workflowEditorHref(workflowId) === `/workflows/${workflowId}` &&
    editorEmbedWorkflowPath(workflowId) ===
      `/embed/v1/workflows/${workflowId}`
  );
}
