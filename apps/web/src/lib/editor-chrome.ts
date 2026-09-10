/**
 * UX.1 canvas-first editor chrome.
 *
 * Relates to #196 / Part of #195. Keep #196 open until merge.
 *
 * Layout-only: YAML stays the persisted definition, drafts never run,
 * triggers stay workflow-level, embed still uses the existing
 * `/embed/v1` rewrite + `session.embed`. No new routes or API calls.
 */

import { EMBED_MOUNT_PREFIX, EMBED_ROUTES } from "./embed-contract.ts";
import { canSaveWorkflowEditor } from "./workflow-graph.ts";
import { canStartPublishedRun, publishedRunVersions } from "./execution-replay.ts";
import type { WorkflowFieldError, WorkflowVersion } from "./workflow-types.ts";

export const UX1_STORY = 196;
export const UX1_EPIC = 195;
export const UX1_KEEP_STORY_OPEN = true;

export const EDITOR_WORKFLOWS_HREF = "/workflows";
export const EDITOR_YAML_OPEN_ON_FIRST_PAINT = false;
export const EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT = true;
export const EDITOR_HEADING_FALLBACK = "Workflow editor";

export const EDITOR_CHROME = {
  yamlHiddenOnFirstPaint: true,
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
