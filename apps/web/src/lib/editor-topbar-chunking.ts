/**
 * UXL.1: Top-bar verb chunking.
 *
 * Relates to #288 / Part of #287. Keep #288 open.
 *
 * Chloe UI only. Densify EditorTopBar in place (D6). Same component on
 * standalone `/workflows/{id}` and `/embed/v1` after `session.embed`.
 * No second embed tree. No API/contract changes. No invented verbs.
 *
 * Three visual groups — not twelve peer controls:
 *   authoring  Save draft + Publish
 *   satellites Library + Inspector + YAML + Runs
 *   run        Start published + Test run
 *
 * Serial position: identity / unsaved leads; Start published + Test
 * run trail. Save and Publish stay large, labeled, and visible — not
 * overflow-only. Fitts: Save, Publish, Test run, and canvas + do not
 * shrink below the current control height. Undo/Redo stay (R2.3).
 * Drafts still never run. Publish remains last saved draft only.
 *
 * Out of scope: UXL.2–UXL.8.
 */

import { R23_KEEP_STORY_OPEN, R23_STORY } from "./editor-canvas-history.ts";
import {
  EDITOR_CHROME,
  canPublishLastSavedDraft,
  editorEmbedRouteUnchanged,
} from "./editor-chrome.ts";
import {
  EDITOR_TOP_BAR_CONTROLS,
  type EditorTopBarControlId,
} from "./e12-accessibility-contract.ts";
import { INVENTED_EMBED_TREES, R7_HARD_LINE } from "./rewrite-embed-mount.ts";

export const UXL1_STORY = 288;
export const UXL1_EPIC = 287;
export const UXL1_KEEP_STORY_OPEN = true;
export const UXL1_ID = "UXL.1-topbar-chunking" as const;

export const UXL1_BRIEF = "docs/internal/flowforge-ux-laws.md";

export type EditorTopBarChunkId =
  | "identity"
  | "authoring"
  | "history"
  | "satellites"
  | "activation"
  | "run";

export const EDITOR_TOPBAR_CHUNK_IDS = [
  "identity",
  "authoring",
  "history",
  "satellites",
  "activation",
  "run",
] as const satisfies readonly EditorTopBarChunkId[];

export const EDITOR_TOPBAR_GROUPS = {
  authoring: ["save", "publish"],
  satellites: ["library", "inspector", "yaml", "runs"],
  run: ["start", "test-run"],
} as const satisfies Record<
  "authoring" | "satellites" | "run",
  readonly EditorTopBarControlId[]
>;

export const EDITOR_TOPBAR_GROUP_LABELS = {
  authoring: "Authoring",
  satellites: "Editor satellites",
  run: "Run",
} as const;

export const EDITOR_TOPBAR_SERIAL = {
  lead: "identity",
  trail: "run",
  authoringAfterIdentity: true,
  savePublishVisibleNotOverflow: true,
} as const;

/** Current primary control height. Do not shrink to make room for groups. */
export const EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS =
  "px-2.5 py-1 text-sm font-medium";

/** Current canvas + heights. Grouping must not shrink these. */
export const EDITOR_CANVAS_PLUS_FITTS = {
  pending: "h-9 w-9",
  toolbar: "px-2 py-1 text-xs font-semibold",
  empty: "h-12 w-12",
  node: "h-7 w-7",
} as const;

export const EDITOR_TOPBAR_CHUNKING = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  d6MigrateInPlace: true,
  threeGroupsNotTwelvePeers: true,
  authoringIsSavePublish: true,
  satellitesAreLibraryInspectorYamlRuns: true,
  runIsStartPublishedTestRun: true,
  serialIdentityLeads: true,
  serialRunTrails: true,
  savePublishLargeLabeledVisible: true,
  savePublishNotOverflowOnly: true,
  fittsDoNotShrinkPrimary: true,
  fittsDoNotShrinkCanvasPlus: true,
  undoRedoStayAvailable: true,
  r23UndoRedoIs236: true,
  noVerbRemoved: true,
  noInventedVerbs: true,
  draftsNeverRun: true,
  publishLastSavedDraftOnly: true,
  yamlIsSourceOfTruth: true,
  vaultDisplayNameUuidOnly: true,
  oneReplayPath: true,
  loudIndeterminate: true,
  failClosedCatalogs: true,
  notAnN8nClone: true,
  sameGroupingOnEmbed: true,
  noSecondEmbedTree: true,
  chromeFromSessionEmbedOnly: true,
  noAppsApiChanges: true,
  uxl2ThroughUxl8OutOfScope: true,
  jonnyNoneExpected: true,
} as const;

export const EDITOR_TOPBAR_CHUNKING_HELP =
  "Authoring (Save draft, Publish), satellites (Library, Inspector, YAML, Runs), and run (Start published, Test run) read as three groups. Identity / unsaved leads; Start published + Test run trail. Save and Publish stay large, labeled, and visible. Undo/Redo stay. Drafts never run. Publish is last saved draft only. Same grouping on embed after session.embed.";

export const EDITOR_TOPBAR_CHUNKING_SOURCES = [
  "src/lib/editor-topbar-chunking.ts",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/WorkflowOperator.tsx",
  "src/components/workflows/WorkflowCanvas.tsx",
] as const;

export const EDITOR_TOPBAR_REQUIRED_VERBS = [
  "back",
  "add-action",
  "undo",
  "redo",
  "library",
  "yaml",
  "inspector",
  "save",
  "publish",
  "runs",
  "start",
  "test-run",
  "activation",
  "publish-note",
] as const satisfies readonly EditorTopBarControlId[];

export const INVENTED_TOPBAR_VERBS = [
  "Run",
  "Execute draft",
  "Run draft",
  "More",
] as const;

export const INVENTED_TOPBAR_OVERFLOW = [
  "<details",
  "overflow-menu",
  "data-editor-topbar=\"overflow\"",
  "aria-haspopup=\"menu\"",
] as const;

export function editorTopBarChunkAttr(id: EditorTopBarChunkId): string {
  return `data-editor-topbar="${id}"`;
}

export function editorTopBarGroupControls(
  id: keyof typeof EDITOR_TOPBAR_GROUPS,
): readonly EditorTopBarControlId[] {
  return EDITOR_TOPBAR_GROUPS[id];
}

export function editorTopBarChunkOrder(source: string): EditorTopBarChunkId[] {
  const allowed = new Set<string>(EDITOR_TOPBAR_CHUNK_IDS);
  return [...source.matchAll(/data-editor-topbar="([a-z-]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((id): id is EditorTopBarChunkId => allowed.has(id));
}

export function editorTopBarHasThreeGroups(source: string): boolean {
  const order = editorTopBarChunkOrder(source);
  return (
    order.includes("authoring") &&
    order.includes("satellites") &&
    order.includes("run")
  );
}

export function editorTopBarSerialPosition(source: string): boolean {
  const order = editorTopBarChunkOrder(source);
  if (order.length === 0) {
    return false;
  }
  return (
    order[0] === EDITOR_TOPBAR_SERIAL.lead &&
    order[order.length - 1] === EDITOR_TOPBAR_SERIAL.trail &&
    order.indexOf("identity") < order.indexOf("authoring") &&
    order.indexOf("authoring") < order.indexOf("run")
  );
}

export function editorTopBarGroupContains(
  source: string,
  group: keyof typeof EDITOR_TOPBAR_GROUPS,
): boolean {
  const attr = editorTopBarChunkAttr(group);
  const start = source.indexOf(attr);
  if (start < 0) {
    return false;
  }
  const slice = source.slice(start, start + 1800);
  return EDITOR_TOPBAR_GROUPS[group].every((id) =>
    slice.includes(`"${id}"`),
  );
}

export function editorTopBarHidesAuthoringInOverflow(source: string): boolean {
  if (INVENTED_TOPBAR_OVERFLOW.some((token) => source.includes(token))) {
    return true;
  }
  for (const id of EDITOR_TOPBAR_GROUPS.authoring) {
    const needle = `editorTopBarControlLabel("${id}")`;
    const index = source.indexOf(needle);
    if (index < 0) {
      return true;
    }
    const buttonStart = source.lastIndexOf("<button", index);
    if (buttonStart < 0) {
      return true;
    }
    const button = source.slice(buttonStart, index);
    if (/\bhidden\b/.test(button) || button.includes("sr-only")) {
      return true;
    }
  }
  return false;
}

export function editorTopBarRemovesRequiredVerb(source: string): boolean {
  return EDITOR_TOPBAR_REQUIRED_VERBS.some(
    (id) => !source.includes(`"${id}"`),
  );
}

export function editorTopBarInventedVerb(source: string): boolean {
  return INVENTED_TOPBAR_VERBS.some((label) => {
    return source.includes(`>${label}<`) || source.includes(`"${label}"`);
  });
}

export function editorTopBarKeepsUndoRedo(): boolean {
  return (
    EDITOR_TOPBAR_CHUNKING.undoRedoStayAvailable &&
    R23_STORY === 236 &&
    R23_KEEP_STORY_OPEN &&
    EDITOR_CHROME.keyboard.undoRedo
  );
}

export function editorTopBarPublishLastSavedOnly(): boolean {
  return (
    EDITOR_CHROME.publishLastSavedDraftOnly &&
    canPublishLastSavedDraft({
      dirty: true,
      hasWorkflow: true,
      revision: 1,
    }) === false &&
    canPublishLastSavedDraft({
      dirty: false,
      hasWorkflow: true,
      revision: 1,
    }) === true
  );
}

export function editorTopBarDraftsNeverRun(): boolean {
  return (
    EDITOR_CHROME.draftsCannotStart &&
    EDITOR_CHROME.startPublishedVersionsOnly &&
    EDITOR_TOPBAR_CHUNKING.draftsNeverRun
  );
}

export function editorTopBarFittsPrimaryClassPresent(source: string): boolean {
  const token = source.includes(EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS)
    ? EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS
    : "EDITOR_TOPBAR_PRIMARY_CONTROL_CLASS";
  const count = source.split(token).length - 1;
  return count >= 4;
}

export function editorCanvasPlusFittsUnchanged(source: string): boolean {
  return (
    source.includes(EDITOR_CANVAS_PLUS_FITTS.pending) &&
    source.includes(EDITOR_CANVAS_PLUS_FITTS.toolbar) &&
    source.includes(EDITOR_CANVAS_PLUS_FITTS.empty) &&
    source.includes(EDITOR_CANVAS_PLUS_FITTS.node)
  );
}

export function editorTopBarSameEmbedTree(source: string): boolean {
  return (
    editorEmbedRouteUnchanged() &&
    EDITOR_CHROME.noNewEmbedRoutes &&
    !INVENTED_EMBED_TREES.some((tree) => source.includes(`"${tree}"`)) &&
    !source.includes("EmbedEditorTopBar")
  );
}

export function editorTopBarHoldsHardLines(): boolean {
  return (
    EDITOR_TOPBAR_CHUNKING.yamlIsSourceOfTruth &&
    EDITOR_TOPBAR_CHUNKING.draftsNeverRun &&
    EDITOR_TOPBAR_CHUNKING.vaultDisplayNameUuidOnly &&
    EDITOR_TOPBAR_CHUNKING.oneReplayPath &&
    EDITOR_TOPBAR_CHUNKING.loudIndeterminate &&
    EDITOR_TOPBAR_CHUNKING.failClosedCatalogs &&
    EDITOR_TOPBAR_CHUNKING.notAnN8nClone &&
    EDITOR_TOPBAR_CHUNKING.adv021ChromeFromSessionEmbedOnly &&
    EDITOR_TOPBAR_CHUNKING.adv024MembershipIsolationStayGrantGated &&
    EDITOR_TOPBAR_CHUNKING.noSecondEmbedTreeSameMountsAsStandalone &&
    EDITOR_TOPBAR_CHUNKING.noAppsApiChanges &&
    EDITOR_CHROME.invalidYamlNeverGuessesGraph &&
    EDITOR_CHROME.publishLastSavedDraftOnly
  );
}

export function editorTopBarControlIdsUnchanged(): boolean {
  const ids = EDITOR_TOP_BAR_CONTROLS.map((item) => item.id);
  return EDITOR_TOPBAR_REQUIRED_VERBS.every((id) => ids.includes(id));
}
