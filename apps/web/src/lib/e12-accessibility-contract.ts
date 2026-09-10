/**
 * E12.3 Chloe accessibility checklist.
 *
 * Relates to #184 / Part of #181. Keep #184 open.
 *
 * Encodes the cheap a11y contracts from
 * docs/reference/e12-accessibility-review.md. Product chrome stays
 * the same — skip target, labels, roles, and keyboard helpers only.
 * Do not invent a canvas redesign or API/OpenAPI docs (Jonny).
 */

import {
  PALETTE_INPUT_LABEL,
  PALETTE_RESULTS_ID,
  PALETTE_SHORTCUT_HELP,
  paletteHighlightIndex,
} from "./command-palette.ts";
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

export function e12A11yMembershipIsolationNavIds(
  permissions: readonly string[] | null | undefined,
): string[] {
  return visibleWorkspaceNav(permissions)
    .filter((item) => item.id === "membership" || item.id === "isolation")
    .map((item) => item.id);
}

