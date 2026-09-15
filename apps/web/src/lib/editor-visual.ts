/**
 * V.4: Editor chrome.
 *
 * Relates to #360 / Part of #353. Keep #360 open.
 *
 * Chloe UI only. Dark canvas + satellite chrome on the V.1 token
 * tree and V.2 shell (docs/architecture/flowforge-visual-ia-north-star.md
 * § editor / V.4). Standalone and `/embed/v1` share the same
 * EditorChrome / EditorTopBar / WorkflowCanvas. No second theme.
 * No n8n orange or branded NDV clone.
 *
 * Surfaces: `/workflows/{id}` + embed. UXL.1–UXL.4 / UXL.7 grouping
 * and working memory stay. Invalid YAML still does not guess a
 * graph. Drafts still never run. One overlay. Loud `indeterminate`.
 * Save / Publish / Test run / canvas **+** stay full-size (Fitts).
 * Selection uses one accent ring. Nodes: family shape + icon +
 * label; clear ports. Triggers stay workflow-level (D3).
 *
 * Hard lines: YAML SoT · drafts never run · ADV-021/024 · vault
 * display-name+UUID · not an n8n clone · no KEK · D3 triggers
 * workflow-level (not on canvas).
 */

import { AESTHETIC_USABILITY } from "./aesthetic-usability-density.ts";
import { DOHERTY_PENDING_CHROME } from "./doherty-pending-chrome.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { EDITOR_LIBRARY } from "./editor-library.ts";
import { EDITOR_NDV } from "./editor-ndv.ts";
import { EDITOR_RUNS } from "./editor-runs.ts";
import {
  EDITOR_CANVAS_PLUS_FITTS,
  EDITOR_TOPBAR_CHUNKING,
  EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS,
  UXL1_KEEP_STORY_OPEN,
  editorTopBarDraftsNeverRun,
  editorTopBarHasThreeGroups,
  editorTopBarSerialPosition,
} from "./editor-topbar-chunking.ts";
import { EDITOR_WORKING_MEMORY } from "./editor-working-memory.ts";
import { PALETTE_CATEGORY_FIRST } from "./palette-category-first.ts";
import { PEAK_END_OPERATE } from "./peak-end-operate-endings.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  FF_ACCENT,
  FF_CANVAS,
  FF_SURFACE,
  FORBIDDEN_THEME_TREES,
  N8N_ORANGE_TOKENS,
  VISUAL_TOKENS,
  n8nOrangePresent,
  secondThemeTreePresent,
} from "./visual-tokens.ts";
import type { ActionFamily } from "./workflow-action-library.ts";

export const V4_STORY = 360;
export const V4_EPIC = 353;
export const V4_KEEP_STORY_OPEN = true;
export const V4_ID = "V.4-editor-chrome" as const;
export const V4_BRIEF = "docs/architecture/flowforge-visual-ia-north-star.md";
export const V4_TOKEN_FILE = "src/app/tokens.css";

export const V4_HELP =
  "Dark canvas + satellite chrome (palette / Inspector / Runs) using V.1 tokens and V.2 shell. UXL.1–UXL.4 / UXL.7 grouping and working memory stay. Invalid YAML still does not guess a graph. Drafts still never run. One overlay. Loud indeterminate. Save / Publish / Test run / canvas + stay full-size. Selection uses one accent ring. Nodes: family shape + icon + label; clear ports. Not an n8n NDV clone.";

export const EDITOR_VISUAL = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  inheritV2Shell: true,
  inheritUxl1TopBarGroups: true,
  inheritUxl2WorkingMemory: true,
  inheritUxl3DohertyPending: true,
  inheritUxl4PeakEnd: true,
  inheritUxl7CategoryFirstPalette: true,
  inheritUxl8SatelliteAlignment: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  darkCanvas: true,
  darkSatelliteChrome: true,
  paletteSatellite: true,
  inspectorSatelliteNotBrandedNdv: true,
  runsSatellite: true,
  oneAccentSelectionRing: true,
  nodesFamilyShapeIconLabel: true,
  clearPorts: true,
  noRainbowCategoryChips: true,
  savePublishTestRunCanvasPlusFullSize: true,
  fittsDoNotShrinkPrimary: true,
  fittsDoNotShrinkCanvasPlus: true,
  invalidYamlNeverGuessesGraph: true,
  draftsNeverRun: true,
  oneOverlay: true,
  loudIndeterminate: true,
  d3TriggersAreWorkflowLevel: true,
  noCanvasTriggerNodes: true,
  oneAccent: true,
  accentIsTealFamily: true,
  noSecondThemeTree: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  notAnN8nNdvClone: true,
  yamlIsSourceOfTruth: true,
  vaultDisplayNameUuidOnly: true,
  noKekInBrowser: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  noGreenfieldApis: true,
  keep360Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_EDITOR_ATTR = "data-ff-editor";
export const FF_EDITOR_VALUE = "v4";

export const FF_EDITOR_ROOT_CLASS = "ff-editor";
export const FF_EDITOR_CANVAS_CLASS = "ff-editor-canvas";
export const FF_EDITOR_GRID_CLASS = "ff-editor-grid";
export const FF_EDITOR_TOPBAR_CLASS = "ff-editor-topbar";
export const FF_EDITOR_SATELLITE_CLASS = "ff-editor-satellite";
export const FF_EDITOR_SATELLITE_HEADER_CLASS = "ff-editor-satellite-header";
export const FF_EDITOR_PANEL_CLASS = "ff-editor-panel";
export const FF_EDITOR_PRIMARY_CLASS = "ff-editor-primary";
export const FF_EDITOR_GHOST_CLASS = "ff-editor-ghost";
export const FF_EDITOR_CONTROL_CLASS = "ff-editor-control";
export const FF_EDITOR_MUTED_CLASS = "ff-editor-muted";
export const FF_EDITOR_TITLE_CLASS = "ff-editor-title";
export const FF_EDITOR_LINK_CLASS = "ff-editor-link";
export const FF_EDITOR_RAIL_BUTTON_CLASS = "ff-editor-rail-button";
export const FF_EDITOR_CHIP_CLASS = "ff-editor-chip";
export const FF_EDITOR_CHIP_ACCENT_CLASS = "ff-editor-chip-accent";
export const FF_EDITOR_NODE_CLASS = "ff-editor-node";
export const FF_EDITOR_NODE_SELECTED_CLASS = "ff-editor-node-selected";
export const FF_EDITOR_PORT_CLASS = "ff-editor-port";
export const FF_EDITOR_PLUS_CLASS = "ff-editor-plus";
export const FF_EDITOR_INVALID_CLASS = "ff-editor-invalid";
export const FF_EDITOR_BANNER_CLASS = "ff-editor-banner";
export const FF_EDITOR_DIVIDER_CLASS = "ff-editor-divider";
export const FF_EDITOR_DANGER_CLASS = "ff-editor-danger";

export const EDITOR_NODE_FAMILY_MARKS: Record<ActionFamily, string> = {
  control: "Cf",
  data: "Dt",
  lifecycle: "Lc",
  kubernetes: "Ks",
  ssh: "Sh",
  script: "Sc",
  http: "Ht",
  notification: "Nt",
  other: "Ac",
};

export const EDITOR_NODE_FAMILY_SHAPE_CLASS: Record<ActionFamily, string> = {
  control: "ff-editor-node-family-control",
  data: "ff-editor-node-family-data",
  lifecycle: "ff-editor-node-family-lifecycle",
  kubernetes: "ff-editor-node-family-kubernetes",
  ssh: "ff-editor-node-family-ssh",
  script: "ff-editor-node-family-script",
  http: "ff-editor-node-family-http",
  notification: "ff-editor-node-family-notification",
  other: "ff-editor-node-family-other",
};

export const V4_SOURCES = [
  "src/lib/editor-visual.ts",
  "src/lib/editor-chrome.ts",
  "src/lib/editor-topbar-chunking.ts",
  "src/lib/aesthetic-usability-density.ts",
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/WorkflowCanvas.tsx",
  "src/components/workflows/ActionLibrary.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/workflows/EditorYamlDrawer.tsx",
  "src/components/workflows/EditorActivationChrome.tsx",
  "src/app/globals.css",
] as const;

export const V4_CHROME_SOURCES = [
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/WorkflowCanvas.tsx",
  "src/components/workflows/ActionLibrary.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/EditorRunsDrawer.tsx",
  "src/components/workflows/EditorYamlDrawer.tsx",
  "src/components/workflows/EditorActivationChrome.tsx",
  "src/app/globals.css",
] as const;

export const LIGHT_EDITOR_TOKENS = [
  "bg-white",
  "bg-white/80",
  "bg-white/95",
  "bg-white/60",
  "border-zinc-200",
  "border-zinc-300",
  "bg-zinc-50",
  "bg-zinc-100",
  "bg-teal-50",
  "text-zinc-900",
  "text-teal-950",
  "#f6f5f1",
  "#e4e4e7",
] as const;

export const N8N_NDV_CLONE_TOKENS = [
  "Node Detail View",
  "n8n-nodes-base",
  "wf-node-default",
  "Execute workflow",
  "n8n-logo",
] as const;

export const RAINBOW_PALETTE_TOKENS = [
  "bg-rose-200",
  "bg-orange-200",
  "bg-yellow-200",
  "bg-lime-200",
  "bg-sky-200",
  "bg-violet-200",
  "rainbow",
] as const;

export function editorNodeFamilyMark(family: ActionFamily): string {
  return EDITOR_NODE_FAMILY_MARKS[family];
}

export function editorNodeFamilyShapeClass(family: ActionFamily): string {
  return EDITOR_NODE_FAMILY_SHAPE_CLASS[family];
}

export function editorUsesV1TokenClasses(globals: string): boolean {
  return (
    globals.includes(`.${FF_EDITOR_CANVAS_CLASS}`) &&
    globals.includes(`.${FF_EDITOR_GRID_CLASS}`) &&
    globals.includes(`.${FF_EDITOR_TOPBAR_CLASS}`) &&
    globals.includes(`.${FF_EDITOR_SATELLITE_CLASS}`) &&
    globals.includes(`.${FF_EDITOR_NODE_SELECTED_CLASS}`) &&
    globals.includes(`.${FF_EDITOR_PLUS_CLASS}`) &&
    globals.includes("background: var(--ff-canvas)") &&
    globals.includes("background: var(--ff-surface)") &&
    globals.includes("background: var(--ff-accent)") &&
    globals.includes("color: var(--ff-accent-foreground)") &&
    globals.includes("var(--ff-text)") &&
    globals.includes("var(--ff-muted)") &&
    globals.includes("var(--ff-border)") &&
    globals.includes("box-shadow: 0 0 0 2px var(--ff-accent)")
  );
}

export function editorChromeRejectsLightLook(source: string): boolean {
  return LIGHT_EDITOR_TOKENS.every((token) => !source.includes(token));
}

export function editorRejectsN8nNdvClone(source: string): boolean {
  return N8N_NDV_CLONE_TOKENS.every((token) => !source.includes(token));
}

export function editorRejectsRainbowPalette(source: string): boolean {
  return RAINBOW_PALETTE_TOKENS.every((token) => !source.includes(token));
}

export function editorUxlBehaviorsHeld(input: {
  topBar: string;
  canvas: string;
  library: string;
  inspector: string;
  runs: string;
}): boolean {
  return (
    editorTopBarHasThreeGroups(input.topBar) &&
    editorTopBarSerialPosition(input.topBar) &&
    editorTopBarDraftsNeverRun() &&
    input.topBar.includes('data-editor-working-memory="draft"') &&
    input.topBar.includes('data-editor-working-memory="test-run"') &&
    input.topBar.includes("DohertyStatus") &&
    input.topBar.includes("EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS") &&
    input.canvas.includes("will not guess a graph") &&
    input.canvas.includes(EDITOR_CANVAS_PLUS_FITTS.pending) &&
    input.canvas.includes(EDITOR_CANVAS_PLUS_FITTS.empty) &&
    input.canvas.includes(EDITOR_CANVAS_PLUS_FITTS.node) &&
    input.canvas.includes(EDITOR_CANVAS_PLUS_FITTS.toolbar) &&
    input.library.includes('data-uxl7="palette"') &&
    input.library.includes('data-uxl7="categories"') &&
    input.inspector.includes('data-ndv-shell="node"') &&
    input.inspector.includes("Inspector") &&
    !input.inspector.includes("Node Detail View") &&
    input.runs.includes('data-editor-runs="drawer"') &&
    input.runs.includes("EDITOR_RUNS_SKIP_INDETERMINATE_LABEL")
  );
}

export function editorOneOverlayHeld(runsSource: string): boolean {
  return (
    EDITOR_RUNS.noSecondReplayCanvas &&
    EDITOR_RUNS.noExecutionReplayMount &&
    !runsSource.includes("ExecutionReplay") &&
    !runsSource.includes("/replay")
  );
}

export function editorVisualHoldsAcceptance(input: {
  chrome: string;
  topBar: string;
  canvas: string;
  library: string;
  inspector: string;
  runs: string;
}): boolean {
  return (
    input.chrome.includes("data-ff-editor") &&
    input.chrome.includes("FF_EDITOR_VALUE") &&
    input.chrome.includes("FF_EDITOR_ROOT_CLASS") &&
    input.chrome.includes("FF_EDITOR_SATELLITE_CLASS") &&
    input.topBar.includes("FF_EDITOR_TOPBAR_CLASS") &&
    input.topBar.includes("EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS") &&
    input.canvas.includes("FF_EDITOR_CANVAS_CLASS") &&
    input.canvas.includes("FF_EDITOR_GRID_CLASS") &&
    input.canvas.includes("FF_EDITOR_NODE_SELECTED_CLASS") &&
    input.canvas.includes("editorNodeFamilyMark") &&
    input.canvas.includes("editorNodeFamilyShapeClass") &&
    input.canvas.includes("FF_EDITOR_PORT_CLASS") &&
    input.canvas.includes("FF_EDITOR_PLUS_CLASS") &&
    input.library.includes("FF_EDITOR_PANEL_CLASS") &&
    input.library.includes('data-uxl7="palette"') &&
    input.inspector.includes("FF_EDITOR_PANEL_CLASS") &&
    input.runs.includes("FF_EDITOR_SATELLITE_CLASS") &&
    editorUxlBehaviorsHeld(input) &&
    editorOneOverlayHeld(input.runs) &&
    editorRejectsN8nNdvClone(input.inspector) &&
    editorRejectsRainbowPalette(input.library)
  );
}

export function editorVisualHoldsHardLines(): boolean {
  return (
    EDITOR_VISUAL.yamlIsSourceOfTruth &&
    EDITOR_VISUAL.draftsNeverRun &&
    EDITOR_VISUAL.invalidYamlNeverGuessesGraph &&
    EDITOR_VISUAL.oneOverlay &&
    EDITOR_VISUAL.loudIndeterminate &&
    EDITOR_VISUAL.vaultDisplayNameUuidOnly &&
    EDITOR_VISUAL.noKekInBrowser &&
    EDITOR_VISUAL.adv021ChromeFromSessionEmbedOnly &&
    EDITOR_VISUAL.adv024MembershipIsolationStayGrantGated &&
    EDITOR_VISUAL.isolationSuccessIsDenial &&
    EDITOR_VISUAL.d3TriggersAreWorkflowLevel &&
    EDITOR_VISUAL.noCanvasTriggerNodes &&
    EDITOR_VISUAL.notAnN8nClone &&
    EDITOR_VISUAL.notAnN8nNdvClone &&
    EDITOR_VISUAL.noN8nOrange &&
    EDITOR_VISUAL.noSecondThemeTree &&
    EDITOR_VISUAL.keep360Open &&
    EDITOR_VISUAL.inheritV1Tokens &&
    EDITOR_VISUAL.uiOnly &&
    EDITOR_VISUAL.noGreenfieldApis &&
    EDITOR_CHROME.invalidYamlNeverGuessesGraph &&
    EDITOR_CHROME.draftsCannotStart &&
    EDITOR_CHROME.startPublishedVersionsOnly &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_CANVAS.toLowerCase() === "#0f1218" &&
    FF_SURFACE.toLowerCase() === "#171b22" &&
    EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS === "px-2.5 py-1 text-sm font-medium" &&
    EDITOR_CANVAS_PLUS_FITTS.pending === "h-9 w-9" &&
    EDITOR_CANVAS_PLUS_FITTS.empty === "h-12 w-12" &&
    EDITOR_CANVAS_PLUS_FITTS.node === "h-7 w-7" &&
    EDITOR_CANVAS_PLUS_FITTS.toolbar === "px-2 py-1 text-xs font-semibold" &&
    EDITOR_NDV.noBrandedNdvInUi &&
    EDITOR_LIBRARY.triggersExcluded &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1
  );
}

export function editorVisualInheritsPriorStories(): boolean {
  return (
    EDITOR_VISUAL.inheritV1Tokens &&
    EDITOR_VISUAL.inheritV2Shell &&
    EDITOR_VISUAL.inheritUxl1TopBarGroups &&
    EDITOR_VISUAL.inheritUxl2WorkingMemory &&
    EDITOR_VISUAL.inheritUxl3DohertyPending &&
    EDITOR_VISUAL.inheritUxl4PeakEnd &&
    EDITOR_VISUAL.inheritUxl7CategoryFirstPalette &&
    EDITOR_VISUAL.inheritUxl8SatelliteAlignment &&
    EDITOR_TOPBAR_CHUNKING.threeGroupsNotTwelvePeers &&
    EDITOR_WORKING_MEMORY.persistentChromeNotTooltip &&
    DOHERTY_PENDING_CHROME.pendingImmediatelyThenSuccessOrError &&
    PEAK_END_OPERATE.afterStartOrTestRunOpenOverlay &&
    PALETTE_CATEGORY_FIRST.firstPaintIsCategories &&
    AESTHETIC_USABILITY.fittsPrimaryControlsUnchanged &&
    UXL1_KEEP_STORY_OPEN
  );
}

export function editorChromeRejectsForbiddenLook(source: string): boolean {
  return (
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source) &&
    editorChromeRejectsLightLook(source) &&
    editorRejectsN8nNdvClone(source) &&
    editorRejectsRainbowPalette(source) &&
    !FORBIDDEN_THEME_TREES.some((tree) => source.includes(tree)) &&
    !N8N_ORANGE_TOKENS.some((token) =>
      source.toLowerCase().includes(token.toLowerCase()),
    )
  );
}
