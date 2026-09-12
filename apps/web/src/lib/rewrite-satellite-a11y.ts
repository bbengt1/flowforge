/**
 * R7.4: Extend E12.3 / UX.10 a11y to rewrite satellites.
 *
 * Relates to #279 / Part of #233. Keep #279 open.
 *
 * Chloe UI only. Densify in place (D6). Inherit `R7_HARD_LINE` from
 * R7.1 — do not weaken ADV-021/024, host query display-only, no second
 * embed tree, issuer/frame-ancestor fail-closed.
 *
 * UX.10 / E12.3 (Esc, focus return, no nested `<main>`, icon+text)
 * extends to NDV, palette, Runs overlay, activation chrome, and other
 * R2–R6 satellites. Still no screen-reader graph rewrite unless Brent
 * files it. Touch stays the `touch-inspector-first` breakpoint — not a
 * mobile app.
 *
 * jonny standby: no embed/ADV boundary moved.
 */

import {
  E12_A11Y_GAPS,
  E12_A11Y_RULES,
  EDITOR_CHROME_A11Y,
  EDITOR_INSPECTOR_FIRST_MEDIA,
  editorDrawerAfterEscape,
  editorDrawerTriggerId,
  editorRestoreDrawerFocus,
  editorTopBarControlLabel,
  type EditorDrawerId,
} from "./e12-accessibility-contract.ts";
import { EDITOR_LIBRARY_SATELLITE_ID } from "./editor-library.ts";
import { EDITOR_NDV_SATELLITE_ID } from "./editor-ndv.ts";
import { EDITOR_RUNS_SATELLITE_ID } from "./editor-runs.ts";
import { LOCAL_SEED_OPS } from "./local-seed-ops.ts";
import { MEMBERSHIP_ISOLATION_CHROME } from "./membership-isolation-chrome.ts";
import {
  R7_HARD_LINE,
  rewriteEmbedAdv021Unchanged,
  rewriteEmbedAdv024Unchanged,
  rewriteEmbedFrameAncestorFailClosedUnchanged,
  rewriteEmbedHoldsR7HardLine,
  rewriteEmbedHostIssuerBindUnchanged,
} from "./rewrite-embed-mount.ts";

export const R74_STORY = 279;
export const R74_EPIC = 233;
export const R74_KEEP_STORY_OPEN = true;
export const R74_A11Y_ID = "R7.4-satellite-a11y" as const;

export const REWRITE_SATELLITE_A11Y = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritUx10: true,
  inheritE123: true,
  d6MigrateInPlace: true,
  escapeCloses: true,
  focusReturns: true,
  noNestedMain: true,
  iconPlusText: true,
  skipLinkMainContent: true,
  noSrGraphRewrite: true,
  touchInspectorFirstBreakpoint: true,
  notAMobileApp: true,
  noAppsApiChanges: true,
  jonnyStandbyOnlyIfBoundaryMoves: true,
  boundaryMoved: false,
} as const;

export const REWRITE_SATELLITE_A11Y_HELP =
  "UX.10 / E12.3 a11y (Esc, focus return, no nested main, icon+text) extends to NDV, palette, Runs overlay, activation chrome, and other R2–R6 satellites. Still no screen-reader graph rewrite unless Brent files it. Touch stays the touch-inspector-first breakpoint — not a mobile app.";

export const JONNY_R74_NOTE =
  "No embed or ADV boundary moved. ADV-021 session.embed, ADV-024 grant gating, host-query display-only, CHIPS, host-issuer bind, and frame-ancestor fail-closed stay. A11y extend is Chloe UI only. Do not invent an SR graph rewrite or a mobile app.";

export const REWRITE_SATELLITE_A11Y_DOCS = {
  review: "docs/reference/e12-accessibility-review.md",
  frontend: "docs/reference/frontend-ui.md",
  operatorAdmin: "docs/guides/operator-admin.md",
  rewriteUiSurfaces: "docs/reference/rewrite-ui-surfaces.md",
  charter: "docs/architecture/flowforge-rewrite-n8n-class-parity.md",
} as const;

export const REWRITE_SATELLITE_SURFACES = [
  {
    id: "palette",
    story: "R2.1",
    sources: [
      "src/components/workflows/EditorChrome.tsx",
      "src/components/workflows/ActionLibrary.tsx",
      "src/components/workflows/ActionWizard.tsx",
    ],
  },
  {
    id: "ndv",
    story: "R2.2",
    sources: [
      "src/components/workflows/EditorChrome.tsx",
      "src/components/workflows/EditorInspector.tsx",
      "src/components/credentials/CredentialWizardDialog.tsx",
    ],
  },
  {
    id: "runs-overlay",
    story: "R4.2",
    sources: ["src/components/workflows/EditorRunsDrawer.tsx"],
  },
  {
    id: "activation-chrome",
    story: "R6.1",
    sources: [
      "src/components/workflows/EditorActivationChrome.tsx",
      "src/components/home/HomeActivationStatus.tsx",
    ],
  },
  {
    id: "yaml",
    story: "UX.5",
    sources: ["src/components/workflows/EditorYamlDrawer.tsx"],
  },
  {
    id: "start-published",
    story: "R6",
    sources: ["src/components/workflows/EditorStartDialog.tsx"],
  },
  {
    id: "home-drawers",
    story: "R6.2",
    sources: [
      "src/components/home/WorkflowHome.tsx",
      "src/components/workflows/ManualStartPanel.tsx",
      "src/components/workflows/WebhookTriggerPanel.tsx",
      "src/components/workflows/ScheduleTriggerPanel.tsx",
    ],
  },
  {
    id: "command-palette",
    story: "E12.3",
    sources: ["src/components/shell/CommandPalette.tsx"],
  },
] as const;

export type RewriteSatelliteSurfaceId =
  (typeof REWRITE_SATELLITE_SURFACES)[number]["id"];

export const REWRITE_SATELLITE_A11Y_SOURCES = [
  "src/lib/rewrite-satellite-a11y.ts",
  "src/lib/e12-accessibility-contract.ts",
  ...REWRITE_SATELLITE_SURFACES.flatMap((surface) => [...surface.sources]),
] as const;

export const SATELLITE_OVERLAY_IDS = [
  "action-wizard",
  "ndv-credential",
  "start-published",
  "activation",
  "home-start",
  "home-webhooks",
  "home-schedules",
] as const;

export type SatelliteOverlayId = (typeof SATELLITE_OVERLAY_IDS)[number];

export const SATELLITE_OVERLAY_TRIGGERS = {
  "action-wizard": "editor-topbar-add-action",
  "ndv-credential": "ndv-add-credential",
  "start-published": "editor-topbar-start",
  activation: "editor-topbar-activation",
  "home-start": "home-start-overlay",
  "home-webhooks": "home-webhooks-overlay",
  "home-schedules": "home-schedules-overlay",
} as const;

export const HOME_SATELLITE_OVERLAYS = [
  "start",
  "webhooks",
  "schedules",
] as const;

export type HomeSatelliteOverlayId = (typeof HOME_SATELLITE_OVERLAYS)[number];

export const SATELLITE_RAIL_IDS = {
  library: EDITOR_LIBRARY_SATELLITE_ID,
  inspector: EDITOR_NDV_SATELLITE_ID,
  runs: EDITOR_RUNS_SATELLITE_ID,
} as const;

export function satelliteOverlayTriggerId(id: SatelliteOverlayId): string {
  return SATELLITE_OVERLAY_TRIGGERS[id];
}

export function ndvCredentialOverlayTriggerId(field?: string): string {
  const base = SATELLITE_OVERLAY_TRIGGERS["ndv-credential"];
  const trimmed = field?.trim();
  return trimmed ? `${base}-${trimmed}` : base;
}

export function homeSatelliteOverlayTriggerId(
  kind: HomeSatelliteOverlayId,
  workflowId: string,
): string {
  const trimmed = workflowId.trim();
  if (!trimmed) {
    return SATELLITE_OVERLAY_TRIGGERS[
      kind === "start"
        ? "home-start"
        : kind === "webhooks"
          ? "home-webhooks"
          : "home-schedules"
    ];
  }
  return `home-${kind}-${trimmed}`;
}

export function satelliteOverlayAfterEscape(): {
  open: false;
  restoreFocus: true;
} {
  return editorDrawerAfterEscape();
}

export function captureSatelliteOverlayTrigger(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const node = document.activeElement;
  return node instanceof HTMLElement ? node : null;
}

export function restoreSatelliteOverlayFocus(
  target?: string | HTMLElement | null,
): void {
  const focus = () => {
    const node =
      typeof target === "string"
        ? document.getElementById(target)
        : target instanceof HTMLElement
          ? target
          : null;
    if (node instanceof HTMLElement) {
      node.focus();
    }
  };
  focus();
  if (typeof window !== "undefined") {
    window.setTimeout(focus, 0);
  }
}

export function satelliteDrawerRestoreFocus(drawer: EditorDrawerId): void {
  editorRestoreDrawerFocus(drawer);
}

export function satelliteDrawerTriggerId(drawer: EditorDrawerId): string {
  return editorDrawerTriggerId(drawer);
}

export type ActivationStatusPresentation = {
  icon: string;
  label: string;
  description: string;
};

export function activationStatusPresentation(input: {
  live: boolean;
  label: string;
}): ActivationStatusPresentation {
  const label = input.label.trim() || (input.live ? "Active" : "Not live");
  return {
    icon: input.live ? "●" : "○",
    label,
    description: input.live
      ? `${label}. A published version has an enabled webhook or schedule pin.`
      : `${label}. Drafts never run and never look live.`,
  };
}

export function rewriteSatelliteA11yHoldsR7HardLine(): boolean {
  return (
    REWRITE_SATELLITE_A11Y.inheritR7HardLine &&
    rewriteEmbedHoldsR7HardLine() &&
    rewriteEmbedAdv021Unchanged() &&
    rewriteEmbedAdv024Unchanged() &&
    rewriteEmbedHostIssuerBindUnchanged() &&
    rewriteEmbedFrameAncestorFailClosedUnchanged() &&
    R7_HARD_LINE.adv021ChromeFromSessionEmbedOnly &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated &&
    MEMBERSHIP_ISOLATION_CHROME.a11yExtendIsR74 &&
    LOCAL_SEED_OPS.a11yExtendIsR74
  );
}

export function rewriteSatelliteA11yBoundaryMoved(): boolean {
  return REWRITE_SATELLITE_A11Y.boundaryMoved;
}

export function rewriteSatelliteA11yInheritsUx10(): boolean {
  return (
    REWRITE_SATELLITE_A11Y.inheritUx10 &&
    REWRITE_SATELLITE_A11Y.inheritE123 &&
    REWRITE_SATELLITE_A11Y.escapeCloses === EDITOR_CHROME_A11Y.drawerEscapeCloses &&
    REWRITE_SATELLITE_A11Y.focusReturns === EDITOR_CHROME_A11Y.drawerFocusReturns &&
    REWRITE_SATELLITE_A11Y.noNestedMain === EDITOR_CHROME_A11Y.noNestedMain &&
    REWRITE_SATELLITE_A11Y.iconPlusText === EDITOR_CHROME_A11Y.iconPlusTextState &&
    REWRITE_SATELLITE_A11Y.skipLinkMainContent &&
    E12_A11Y_RULES.skipLinkHref === "#main-content" &&
    EDITOR_CHROME_A11Y.noSrGraphRewrite &&
    REWRITE_SATELLITE_A11Y.noSrGraphRewrite
  );
}

export function rewriteSatelliteA11yKeepsTouchBreakpoint(): boolean {
  return (
    REWRITE_SATELLITE_A11Y.touchInspectorFirstBreakpoint &&
    REWRITE_SATELLITE_A11Y.notAMobileApp &&
    EDITOR_CHROME_A11Y.inspectorFirstIsDocumentedGap &&
    EDITOR_CHROME_A11Y.notAMobileApp &&
    EDITOR_INSPECTOR_FIRST_MEDIA === "(max-width: 767px)" &&
    E12_A11Y_GAPS.includes("touch-inspector-first") &&
    E12_A11Y_GAPS.includes("canvas-sr-graph")
  );
}

export function rewriteSatelliteA11yInventedSrGraph(source: string): boolean {
  return /screen-reader graph rewrite|srGraphRewrite|aria-roledescription="graph"/.test(
    source,
  );
}

export function rewriteSatelliteA11yNestsMain(source: string): boolean {
  return /<main[\s>]/.test(source);
}

export function rewriteSatelliteLabeledControl(id: "add-action" | "start" | "activation"): string {
  return editorTopBarControlLabel(id);
}
