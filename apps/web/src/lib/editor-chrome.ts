/**
 * UX.1 canvas-first editor chrome.
 *
 * Relates to #196 / Part of #195. Keep #196 open until merge.
 *
 * Layout-only: YAML stays the persisted definition, drafts never run,
 * triggers stay workflow-level, embed still uses the existing
 * `/embed/v1` rewrite + `session.embed`. No new routes or API calls.
 */

import { EMBED_MOUNT_PREFIX, EMBED_ROUTES, standalonePathFromEmbed } from "./embed-contract.ts";
import { workspaceLookupKey, type DevIdentity } from "./identity-headers.ts";
import { canSaveWorkflowEditor } from "./workflow-graph.ts";
import { canStartPublishedRun, publishedRunVersions } from "./execution-replay.ts";
import type { WorkflowFieldError, WorkflowVersion } from "./workflow-types.ts";

export const UX1_STORY = 196;
export const UX1_EPIC = 195;
export const UX1_KEEP_STORY_OPEN = true;

export const EDITOR_WORKFLOWS_HREF = "/workflows";
export const EDITOR_YAML_OPEN_ON_FIRST_PAINT = false;
/** R2.1: first paint opens the library unless a remembered preference says otherwise. */
export const EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT = true;
export const EDITOR_HEADING_FALLBACK = "Workflow editor";

export const EDITOR_CHROME = {
  yamlHiddenOnFirstPaint: true,
  libraryHiddenOnFirstPaint: false,
  inspectorHiddenOnFirstPaint: false,
  workflowListInEditor: false,
  createImportOnWorkflowsHome: true,
  publishLastSavedDraftOnly: true,
  startPublishedVersionsOnly: true,
  draftsCannotStart: true,
  invalidYamlNeverGuessesGraph: true,
  saveNormalizesThenPutsDraft: true,
  noNewEmbedRoutes: true,
  hostQueryNotAuthorization: true,
  keyboard: {
    skipLink: true,
    canvasFocus: true,
    zoomShortcuts: true,
    wizardEscape: true,
    undoRedo: true,
    multiSelectFitSnap: true,
  },
} as const;

export function editorHeading(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : EDITOR_HEADING_FALLBACK;
}

export function editorDirtyLabel(dirty: boolean): "Unsaved" | "Saved" {
  return dirty ? "Unsaved" : "Saved";
}

export function editorRevisionLabel(revision: number | null | undefined): string {
  return `revision ${revision ?? "—"}`;
}

export function canPublishLastSavedDraft(input: {
  dirty: boolean;
  hasWorkflow: boolean;
  revision: number | null;
}): boolean {
  return input.hasWorkflow && input.revision !== null && !input.dirty;
}

export function canSaveDraftFromChrome(input: {
  status: "idle" | "pending" | "valid" | "invalid";
  errors: WorkflowFieldError[];
  localErrors?: string[];
  hasWorkflow: boolean;
  revision: number | null;
}): boolean {
  return (
    input.hasWorkflow &&
    input.revision !== null &&
    canSaveWorkflowEditor({
      status: input.status,
      errors: input.errors,
      localErrors: input.localErrors,
    })
  );
}

export function editorStartVersions(versions: WorkflowVersion[]): WorkflowVersion[] {
  return publishedRunVersions(versions);
}

export function editorCanStartPublished(input: {
  versions: WorkflowVersion[];
  selectedVersionId: string;
}): boolean {
  return canStartPublishedRun(input).ok;
}

export function editorEmbedWorkflowPath(workflowId = "{id}"): string {
  return `${EMBED_MOUNT_PREFIX}/workflows/${workflowId}`;
}

export function editorEmbedRouteUnchanged(): boolean {
  const route = EMBED_ROUTES.find((item) => item.id === "workflow");
  return (
    route?.standalone === "/workflows/{id}" &&
    route.embed === editorEmbedWorkflowPath()
  );
}

/**
 * UX.5: sticky workflow context + collapsed workspace nav on the
 * editor route. Relates to #200 / Part of #195. Keep #200 open.
 *
 * Commands and the top bar bind to the route id — not a home list
 * selection. Standalone workspace switch remounts the editor the
 * same way /workflows already drops previous-workspace state.
 */
export const UX5_STORY = 200;
export const UX5_EPIC = 195;
export const UX5_KEEP_STORY_OPEN = true;

export type EditorNavMode = "icon-rail" | "overlay" | "full";

export const EDITOR_NAV_RAIL_WIDTH = "3.5rem";
export const EDITOR_NAV_OVERLAY_WIDTH = "16rem";

export const EDITOR_NAV = {
  editorRouteCollapsesNav: true,
  editorNavModes: ["icon-rail", "overlay"] as const,
  workflowsIsHome: true,
  gatedHiddenWhenUnknownOrDenied: true,
  standaloneWorkspaceSwitchDropsEditorState: true,
  commandsApplyToRouteId: true,
  embedSwitcherLocked: true,
  embedNavRemapsToEmbedV1: true,
  adv024OmittedWithoutGrant: true,
  noNewEmbedRoutes: true,
} as const;

const EDITOR_PATH_ID = /^\/workflows\/([^/]+)$/;

/** Route id from standalone or embed `/workflows/{id}`. Not a list selection. */
export function editorWorkflowIdFromPath(
  pathname: string | null | undefined,
): string | undefined {
  if (!pathname) {
    return undefined;
  }
  const standalone = standalonePathFromEmbed(pathname.split("?")[0] ?? pathname);
  const match = standalone.match(EDITOR_PATH_ID);
  const id = match?.[1]?.trim();
  if (!id || id === "new") {
    return undefined;
  }
  return id;
}

export function isWorkflowEditorPath(
  pathname: string | null | undefined,
): boolean {
  return editorWorkflowIdFromPath(pathname) !== undefined;
}

export function editorNavMode(input: {
  pathname: string | null | undefined;
  overlayOpen?: boolean;
  compact?: boolean;
}): EditorNavMode {
  if (!isWorkflowEditorPath(input.pathname)) {
    return "full";
  }
  if (input.compact || input.overlayOpen) {
    return "overlay";
  }
  return "icon-rail";
}

export function editorWorkspaceSessionKey(
  identity: DevIdentity,
  workflowId?: string | null,
): string {
  return `${workspaceLookupKey(identity)}:${workflowId?.trim() ?? ""}`;
}

export function editorCommandAppliesToRoute(
  routeWorkflowId: string | null | undefined,
  commandWorkflowId: string | null | undefined,
): boolean {
  const route = routeWorkflowId?.trim();
  const command = commandWorkflowId?.trim();
  return Boolean(route && command && route === command);
}

export type EditorStickyContext = {
  heading: string;
  status: string;
  slug?: string;
  loaded: boolean;
};

export function editorStickyContext(
  workflow: {
    name?: string | null;
    slug?: string | null;
    status?: string | null;
  } | null,
  options: { loaded?: boolean } = {},
): EditorStickyContext {
  const loaded = options.loaded === true;
  if (!loaded) {
    return {
      heading: EDITOR_HEADING_FALLBACK,
      status: "Loading…",
      loaded: false,
    };
  }
  if (!workflow) {
    return {
      heading: EDITOR_HEADING_FALLBACK,
      status: "Unavailable",
      loaded: true,
    };
  }
  return {
    heading: editorHeading(workflow.name),
    status: (workflow.status ?? "").trim() || "draft",
    slug: workflow.slug?.trim() || undefined,
    loaded: true,
  };
}
