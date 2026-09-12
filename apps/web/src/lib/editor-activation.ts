/**
 * R6.1: Editor activation chrome (D2 compose).
 *
 * Relates to #270 / Part of #232. Keep #270 open.
 *
 * Chloe UI only. “Active” = enable triggers on a **published** version
 * by composing existing webhook/schedule `status` + `workflowVersionId`
 * pin (`POST /triggers/{id}/enable|disable`, schedule equivalents).
 * No new activation aggregate or resource. Triggers stay workflow-level
 * (D3), not canvas nodes. Drafts never run and never look live.
 *
 * Densify the Triggers tab / editor chrome in place (D6). The common
 * path is the editor — do not teach home `?webhooks=` / `?schedules=` /
 * `?start=1` drawers for activation. Those query drawers still work
 * (R6.2 owns the home column).
 *
 * jonny standby: no read-model gap blocked this story. The editor
 * composes `GET /workflows/{id}/triggers`, `GET /schedules?workflowId=`,
 * and `GET /workflows/{id}/versions`. An optional later computed
 * `activation` summary on `GET /workflows` would be a read model only
 * — do not invent a resource here.
 */

import { isDraftRunSelection, publishedRunVersions } from "./execution-replay.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import {
  SCHEDULE_TRIGGER_DEFAULT_ADMIN,
  canManageScheduleTriggers,
  canViewScheduleTriggers,
  editorScheduleTriggersHref,
  scheduleExpressionLabel,
  type ScheduleTriggerRecord,
} from "./schedule-trigger-contract.ts";
import { csrfRequiredFor } from "./session-contract.ts";
import {
  WEBHOOK_TRIGGER_DEFAULT_ADMIN,
  canManageWebhookTriggers,
  canViewWebhookTriggers,
  editorWebhookTriggersHref,
  type WebhookTriggerRecord,
} from "./webhook-trigger-contract.ts";
import type { WorkflowVersion } from "./workflow-types.ts";
import { canCreateWorkflows, canSeeWorkflowsNav } from "./workspace-nav.ts";

export const R61_STORY = 270;
export const R61_EPIC = 232;
export const R61_KEEP_STORY_OPEN = true;

export const EDITOR_ACTIVATION_HASH = "activation";
export const EDITOR_ACTIVATION_PANEL_ID = "editor-activation";
export const EDITOR_ACTIVATION_HEADING_ID = "editor-activation-heading";
export const EDITOR_ACTIVATION_CHANGED_EVENT = "flowforge:editor-activation";

export const EDITOR_ACTIVATION_COMPOSE =
  "Active means this published version has at least one enabled webhook or schedule pin. The draft never runs and never looks live. Manual start is on-demand, not activation.";

export const EDITOR_ACTIVATION_DRAFT_HELP =
  "Publish a version before activation. Drafts never run and never look live.";

export const EDITOR_ACTIVATION_NO_PINS_HELP =
  "Create a webhook or schedule pin below, then enable it on this published version. Home drawers are not the common path.";

export const EDITOR_ACTIVATION_INACTIVE_HELP =
  "This published version is not active. Enable a webhook or schedule pin to make it live. The draft still never runs.";

export const EDITOR_ACTIVATION_ACTIVE_HELP =
  "This published version is active: at least one webhook or schedule pin is enabled. The open draft is not live.";

export const EDITOR_ACTIVATION_MANUAL_HELP =
  "Manual start is on-demand for a published version. It is not activation.";

export const EDITOR_ACTIVATION_COMMON_PATH_HELP =
  "Activation lives on this editor (top bar + Triggers tab). Home ?webhooks= / ?schedules= still work; do not teach those drawers for the common path.";

export const EDITOR_ACTIVATION = {
  composeEnablePlusVersionPin: true,
  noNewActivationResource: true,
  noInventedActivationApi: true,
  triggersStayWorkflowLevel: true,
  draftsNeverRun: true,
  draftsNeverLookLive: true,
  densifyTriggersTab: true,
  doNotTeachThreeDrawers: true,
  homeDrawersStillWork: true,
  homeActivationColumnOutOfScope: true,
  oneGestureTestRunOutOfScope: true,
  manualStartIsNotActivation: true,
  noCanvasTriggerNodes: true,
  noAppsApiChanges: true,
  noDraftExecute: true,
  csrfOnEnableDisable: true,
  jonnyStandbyOnlyIfReadModelGap: true,
  readModelGap: false,
  clientComposesExistingLists: true,
} as const;

export const EDITOR_ACTIVATION_SOURCES = [
  "src/lib/editor-activation.ts",
  "src/lib/editor-activation-client.ts",
  "src/components/workflows/EditorActivationChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/EditorWorkflowTabs.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
] as const;

export const EDITOR_ACTIVATION_REUSED = [
  "enableWebhookTrigger",
  "disableWebhookTrigger",
  "enableScheduleTrigger",
  "disableScheduleTrigger",
  "listWebhookTriggers",
  "listScheduleTriggers",
] as const;

export const INVENTED_ACTIVATION_ROUTES = [
  "/activations",
  "/activation",
  "/workflows/{id}/activation",
  "/workflows/{workflowId}/activation",
] as const;

export type ActivationKind = "webhook" | "schedule";
export type ActivationPinStatus = "enabled" | "disabled";
export type ActivationIntent = "enable" | "disable";

export type EditorActivationKind =
  | "no-published"
  | "no-pins"
  | "inactive"
  | "active";

export type EditorActivationPin = {
  kind: ActivationKind;
  id: string;
  workflowVersionId: string;
  status: ActivationPinStatus;
  label: string;
};

export type EditorActivationToggle = {
  kind: ActivationKind;
  id: string;
  action: ActivationIntent;
};

export type EditorActivationState = {
  kind: EditorActivationKind;
  live: boolean;
  draftLooksLive: false;
  publishedVersionId: string | null;
  publishedVersionLabel: string | null;
  workflowActiveVersionIds: string[];
  enabledPins: EditorActivationPin[];
  disabledPins: EditorActivationPin[];
  pins: EditorActivationPin[];
  label: string;
  help: string;
  canActivate: boolean;
  canDeactivate: boolean;
};

export function canViewEditorActivation(
  permissions: readonly string[] | null | undefined,
): boolean {
  return (
    canViewWebhookTriggers(permissions) ||
    canViewScheduleTriggers(permissions) ||
    canSeeWorkflowsNav(permissions)
  );
}

export function canManageEditorActivation(
  permissions: readonly string[] | null | undefined,
): boolean {
  return (
    canManageWebhookTriggers(permissions) ||
    canManageScheduleTriggers(permissions) ||
    canCreateWorkflows(permissions)
  );
}

export function publishedActivationVersions(
  versions: readonly WorkflowVersion[] | null | undefined,
): WorkflowVersion[] {
  return publishedRunVersions([...(versions ?? [])]);
}

export function activationPinsFromRecords(input: {
  webhooks?: readonly WebhookTriggerRecord[] | null;
  schedules?: readonly ScheduleTriggerRecord[] | null;
}): EditorActivationPin[] {
  const pins: EditorActivationPin[] = [];
  for (const item of input.webhooks ?? []) {
    if (!isResourceId(item.workflowVersionId)) {
      continue;
    }
    pins.push({
      kind: "webhook",
      id: item.id,
      workflowVersionId: item.workflowVersionId,
      status: item.status === "disabled" ? "disabled" : "enabled",
      label: item.publicId || item.ingressPath || item.id,
    });
  }
  for (const item of input.schedules ?? []) {
    if (!isResourceId(item.workflowVersionId)) {
      continue;
    }
    pins.push({
      kind: "schedule",
      id: item.id,
      workflowVersionId: item.workflowVersionId,
      status: item.status === "disabled" ? "disabled" : "enabled",
      label: scheduleExpressionLabel(item),
    });
  }
  return pins;
}

export function pinsForPublishedVersion(
  pins: readonly EditorActivationPin[],
  versionId: string | null | undefined,
): EditorActivationPin[] {
  if (!isResourceId(versionId ?? undefined) || isDraftRunSelection(versionId)) {
    return [];
  }
  return pins.filter((pin) => pin.workflowVersionId === versionId);
}

export function defaultActivationVersionId(input: {
  versions: readonly WorkflowVersion[] | null | undefined;
  pins?: readonly EditorActivationPin[] | null;
  selectedVersionId?: string | null;
}): string | null {
  const published = publishedActivationVersions(input.versions);
  if (
    input.selectedVersionId &&
    published.some((version) => version.id === input.selectedVersionId)
  ) {
    return input.selectedVersionId;
  }
  const pins = input.pins ?? [];
  const active = published.find((version) =>
    pins.some(
      (pin) => pin.workflowVersionId === version.id && pin.status === "enabled",
    ),
  );
  return active?.id ?? published[0]?.id ?? null;
}

export function publishedVersionLabel(
  versions: readonly WorkflowVersion[] | null | undefined,
  versionId: string | null | undefined,
): string | null {
  if (!versionId) {
    return null;
  }
  const version = publishedActivationVersions(versions).find(
    (item) => item.id === versionId,
  );
  if (!version) {
    return null;
  }
  return `published v${version.versionNumber}`;
}

export function composeEditorActivation(input: {
  versions: readonly WorkflowVersion[] | null | undefined;
  pins?: readonly EditorActivationPin[] | null;
  webhooks?: readonly WebhookTriggerRecord[] | null;
  schedules?: readonly ScheduleTriggerRecord[] | null;
  selectedVersionId?: string | null;
}): EditorActivationState {
  const published = publishedActivationVersions(input.versions);
  const pins = input.pins ?? activationPinsFromRecords(input);
  const publishedIds = new Set(published.map((version) => version.id));
  const publishedPins = pins.filter((pin) => publishedIds.has(pin.workflowVersionId));
  const workflowActiveVersionIds = [
    ...new Set(
      publishedPins
        .filter((pin) => pin.status === "enabled")
        .map((pin) => pin.workflowVersionId),
    ),
  ];
  const selectedVersionId = defaultActivationVersionId({
    versions: published,
    pins: publishedPins,
    selectedVersionId: input.selectedVersionId,
  });
  const versionPins = pinsForPublishedVersion(publishedPins, selectedVersionId);
  const enabledPins = versionPins.filter((pin) => pin.status === "enabled");
  const disabledPins = versionPins.filter((pin) => pin.status === "disabled");
  const versionLabel = publishedVersionLabel(published, selectedVersionId);

  if (published.length === 0) {
    return {
      kind: "no-published",
      live: false,
      draftLooksLive: false,
      publishedVersionId: null,
      publishedVersionLabel: null,
      workflowActiveVersionIds,
      enabledPins: [],
      disabledPins: [],
      pins: publishedPins,
      label: "Draft — not live",
      help: EDITOR_ACTIVATION_DRAFT_HELP,
      canActivate: false,
      canDeactivate: false,
    };
  }

  if (versionPins.length === 0) {
    return {
      kind: "no-pins",
      live: false,
      draftLooksLive: false,
      publishedVersionId: selectedVersionId,
      publishedVersionLabel: versionLabel,
      workflowActiveVersionIds,
      enabledPins,
      disabledPins,
      pins: publishedPins,
      label: versionLabel
        ? `${versionLabel} is not active`
        : "Not active",
      help: EDITOR_ACTIVATION_NO_PINS_HELP,
      canActivate: false,
      canDeactivate: false,
    };
  }

  if (enabledPins.length === 0) {
    return {
      kind: "inactive",
      live: false,
      draftLooksLive: false,
      publishedVersionId: selectedVersionId,
      publishedVersionLabel: versionLabel,
      workflowActiveVersionIds,
      enabledPins,
      disabledPins,
      pins: publishedPins,
      label: versionLabel
        ? `${versionLabel} is not active`
        : "Not active",
      help:
        workflowActiveVersionIds.length > 0
          ? `${EDITOR_ACTIVATION_INACTIVE_HELP} Another published version is active.`
          : EDITOR_ACTIVATION_INACTIVE_HELP,
      canActivate: true,
      canDeactivate: false,
    };
  }

  return {
    kind: "active",
    live: true,
    draftLooksLive: false,
    publishedVersionId: selectedVersionId,
    publishedVersionLabel: versionLabel,
    workflowActiveVersionIds,
    enabledPins,
    disabledPins,
    pins: publishedPins,
    label: versionLabel
      ? `This ${versionLabel} is active`
      : "This published version is active",
    help: EDITOR_ACTIVATION_ACTIVE_HELP,
    canActivate: disabledPins.length > 0,
    canDeactivate: true,
  };
}

export function composeWorkflowActivation(input: {
  versions: readonly WorkflowVersion[] | null | undefined;
  pins?: readonly EditorActivationPin[] | null;
  webhooks?: readonly WebhookTriggerRecord[] | null;
  schedules?: readonly ScheduleTriggerRecord[] | null;
}): EditorActivationState {
  const pins = input.pins ?? activationPinsFromRecords(input);
  const selectedVersionId = defaultActivationVersionId({
    versions: input.versions,
    pins,
  });
  return composeEditorActivation({
    versions: input.versions,
    pins,
    selectedVersionId,
  });
}

export function editorActivationLooksLive(
  state: Pick<EditorActivationState, "live" | "draftLooksLive" | "kind">,
): boolean {
  return state.live === true && state.draftLooksLive === false && state.kind === "active";
}

export function editorActivationTopBarLabel(
  state: Pick<
    EditorActivationState,
    "kind" | "publishedVersionLabel" | "workflowActiveVersionIds" | "live"
  >,
): string {
  if (state.kind === "no-published") {
    return "Draft — not live";
  }
  if (!state.live || state.workflowActiveVersionIds.length === 0) {
    return "Not active";
  }
  if (state.workflowActiveVersionIds.length > 1) {
    return `Active · ${state.workflowActiveVersionIds.length} published versions`;
  }
  return state.publishedVersionLabel
    ? `Active · ${state.publishedVersionLabel}`
    : "Active";
}

export function activationTogglePlan(
  pins: readonly EditorActivationPin[],
  versionId: string | null | undefined,
  intent: ActivationIntent,
): EditorActivationToggle[] {
  return pinsForPublishedVersion(pins, versionId)
    .filter((pin) =>
      intent === "enable" ? pin.status === "disabled" : pin.status === "enabled",
    )
    .map((pin) => ({
      kind: pin.kind,
      id: pin.id,
      action: intent,
    }));
}

export function editorActivationHref(workflowId: string): string {
  if (!isResourceId(workflowId)) {
    return "/workflows";
  }
  return `/workflows/${workflowId}#${EDITOR_ACTIVATION_HASH}`;
}

export function editorActivationUsesExistingEnableRoutes(): boolean {
  return (
    WEBHOOK_TRIGGER_DEFAULT_ADMIN.enableRoute ===
      "/triggers/{triggerId}/enable" &&
    WEBHOOK_TRIGGER_DEFAULT_ADMIN.disableRoute ===
      "/triggers/{triggerId}/disable" &&
    SCHEDULE_TRIGGER_DEFAULT_ADMIN.enableRoute ===
      "/schedules/{scheduleId}/enable" &&
    SCHEDULE_TRIGGER_DEFAULT_ADMIN.disableRoute ===
      "/schedules/{scheduleId}/disable"
  );
}

export function editorActivationCsrfOnMutations(): boolean {
  return (
    csrfRequiredFor("POST", "/triggers/{triggerId}/enable") &&
    csrfRequiredFor("POST", "/triggers/{triggerId}/disable") &&
    csrfRequiredFor("POST", "/schedules/{scheduleId}/enable") &&
    csrfRequiredFor("POST", "/schedules/{scheduleId}/disable")
  );
}

export function editorActivationInventedRoute(source: string): boolean {
  return INVENTED_ACTIVATION_ROUTES.some((route) => {
    return source.includes(`"${route}"`) || source.includes(`\`${route}\``);
  });
}

export function editorActivationCommonPathUsesHomeDrawers(
  source: string,
): boolean {
  return (
    source.includes("?webhooks=") ||
    source.includes("?schedules=") ||
    source.includes("webhookTriggersHref(") ||
    source.includes("scheduleTriggersHref(")
  );
}

export function editorActivationHomeDrawersStillWork(): boolean {
  return (
    editorWebhookTriggersHref("11111111-1111-4111-8111-111111111111") ===
      "/workflows/11111111-1111-4111-8111-111111111111#webhook-triggers" &&
    editorScheduleTriggersHref("11111111-1111-4111-8111-111111111111") ===
      "/workflows/11111111-1111-4111-8111-111111111111#schedule-triggers"
  );
}

export function notifyEditorActivationChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(EDITOR_ACTIVATION_CHANGED_EVENT));
}

export function subscribeEditorActivationChanged(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener(EDITOR_ACTIVATION_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener(EDITOR_ACTIVATION_CHANGED_EVENT, listener);
  };
}
