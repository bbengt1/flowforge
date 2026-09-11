/**
 * R2.2: NDV-style inspector shell as an editor satellite.
 *
 * Relates to #235 / Part of #228. Keep #235 open until merge.
 *
 * Chloe UI only. Selected node focuses a FlowForge inspector
 * conversation (parameters / `with` / pins / credential display-name)
 * that stays available without a scavenger hunt (remembered-open +
 * persistent satellite). Wizard remains guided add; inspector is edit.
 * No SecretField in the rail. No expression language. Workflow-level
 * Triggers / Versions / Pins tabs remain. Embed path unchanged.
 *
 * Type-specific parameter editors are R3.1 / #246 (keep #246 open).
 * Typed field-path mapping is R3.2 / #247 (keep #247 open). Preference
 * is a non-secret "1"/"0" chrome flag (never credentials or YAML). Do
 * not brand the rail "NDV" — that term is a parity reference only.
 */

import { EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT } from "./e12-accessibility-contract.ts";
import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import {
  EDITOR_INSPECTOR,
  inspectorFocus,
  type InspectorFocus,
} from "./editor-inspector.ts";
import { WORKFLOW_INSPECTOR_TABS } from "./editor-workflow-inspector.ts";

export const R22_STORY = 235;
export const R22_EPIC = 228;
export const R22_KEEP_STORY_OPEN = true;

export const EDITOR_NDV_COLUMN_WIDTH = "20rem";
export const EDITOR_NDV_SATELLITE_WIDTH = "2.75rem";
export const EDITOR_NDV_SATELLITE_ID = "editor-inspector-satellite";
export const EDITOR_NDV_SHELL_ID = "editor-ndv-shell";
export const EDITOR_NDV_HEADING_ID = "ndv-shell-heading";
export const EDITOR_NDV_OPEN_STORAGE_KEY =
  "flowforge.editor.inspector-open.v1";
export const EDITOR_NDV_DEFAULT_OPEN = EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT;
export const EDITOR_NDV_SATELLITE_LABEL = "Inspector";

export { EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT };

export const EDITOR_NDV_PANELS = [
  "parameters",
  "mapping",
  "pins",
  "credentials",
  "last-run",
  "validation",
] as const;

export type NdvShellPanel = (typeof EDITOR_NDV_PANELS)[number];
export type NdvChromeMode = "drawer" | "satellite";

export const EDITOR_NDV = {
  hiddenOnFirstPaint: false,
  rememberedOpen: true,
  persistentSatellite: true,
  defaultOpen: true,
  selectedNodeFocusesShell: true,
  wizardIsAdd: true,
  inspectorIsEdit: true,
  parametersWithPinsCredentialDisplayName: true,
  noSecretFieldInRail: true,
  noExpressionLanguage: true,
  noBrandedNdvInUi: true,
  workflowTabsRemain: true,
  embedPathUnchanged: true,
  deepMappingIsR3: false,
  typedFieldPathMapping: true,
  noAppsApiChanges: true,
  preferenceStoresOpenFlagOnly: true,
  columnWidth: EDITOR_NDV_COLUMN_WIDTH,
  satelliteWidth: EDITOR_NDV_SATELLITE_WIDTH,
} as const;

const listeners = new Set<() => void>();

function emitInspectorOpenPreference() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeInspectorOpenPreference(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stored chrome flag is only "1" / "0". Anything else is treated as missing. */
export function parseInspectorOpenPreference(
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

export function rememberedInspectorOpen(
  stored: boolean | null,
  fallback = EDITOR_NDV_DEFAULT_OPEN,
): boolean {
  return stored === null ? fallback : stored;
}

export function readInspectorOpenPreference(): boolean {
  if (typeof sessionStorage === "undefined") {
    return EDITOR_NDV_DEFAULT_OPEN;
  }
  try {
    return rememberedInspectorOpen(
      parseInspectorOpenPreference(
        sessionStorage.getItem(EDITOR_NDV_OPEN_STORAGE_KEY),
      ),
    );
  } catch {
    return EDITOR_NDV_DEFAULT_OPEN;
  }
}

export function rememberInspectorOpen(open: boolean): void {
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(
        EDITOR_NDV_OPEN_STORAGE_KEY,
        open ? "1" : "0",
      );
    } catch {
      // Private mode / quota — in-memory subscribers still update.
    }
  }
  emitInspectorOpenPreference();
}

/** Closed inspector is still a satellite — never hide-by-default only. */
export function ndvChromeMode(open: boolean): NdvChromeMode {
  return open ? "drawer" : "satellite";
}

export function ndvFocusesOnSelection(kind: InspectorFocus): boolean {
  return kind === "node" || kind === "edge";
}

export function rememberInspectorFocus(
  selection: { kind: InspectorFocus } | null | undefined,
): void {
  if (ndvFocusesOnSelection(inspectorFocus(selection))) {
    rememberInspectorOpen(true);
  }
}

export function ndvSatelliteLabel(): string {
  return EDITOR_NDV_SATELLITE_LABEL;
}

export function ndvConversationEyebrow(focus: InspectorFocus): string {
  if (focus === "node") {
    return "This step";
  }
  if (focus === "edge") {
    return "Connection";
  }
  return "Workflow";
}

export function ndvConversationTitle(
  focus: InspectorFocus,
  node?: { name?: string | null; id?: string | null } | null,
): string {
  if (focus === "node") {
    const name = node?.name?.trim();
    if (name) {
      return name;
    }
    return node?.id?.trim() || "Selected node";
  }
  if (focus === "edge") {
    return "Port compatibility";
  }
  return "Workflow";
}

export function ndvConversationHelp(focus: InspectorFocus): string {
  if (focus === "node") {
    return "Inspector edits this step. Add action stays the guided wizard. Type-specific parameters, typed field-path mapping, pins, credential display names (add without leaving the graph), and validation/policy — no SecretField and no expression language.";
  }
  if (focus === "edge") {
    return "Inspector explains port compatibility and typed field-path mapping. Incompatible mappings are blocked. Edges stay nodeId.port.";
  }
  return "Triggers, versions, and pins stay on the workflow. They are not canvas nodes.";
}

export function ndvWizardStaysAdd(): boolean {
  return EDITOR_NDV.wizardIsAdd && EDITOR_INSPECTOR.wizardIsAdd;
}

export function ndvInspectorIsEdit(): boolean {
  return EDITOR_NDV.inspectorIsEdit && EDITOR_INSPECTOR.inspectorIsEdit;
}

export function ndvWorkflowTabsRemain(): boolean {
  return (
    EDITOR_NDV.workflowTabsRemain &&
    WORKFLOW_INSPECTOR_TABS[0] === "triggers" &&
    WORKFLOW_INSPECTOR_TABS[1] === "versions" &&
    WORKFLOW_INSPECTOR_TABS[2] === "pins"
  );
}

export function ndvEmbedPathUnchanged(): boolean {
  return EDITOR_NDV.embedPathUnchanged && editorEmbedRouteUnchanged();
}

export function ndvForbidsBrandedLabel(source: string): boolean {
  return !/\bNDV\b/.test(source);
}
