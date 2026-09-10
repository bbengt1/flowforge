/**
 * UX.3: action library as a left drawer; canvas + / Add action
 * open the existing palette or wizard.
 *
 * Relates to #198 / Part of #195. Keep #198 open until merge.
 *
 * Chloe UI only. Reuses ActionLibrary + ActionWizard — no third
 * catalog app, no API changes, no invented INTEGRATION_ACTIONS_ENABLED
 * toggle. 403 / empty catalog still fail closed.
 */

import { EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT } from "./editor-chrome.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import {
  filterEnabledActionNodes,
  isTriggerActionType,
  rejectDisabledActionType,
} from "./workflow-action-library.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";
import { paletteCommands } from "./command-palette.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

export const UX3_STORY = 198;
export const UX3_EPIC = 195;
export const UX3_KEEP_STORY_OPEN = true;

export const EDITOR_LIBRARY_COLUMN_WIDTH = "18rem";
export const EDITOR_LIBRARY_PANEL_ID = "editor-library-panel";
export const ACTIONS_CATALOG_HREF = "/actions";

export { EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT };

export const EDITOR_LIBRARY = {
  hiddenOnFirstPaint: true,
  columnWidth: EDITOR_LIBRARY_COLUMN_WIDTH,
  plusOpensLibrary: true,
  addActionOpensWizard: true,
  dragInsertDefaultsAllowed: true,
  enabledCatalogOnly: true,
  triggersExcluded: true,
  actionsRouteIsCatalogReference: true,
  noThirdCatalogApp: true,
  paletteSearchStripsSecrets: true,
  catalog403FailsClosed: true,
  emptyCatalogFailsClosed: true,
  noIntegrationActionsEnabledToggle: true,
} as const;

export type CanvasAddAffordance = {
  emptyPlus: boolean;
  selectedPlus: boolean;
  addAction: boolean;
};

export function canvasAddAffordance(input: {
  invalid: boolean;
  readOnly?: boolean;
  nodeCount: number;
  selectedKind?: "workflow" | "node" | "edge";
}): CanvasAddAffordance {
  if (input.readOnly || input.invalid) {
    return { emptyPlus: false, selectedPlus: false, addAction: false };
  }
  return {
    emptyPlus: input.nodeCount === 0,
    selectedPlus: input.selectedKind === "node",
    addAction: true,
  };
}

export function actionsNavIsCatalogReference(): boolean {
  const actions = WORKSPACE_NAV_ITEMS.find((item) => item.id === "actions");
  return Boolean(
    actions &&
      actions.href === ACTIONS_CATALOG_HREF &&
      actions.placeholder !== true,
  );
}

export function actionsCommandIsCatalogReference(): boolean {
  const command = paletteCommands(["workflow.view"]).find(
    (item) => item.id === "nav-actions",
  );
  if (!command || command.action.type !== "navigate") {
    return false;
  }
  return (
    command.action.href === ACTIONS_CATALOG_HREF &&
    !command.hint.toLowerCase().includes("placeholder") &&
    !command.hint.toLowerCase().includes("soon")
  );
}

export function actionsEmbedRouteUnchanged(): boolean {
  const matches = EMBED_ROUTES.filter((item) => item.id === "actions");
  return (
    matches.length === 1 &&
    matches[0]?.standalone === ACTIONS_CATALOG_HREF &&
    matches[0]?.embed === "/embed/v1/actions"
  );
}

export function catalogLibraryFailsClosed(
  catalog: WorkflowCatalog | null | undefined,
): boolean {
  const enabled = filterEnabledActionNodes(catalog?.nodes);
  if (enabled.some((item) => isTriggerActionType(item.type))) {
    return false;
  }
  if (rejectDisabledActionType("manual", catalog).ok) {
    return false;
  }
  return enabled.every((item) => item.phase === "core" || item.enabled === true);
}
