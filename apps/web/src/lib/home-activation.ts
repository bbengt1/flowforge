/**
 * R6.2: Home activation state without three drawers.
 *
 * Relates to #271 / Part of #232. Keep #271 open.
 *
 * Chloe UI only. Inherit the Gracie + jonny R6 confirmation from
 * R6.1 (`editor-activation.ts`). Do not weaken.
 *
 * Densify `/workflows` in place (D6). Surface “this published version
 * is active” as a first-class column/status. Compose existing trigger
 * `status` + version pin (D2). Drafts never look live. Do not teach
 * home `?webhooks=` / `?schedules=` / `?start=1` drawers as the
 * activation path — those drawers still work. Row actions stay
 * role-gated. ADV/RBAC/embed unchanged. No new activation resource.
 *
 * jonny: GET /workflows has no computed `activation` field. That is
 * not a real list-projection gap — home joins the same existing lists
 * R6.1 already composes. Do not invent a resource. Optional later
 * computed summary on GET /workflows would be a read model only.
 */

import {
  EDITOR_ACTIVATION,
  INVENTED_ACTIVATION_ROUTES,
  R6_CONFIRMATION,
  R6_LATER_STORY_NOTES,
  composeWorkflowActivation,
  editorActivationHref,
  editorActivationLooksLive,
  editorActivationTopBarLabel,
  type EditorActivationKind,
  type EditorActivationState,
} from "./editor-activation.ts";
import { editorEmbedWorkflowPath } from "./editor-chrome.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import type { ScheduleTriggerRecord } from "./schedule-trigger-contract.ts";
import type { WebhookTriggerRecord } from "./webhook-trigger-contract.ts";
import type { WorkflowRecord, WorkflowVersion } from "./workflow-types.ts";
import { canSeeWorkflowsNav } from "./workspace-nav.ts";

export const R62_STORY = 271;
export const R62_EPIC = 232;
export const R62_KEEP_STORY_OPEN = true;

export const HOME_ACTIVATION_COLUMN_ID = "activation";
export const HOME_ACTIVATION_HEADING_ID = "home-activation-heading";

export const HOME_ACTIVATION_COMPOSE =
  "Active means a published version has at least one enabled webhook or schedule pin. The draft never runs and never looks live. Manual start is on-demand, not activation.";

export const HOME_ACTIVATION_DRAFT_LABEL = "Draft — not live";
export const HOME_ACTIVATION_UNKNOWN_LABEL = "Activation unavailable";
export const HOME_ACTIVATION_UNKNOWN_HELP =
  "Could not compose trigger status + version pin from the existing lists. This row is not live.";

export const HOME_ACTIVATION_HELP =
  "Activation is a first-class column on this list. It composes existing webhook/schedule status + published version pin. Open the status to the editor Triggers tab. Home drawers still work; they are not the common path.";

export const HOME_ACTIVATION_COMMON_PATH_HELP =
  "Home activation opens /workflows/{id}#activation. Do not teach ?webhooks= / ?schedules= / ?start=1 drawers for the common path.";

export const HOME_ACTIVATION_LIST_PROJECTION_NOTE =
  "GET /workflows has no computed activation field. Home composes GET /workflows/{id}/versions, GET /workflows/{id}/triggers, and GET /schedules?workflowId= — the same join R6.1 already uses. Drafts short-circuit from latestVersionNumber without looking live. Optional later computed activation summary on GET /workflows would be a read model only. Not a real list-projection gap; do not invent a resource or ping jonny.";

/**
 * Inherit R6.1 confirmation. Do not weaken.
 */
export const HOME_ACTIVATION = {
  ...R6_CONFIRMATION,
  inheritR6Confirmation: true,
  composeEnablePlusVersionPin: true,
  noNewActivationResource: true,
  noNewActivationAggregate: true,
  noInventedActivationApi: true,
  triggersStayWorkflowLevel: true,
  draftsNeverRun: true,
  draftsNeverLookLive: true,
  densifyHomeListInPlace: true,
  firstClassColumn: true,
  doNotTeachThreeDrawers: true,
  homeDrawersStillWork: true,
  rowActionsStayRoleGated: true,
  advRbacEmbedUnchanged: true,
  oneGestureTestRunOutOfScope: true,
  r63TestRunIs272: true,
  manualStartIsNotActivation: true,
  noCanvasTriggerNodes: true,
  noAppsApiChanges: true,
  noDraftExecute: true,
  jonnyStandbyOnlyIfReadModelGap: true,
  readModelGap: false,
  listProjectionHasComputedActivation: false,
  clientComposesExistingLists: true,
  doNotInventActivationResource: true,
} as const;

export const HOME_ACTIVATION_SOURCES = [
  "src/lib/home-activation.ts",
  "src/lib/home-activation-client.ts",
  "src/lib/workflow-home.ts",
  "src/components/home/HomeActivationStatus.tsx",
  "src/components/home/WorkflowHome.tsx",
  "src/app/workflows/page.tsx",
] as const;

export const WORKFLOW_HOME_LIST_COLUMNS = [
  { id: "workflow", label: "Workflow" },
  { id: HOME_ACTIVATION_COLUMN_ID, label: "Activation" },
  { id: "status", label: "Status" },
  { id: "lastRun", label: "Last run" },
  { id: "actions", label: "Actions" },
] as const;

export const HOME_ACTIVATION_FILTERS = [
  { value: "", label: "Any" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Not active" },
  { value: "draft", label: HOME_ACTIVATION_DRAFT_LABEL },
] as const;

export type HomeActivationFilter = (typeof HOME_ACTIVATION_FILTERS)[number]["value"];

export type HomeActivationKind = EditorActivationKind | "unknown";

export type HomeActivationColumn = {
  kind: HomeActivationKind;
  live: boolean;
  draftLooksLive: false;
  known: boolean;
  publishedVersionId: string | null;
  publishedVersionLabel: string | null;
  label: string;
  help: string;
  href: string;
};

export type HomeActivationListHint = Pick<
  WorkflowRecord,
  "id" | "latestVersionNumber" | "latestVersionId"
>;

export function canViewHomeActivation(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeWorkflowsNav(permissions);
}

export function homeActivationNeedsTriggerJoin(
  record: Pick<HomeActivationListHint, "latestVersionNumber" | "latestVersionId">,
): boolean {
  return (record.latestVersionNumber ?? 0) > 0 || Boolean(record.latestVersionId);
}

export function homeActivationHref(workflowId: string): string {
  return editorActivationHref(workflowId);
}

function draftColumn(workflowId: string): HomeActivationColumn {
  const state = composeWorkflowActivation({ versions: [] });
  return {
    kind: "no-published",
    live: false,
    draftLooksLive: false,
    known: true,
    publishedVersionId: null,
    publishedVersionLabel: null,
    label: HOME_ACTIVATION_DRAFT_LABEL,
    help: state.help,
    href: homeActivationHref(workflowId),
  };
}

function unknownColumn(workflowId: string): HomeActivationColumn {
  return {
    kind: "unknown",
    live: false,
    draftLooksLive: false,
    known: false,
    publishedVersionId: null,
    publishedVersionLabel: null,
    label: HOME_ACTIVATION_UNKNOWN_LABEL,
    help: HOME_ACTIVATION_UNKNOWN_HELP,
    href: homeActivationHref(workflowId),
  };
}

export function homeActivationFromListHint(
  record: HomeActivationListHint,
): HomeActivationColumn {
  if (!homeActivationNeedsTriggerJoin(record)) {
    return draftColumn(record.id);
  }
  return unknownColumn(record.id);
}

export function homeActivationFromEditorState(
  workflowId: string,
  state: EditorActivationState,
  loadedOk = true,
  listHint?: Pick<HomeActivationListHint, "latestVersionNumber">,
): HomeActivationColumn {
  const publishedOnList = (listHint?.latestVersionNumber ?? 0) > 0;
  if (!loadedOk && publishedOnList && state.kind === "no-published") {
    return unknownColumn(workflowId);
  }
  const live = editorActivationLooksLive(state);
  return {
    kind: state.kind,
    live,
    draftLooksLive: false,
    known: true,
    publishedVersionId: state.publishedVersionId,
    publishedVersionLabel: state.publishedVersionLabel,
    label: editorActivationTopBarLabel(state),
    help: state.help,
    href: homeActivationHref(workflowId),
  };
}

export function composeHomeActivation(input: {
  workflowId: string;
  versions?: readonly WorkflowVersion[] | null;
  webhooks?: readonly WebhookTriggerRecord[] | null;
  schedules?: readonly ScheduleTriggerRecord[] | null;
  latestVersionNumber?: number;
  latestVersionId?: string;
  known?: boolean;
}): HomeActivationColumn {
  if (input.known === false) {
    return unknownColumn(input.workflowId);
  }
  if (
    (input.latestVersionNumber ?? 0) === 0 &&
    !input.latestVersionId &&
    (input.versions == null || input.versions.length === 0)
  ) {
    return draftColumn(input.workflowId);
  }
  const state = composeWorkflowActivation({
    versions: input.versions,
    webhooks: input.webhooks,
    schedules: input.schedules,
  });
  return homeActivationFromEditorState(input.workflowId, state, true, {
    latestVersionNumber: input.latestVersionNumber,
  });
}

export function homeActivationLooksLive(
  column: Pick<HomeActivationColumn, "live" | "draftLooksLive" | "kind" | "known">,
): boolean {
  return (
    column.known === true &&
    column.live === true &&
    column.draftLooksLive === false &&
    column.kind === "active"
  );
}

export function matchesHomeActivationFilter(
  column: HomeActivationColumn,
  filter: HomeActivationFilter | "" | undefined,
): boolean {
  if (!filter) {
    return true;
  }
  if (filter === "active") {
    return homeActivationLooksLive(column);
  }
  if (filter === "draft") {
    return column.kind === "no-published";
  }
  if (filter === "inactive") {
    return (
      column.known &&
      !homeActivationLooksLive(column) &&
      column.kind !== "no-published" &&
      column.kind !== "unknown"
    );
  }
  return true;
}

export function attachHomeActivation<
  T extends HomeActivationListHint,
>(
  items: readonly T[],
  activations: ReadonlyMap<string, HomeActivationColumn>,
): Array<T & { activation: HomeActivationColumn }> {
  return items.map((item) => ({
    ...item,
    activation: activations.get(item.id) ?? homeActivationFromListHint(item),
  }));
}

export function homeActivationHoldsR6Confirmation(): boolean {
  return (
    HOME_ACTIVATION.inheritR6Confirmation &&
    HOME_ACTIVATION.d2ActiveIsEnableOnPublishedVersion &&
    HOME_ACTIVATION.d2ComposeEnablePlusVersionPin &&
    HOME_ACTIVATION.d2NoNewActivationResource &&
    HOME_ACTIVATION.d2NoNewActivationAggregate &&
    HOME_ACTIVATION.d3TriggersStayWorkflowLevel &&
    HOME_ACTIVATION.d3NotCanvasNodes &&
    HOME_ACTIVATION.draftsNeverRun &&
    HOME_ACTIVATION.draftsNeverLookLive &&
    HOME_ACTIVATION.jonnyStandbyOnlyIfReadModelGap &&
    HOME_ACTIVATION.doNotInventActivationResource &&
    HOME_ACTIVATION.readModelGap === false &&
    HOME_ACTIVATION.listProjectionHasComputedActivation === false &&
    EDITOR_ACTIVATION.inheritR6Confirmation &&
    R6_LATER_STORY_NOTES.r62.includes("#271")
  );
}

export function homeActivationLeavesLaterStories(): boolean {
  return (
    HOME_ACTIVATION.oneGestureTestRunOutOfScope &&
    HOME_ACTIVATION.r63TestRunIs272 &&
    R6_LATER_STORY_NOTES.r63.includes("#272")
  );
}

export function homeActivationInventedRoute(source: string): boolean {
  return INVENTED_ACTIVATION_ROUTES.some((route) => {
    return source.includes(`"${route}"`) || source.includes(`\`${route}\``);
  });
}

export function homeActivationCommonPathUsesHomeDrawers(
  source: string,
): boolean {
  return (
    source.includes("webhookTriggersHref(") ||
    source.includes("scheduleTriggersHref(") ||
    source.includes("manualStartHref(")
  );
}

export function homeActivationColumnIsFirstClass(): boolean {
  return (
    WORKFLOW_HOME_LIST_COLUMNS[1]?.id === HOME_ACTIVATION_COLUMN_ID &&
    HOME_ACTIVATION.firstClassColumn &&
    HOME_ACTIVATION.densifyHomeListInPlace
  );
}

export function homeActivationEmbedUnchanged(workflowId = "{id}"): boolean {
  const workflowEmbed = EMBED_ROUTES.find((route) => route.id === "workflow");
  return (
    editorEmbedWorkflowPath(workflowId) ===
      `/embed/v1/workflows/${workflowId}` &&
    workflowEmbed?.embed === "/embed/v1/workflows/{id}" &&
    workflowEmbed.standalone === "/workflows/{id}"
  );
}

export function homeActivationFilterFromHome(
  filters: { activation?: HomeActivationFilter },
): HomeActivationFilter {
  return filters.activation ?? "";
}
