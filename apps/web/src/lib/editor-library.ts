/**
 * UX.3 + R2.1: action library as a left drawer that stays available
 * without a scavenger hunt (remembered-open + persistent satellite).
 *
 * Relates to #234 / Part of #228. Keep #234 open until merge.
 * Relates to #198 / Part of #195 (UX.3 drawer + Add action / +).
 *
 * Chloe UI only. Reuses ActionLibrary + ActionWizard — no third
 * catalog app, no API changes, no invented INTEGRATION_ACTIONS_ENABLED
 * toggle. 403 / empty catalog still fail closed. Preference is a
 * non-secret "1"/"0" chrome flag (never credentials or YAML).
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

export const R21_STORY = 234;
export const R21_EPIC = 228;
export const R21_KEEP_STORY_OPEN = true;

export const EDITOR_LIBRARY_COLUMN_WIDTH = "18rem";
export const EDITOR_LIBRARY_SATELLITE_WIDTH = "2.75rem";
export const EDITOR_LIBRARY_PANEL_ID = "editor-library-panel";
export const EDITOR_LIBRARY_SATELLITE_ID = "editor-library-satellite";
export const EDITOR_LIBRARY_OPEN_STORAGE_KEY =
  "flowforge.editor.library-open.v1";
export const EDITOR_LIBRARY_DEFAULT_OPEN = EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT;
export const ACTIONS_CATALOG_HREF = "/actions";

export { EDITOR_LIBRARY_OPEN_ON_FIRST_PAINT };

export const EDITOR_LIBRARY = {
  hiddenOnFirstPaint: false,
  rememberedOpen: true,
  persistentSatellite: true,
  defaultOpen: true,
  staysOpenAcrossInserts: true,
  columnWidth: EDITOR_LIBRARY_COLUMN_WIDTH,
  satelliteWidth: EDITOR_LIBRARY_SATELLITE_WIDTH,
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
  preferenceStoresOpenFlagOnly: true,
} as const;

export type LibraryChromeMode = "drawer" | "satellite";

export type CanvasAddAffordance = {
  emptyPlus: boolean;
  selectedPlus: boolean;
  addAction: boolean;
};

const listeners = new Set<() => void>();

function emitLibraryOpenPreference() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeLibraryOpenPreference(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stored chrome flag is only "1" / "0". Anything else is treated as missing. */
export function parseLibraryOpenPreference(
  raw: string | null | undefined,
): boolean | null {
  if (raw === "1") {
    return true;
  }
  if (raw === "0") {
    return false;
  }
  return null;
}

export function rememberedLibraryOpen(
  stored: boolean | null,
  fallback = EDITOR_LIBRARY_DEFAULT_OPEN,
): boolean {
  return stored === null ? fallback : stored;
}

export function readLibraryOpenPreference(): boolean {
  if (typeof sessionStorage === "undefined") {
    return EDITOR_LIBRARY_DEFAULT_OPEN;
  }
  try {
    return rememberedLibraryOpen(
      parseLibraryOpenPreference(
        sessionStorage.getItem(EDITOR_LIBRARY_OPEN_STORAGE_KEY),
      ),
    );
  } catch {
    return EDITOR_LIBRARY_DEFAULT_OPEN;
  }
}

export function rememberLibraryOpen(open: boolean): void {
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(
        EDITOR_LIBRARY_OPEN_STORAGE_KEY,
        open ? "1" : "0",
      );
    } catch {
      // Private mode / quota — in-memory subscribers still update.
    }
  }
  emitLibraryOpenPreference();
}

/** Closed library is still a satellite — never hide-by-default only. */
export function libraryChromeMode(open: boolean): LibraryChromeMode {
  return open ? "drawer" : "satellite";
}

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
