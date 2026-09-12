/**
 * E12.3 Chloe accessibility checklist + UX.10 canvas-first chrome.
 *
 * Relates to #184 / Part of #181. Keep #184 open.
 * Relates to #205 / Part of #195. Keep #205 open.
 *
 * Encodes the cheap a11y contracts from
 * docs/reference/e12-accessibility-review.md and the UX.10 editor
 * chrome contract. Product chrome stays the same — skip target,
 * labels, roles, drawer Esc, and selection announcements. Do not
 * invent a screen-reader graph rewrite, a mobile app, or API/OpenAPI
 * docs (Jonny).
 */

import {
  PALETTE_INPUT_LABEL,
  PALETTE_RESULTS_ID,
  PALETTE_SHORTCUT_HELP,
  paletteHighlightIndex,
} from "./command-palette.ts";
import { EDITOR_LIBRARY_PANEL_ID } from "./editor-library.ts";
import { EDITOR_RUNS_PANEL_ID } from "./editor-runs.ts";
import {
  sessionExpiryBannerState,
  sessionStatusChipAccessibleName,
  type SessionChromeSnapshot,
} from "./session.ts";
import {
  canSeeMembershipIsolationNav,
  visibleWorkspaceNav,
} from "./workspace-nav.ts";

export const E12_A11Y_STORY = 184;
export const E12_A11Y_EPIC = 181;
export const E12_A11Y_ID = "E12.3-chloe-a11y" as const;

export const E12_A11Y_RULES = {
  keep184Open: true,
  skipLinkHref: "#main-content",
  skipLinkLabel: "Skip to main content",
  mainTargetId: "main-content",
  noNestedMainInShell: true,
  paletteShortcut: "Ctrl+Shift+K",
  expiredSessionIsAlert: true,
  membershipIsolationGrantedOnly: true,
  secretsNeverPlaintext: true,
} as const;

export const E12_A11Y_FIXES = [
  "skip-link",
  "focus-visible",
  "prefers-reduced-motion",
  "nav-menu-aria",
  "palette-label-highlight",
  "search-combobox",
  "session-chip-accessible-name",
  "expired-session-alert",
  "secret-field-describedby",
  "notification-dismiss-label",
  "wizard-escape",
  "home-view-pressed",
  "editor-top-bar-labels",
  "editor-drawer-escape",
  "editor-selection-announce",
  "rewrite-satellite-escape-focus",
  "rewrite-satellite-icon-text",
] as const;

export const E12_A11Y_GAPS = [
  "dialog-focus-trap",
  "canvas-sr-graph",
  "axe-ci",
  "touch-inspector-first",
] as const;

export const E12_A11Y_DOCS = {
  guide: "docs/guides/operator-admin.md",
  review: "docs/reference/e12-accessibility-review.md",
  frontend: "docs/reference/frontend-ui.md",
} as const;

export function e12A11ySkipTarget(): { href: string; id: string; label: string } {
  return {
    href: E12_A11Y_RULES.skipLinkHref,
    id: E12_A11Y_RULES.mainTargetId,
    label: E12_A11Y_RULES.skipLinkLabel,
  };
}

export function e12A11yPaletteContract(): {
  inputLabel: string;
  resultsId: string;
  shortcutHelp: string;
} {
  return {
    inputLabel: PALETTE_INPUT_LABEL,
    resultsId: PALETTE_RESULTS_ID,
    shortcutHelp: PALETTE_SHORTCUT_HELP,
  };
}

export function e12A11yPaletteHighlight(
  current: number,
  key: string,
  length: number,
): number {
  return paletteHighlightIndex(current, key, length);
}

export function e12A11yExpiredSessionIsAlert(
  snapshot: SessionChromeSnapshot,
  now: number,
): boolean {
  const banner = sessionExpiryBannerState(snapshot, now);
  return banner.visible && banner.kind === "expired" && banner.role === "alert";
}

export function e12A11yChipName(
  snapshot: SessionChromeSnapshot,
  now: number,
): string {
  return sessionStatusChipAccessibleName(snapshot, now);
}

export function e12A11yMembershipIsolationVisible(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeMembershipIsolationNav(permissions);
}

/** Product nav ids. R7.2 takes membership/isolation off product chrome. */
export function e12A11yMembershipIsolationNavIds(
  permissions: readonly string[] | null | undefined,
): string[] {
  return visibleWorkspaceNav(permissions)
    .filter((item) => item.id === "membership" || item.id === "isolation")
    .map((item) => item.id);
}

/** UX.10: A11y contract for canvas-first chrome. Keep #205 open. */
export const UX10_STORY = 205;
export const UX10_EPIC = 195;
export const UX10_KEEP_STORY_OPEN = true;
export const UX10_A11Y_ID = "UX.10-canvas-chrome-a11y" as const;

export const EDITOR_INSPECTOR_PANEL_ID = "editor-inspector-panel";
export const EDITOR_YAML_PANEL_ID = "editor-yaml-drawer";
export const EDITOR_SELECTION_STATUS_ID = "editor-selection-status";
export const EDITOR_INSPECTOR_OPEN_ON_FIRST_PAINT = true;
export const EDITOR_INSPECTOR_FIRST_MEDIA = "(max-width: 767px)";

export const EDITOR_CHROME_A11Y = {
  keep205Open: true,
  skipLinkHref: "#main-content",
  noNestedMain: true,
  editorBarLabeled: true,
  drawerEscapeCloses: true,
  drawerFocusReturns: true,
  canvasRoleApplication: true,
  nodeEdgeAccessibleNames: true,
  iconPlusTextState: true,
  selectionAnnouncesInspector: true,
  inspectorFirstIsDocumentedGap: true,
  notAMobileApp: true,
  noSrGraphRewrite: true,
  statusNeverColorOnly: true,
} as const;

export const EDITOR_CANVAS_A11Y = {
  role: "application",
  label: "Workflow canvas",
  nodeRole: "group",
  edgeNamePrefix: "Edge",
  stateIconAndText: true,
} as const;

export const EDITOR_DRAWER_IDS = ["library", "yaml", "runs", "inspector"] as const;
export type EditorDrawerId = (typeof EDITOR_DRAWER_IDS)[number];

export const EDITOR_DRAWER_PANEL_IDS = {
  library: EDITOR_LIBRARY_PANEL_ID,
  yaml: EDITOR_YAML_PANEL_ID,
  runs: EDITOR_RUNS_PANEL_ID,
  inspector: EDITOR_INSPECTOR_PANEL_ID,
} as const;

export const EDITOR_TOP_BAR_CONTROLS = [
  { id: "back", label: "← Workflows" },
  { id: "add-action", label: "Add action" },
  { id: "undo", label: "Undo (Ctrl+Z)" },
  { id: "redo", label: "Redo (Ctrl+Shift+Z)" },
  { id: "library", label: "Library", openLabel: "Hide library" },
  { id: "yaml", label: "YAML", openLabel: "Hide YAML" },
  { id: "inspector", label: "Inspector", openLabel: "Hide inspector" },
  { id: "save", label: "Save draft" },
  { id: "publish", label: "Publish" },
  { id: "runs", label: "Runs", openLabel: "Hide runs" },
  { id: "start", label: "Start published" },
  { id: "test-run", label: "Test run" },
  { id: "activation", label: "Activation" },
  { id: "publish-note", label: "Publish note" },
] as const;

export type EditorTopBarControlId = (typeof EDITOR_TOP_BAR_CONTROLS)[number]["id"];

export function editorTopBarControlLabel(
  id: EditorTopBarControlId,
  open = false,
): string {
  const control = EDITOR_TOP_BAR_CONTROLS.find((item) => item.id === id);
  if (!control) {
    return "";
  }
  if (open && "openLabel" in control && control.openLabel) {
    return control.openLabel;
  }
  return control.label;
}

export function editorDrawerTriggerId(drawer: EditorDrawerId): string {
  return `editor-topbar-${drawer}`;
}

export function editorDrawerAfterEscape(): { open: false; restoreFocus: true } {
  return { open: false, restoreFocus: true };
}

export function editorDrawerToggle(open: boolean): {
  open: boolean;
  restoreFocus: boolean;
} {
  return { open: !open, restoreFocus: open };
}

export function editorInspectorIsDrawer(narrow: boolean): boolean {
  return narrow;
}

export function editorDrawerToClose(
  open: Record<EditorDrawerId, boolean>,
  lastOpened: EditorDrawerId | null,
  options: { inspectorIsDrawer?: boolean } = {},
): EditorDrawerId | null {
  const inspectorClosable =
    options.inspectorIsDrawer === true || lastOpened === "inspector";
  const closable = EDITOR_DRAWER_IDS.filter((id) => {
    if (!open[id]) {
      return false;
    }
    return id !== "inspector" || inspectorClosable;
  });
  if (lastOpened && closable.includes(lastOpened)) {
    return lastOpened;
  }
  return closable[0] ?? null;
}

export function editorRestoreDrawerFocus(drawer: EditorDrawerId): void {
  const focus = () => {
    const node = document.getElementById(editorDrawerTriggerId(drawer));
    if (node instanceof HTMLElement) {
      node.focus();
    }
  };
  focus();
  if (typeof window !== "undefined") {
    window.setTimeout(focus, 0);
  }
}

export function editorSelectionAnnouncement(input: {
  kind: "workflow" | "node" | "edge";
  name?: string | null;
  type?: string | null;
  id?: string | null;
  from?: string | null;
  to?: string | null;
  count?: number;
}): string {
  if (input.kind === "node") {
    const title = input.name?.trim() || input.id?.trim() || "node";
    const type = input.type?.trim();
    const count = input.count ?? 1;
    if (count > 1) {
      const focus = type ? `${title} (${type})` : title;
      return `Selected ${count} nodes. Inspector shows ${focus}. Shift+click or Shift+drag to adjust.`;
    }
    return type
      ? `Selected ${title} (${type}). Inspector shows name, with fields, pins, and credentials.`
      : `Selected ${title}. Inspector shows name, with fields, pins, and credentials.`;
  }
  if (input.kind === "edge") {
    return `Selected edge ${input.from ?? "from"} to ${input.to ?? "to"}. Inspector explains port compatibility and field-path mapping.`;
  }
  return "Workflow selected. Inspector shows triggers, versions, and pins.";
}

