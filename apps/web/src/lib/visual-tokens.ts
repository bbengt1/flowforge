/**
 * V.1: Token foundation.
 *
 * Relates to #357 / Part of #353. Keep #357 open.
 *
 * Chloe UI only. Named tokens for the signed visual north star
 * (docs/architecture/flowforge-visual-ia-north-star.md § tokens / V.1).
 * Standalone and `/embed/v1` share this one tree. No second theme.
 * Light theme is not required. Do not adopt default shadcn zinc/orange.
 *
 * Apply at the shell root. Do not big-bang restyle Overview / editor /
 * vault in this slice (V.2+). Components consume these names — do not
 * proliferate one-off hex after this PR.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID ·
 * ADV-021/024 · isolation success is a denial · not an n8n clone ·
 * no greenfield APIs.
 */

import { E12_A11Y_FIXES, E12_A11Y_RULES } from "./e12-accessibility-contract.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";

export const V1_STORY = 357;
export const V1_EPIC = 353;
export const V1_KEEP_STORY_OPEN = true;
export const V1_ID = "V.1-token-foundation" as const;
export const V1_BRIEF = "docs/architecture/flowforge-visual-ia-north-star.md";
export const V1_TOKEN_FILE = "src/app/tokens.css";

export const V1_HELP =
  "Dark-first charcoal canvas, lifted surface, text, muted, one teal-family accent, danger/denial, and focus ring. Type scale + 4px space + 8–12px radius. Standalone and /embed/v1 share one token file. Skip link, focus-visible, and contrast hold on dark cards. Isolation success is a denial. No n8n orange. No second theme tree.";

export const VISUAL_TOKENS = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritE12A11y: true,
  d6MigrateInPlace: true,
  foundationOnly: true,
  noBigBangRestyle: true,
  darkFirstCharcoal: true,
  oneAccent: true,
  accentIsTealFamily: true,
  dangerDenialDistinctFromAccent: true,
  isolationSuccessIsDenial: true,
  typeScaleDocumented: true,
  spaceBase4px: true,
  radius8to12: true,
  namedCssVariables: true,
  shadcnFriendlyMapping: true,
  notDefaultShadcnZincOrange: true,
  sameTokenFileStandaloneAndEmbed: true,
  noSecondThemeTree: true,
  lightThemeNotRequired: true,
  skipLinkHeld: true,
  focusVisibleHeld: true,
  contrastHoldsOnDarkCards: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  noGreenfieldApis: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  keep357Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_SHELL_ROOT_CLASS = "ff-shell";
export const FF_SHELL_ROOT_ATTR = "data-ff-tokens";
export const FF_SHELL_ROOT_VALUE = "v1";

/** Dark-first charcoal — not pure #000, not cream #f6f5f1, not navy dashboard. */
export const FF_CANVAS = "#0f1218";
/** Lifted one step (border + ~2% lighter fill). */
export const FF_SURFACE = "#171b22";
export const FF_TEXT = "#f4f4f5";
/** Secondary meta — still WCAG AA on canvas/surface. */
export const FF_MUTED = "#b4b8c0";
/** Starting one accent: keep current teal-family focus. */
export const FF_ACCENT = "#0f766e";
export const FF_ACCENT_FOREGROUND = "#ecfdf8";
/** Denial / danger — distinct from the teal accent. Isolation success stays a denial. */
export const FF_DANGER = "#fb7185";
export const FF_DANGER_FOREGROUND = "#fff1f2";
export const FF_DANGER_SURFACE = "#3f151c";
export const FF_FOCUS_RING = FF_ACCENT;
export const FF_BORDER = "rgb(255 255 255 / 0.10)";

export const FF_SPACE = "4px";
export const FF_SPACE_2 = "8px";
export const FF_SPACE_3 = "12px";
export const FF_SPACE_4 = "16px";

export const FF_RADIUS_SM = "8px";
export const FF_RADIUS = "10px";
export const FF_RADIUS_LG = "12px";

export const FF_FONT_SANS = "ui-sans-serif, system-ui, sans-serif";

export const FF_TYPE_CAPTION = "0.75rem";
export const FF_TYPE_BODY = "0.875rem";
export const FF_TYPE_PAGE = "1rem";
export const FF_TYPE_HEADING = "1.875rem";

export const FF_COLOR_TOKENS = {
  canvas: FF_CANVAS,
  surface: FF_SURFACE,
  text: FF_TEXT,
  muted: FF_MUTED,
  accent: FF_ACCENT,
  accentForeground: FF_ACCENT_FOREGROUND,
  danger: FF_DANGER,
  dangerForeground: FF_DANGER_FOREGROUND,
  dangerSurface: FF_DANGER_SURFACE,
  focusRing: FF_FOCUS_RING,
  border: FF_BORDER,
} as const;

export const FF_SPACE_TOKENS = {
  base: FF_SPACE,
  2: FF_SPACE_2,
  3: FF_SPACE_3,
  4: FF_SPACE_4,
} as const;

export const FF_RADIUS_TOKENS = {
  sm: FF_RADIUS_SM,
  md: FF_RADIUS,
  lg: FF_RADIUS_LG,
} as const;

export const FF_TYPE_TOKENS = {
  caption: FF_TYPE_CAPTION,
  body: FF_TYPE_BODY,
  page: FF_TYPE_PAGE,
  heading: FF_TYPE_HEADING,
} as const;

/**
 * shadcn-friendly aliases. Later primitives consume these names.
 * Values stay FlowForge — not default zinc/orange skin.
 */
export const SHADCN_TOKEN_MAP = {
  background: "var(--ff-canvas)",
  foreground: "var(--ff-text)",
  card: "var(--ff-surface)",
  "card-foreground": "var(--ff-text)",
  popover: "var(--ff-surface)",
  "popover-foreground": "var(--ff-text)",
  primary: "var(--ff-accent)",
  "primary-foreground": "var(--ff-accent-foreground)",
  secondary: "var(--ff-surface)",
  "secondary-foreground": "var(--ff-text)",
  muted: "var(--ff-surface)",
  "muted-foreground": "var(--ff-muted)",
  destructive: "var(--ff-danger)",
  "destructive-foreground": "var(--ff-danger-foreground)",
  border: "var(--ff-border)",
  input: "var(--ff-border)",
  ring: "var(--ff-focus-ring)",
  radius: "var(--ff-radius)",
} as const;

export const FF_CSS_VARIABLES = [
  "--ff-canvas",
  "--ff-surface",
  "--ff-text",
  "--ff-muted",
  "--ff-accent",
  "--ff-accent-foreground",
  "--ff-danger",
  "--ff-danger-foreground",
  "--ff-danger-surface",
  "--ff-focus-ring",
  "--ff-border",
  "--ff-space",
  "--ff-space-2",
  "--ff-space-3",
  "--ff-space-4",
  "--ff-radius-sm",
  "--ff-radius",
  "--ff-radius-lg",
  "--ff-font-sans",
  "--ff-type-caption",
  "--ff-type-body",
  "--ff-type-page",
  "--ff-type-heading",
] as const;

export const N8N_ORANGE_TOKENS = [
  "#ea4b71",
  "#ff6d5a",
  "#e99854",
  "#ff6d5a",
  "#ea4b71",
  "#f97316",
  "#fb923c",
  "#ff6f5c",
  "oklch(0.705 0.213 47.604)",
] as const;

export const FORBIDDEN_THEME_TREES = [
  '[data-theme="light"]',
  "[data-theme='light']",
  '[data-theme="embed"]',
  ".theme-light",
  ".embed-theme",
  "embed-tokens.css",
  "tokens-embed.css",
  "tokens-light.css",
] as const;

export const FORBIDDEN_CANVAS = ["#f6f5f1", "#000", "#000000", "#ffffff"] as const;

export const V1_SOURCES = [
  "src/app/tokens.css",
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/lib/visual-tokens.ts",
  "src/components/shell/WorkspaceShell.tsx",
] as const;

/** Chrome that must not carry n8n orange or a second theme tree. */
export const V1_CHROME_SOURCES = [
  "src/app/tokens.css",
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/components/shell/WorkspaceShell.tsx",
] as const;

export const V1_SHELL_SOURCES = [
  "src/components/shell/WorkspaceShell.tsx",
  "src/app/layout.tsx",
] as const;

function parseHex(hex: string): { r: number; g: number; b: number } {
  const raw = hex.replace("#", "").trim();
  if (raw.length !== 6 || /[^0-9a-f]/i.test(raw)) {
    throw new Error(`expected #rrggbb, got ${hex}`);
  }
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function channelLuminance(value: number): number {
  const n = value / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastHolds(
  foreground: string,
  background: string,
  minimum = 4.5,
): boolean {
  return contrastRatio(foreground, background) >= minimum;
}

export function hueDegrees(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) {
    return 0;
  }
  let hue = 0;
  if (max === rn) {
    hue = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }
  hue = Math.round(hue * 60);
  return hue < 0 ? hue + 360 : hue;
}

export function huesAreDistinct(a: string, b: string, minimum = 60): boolean {
  const delta = Math.abs(hueDegrees(a) - hueDegrees(b));
  return Math.min(delta, 360 - delta) >= minimum;
}

export function n8nOrangePresent(source: string): boolean {
  const lower = source.toLowerCase();
  return N8N_ORANGE_TOKENS.some((token) => lower.includes(token.toLowerCase()));
}

export function secondThemeTreePresent(source: string): boolean {
  return FORBIDDEN_THEME_TREES.some((token) => source.includes(token));
}

export function creamCanvasPresent(source: string): boolean {
  return (
    source.includes("#f6f5f1") ||
    /--ff-canvas:\s*#000(?:000)?\b/.test(source)
  );
}

export function tokenFileIsShared(globals: string, embedChrome: string): boolean {
  return (
    globals.includes("tokens.css") &&
    !embedChrome.includes("embed-tokens") &&
    !embedChrome.includes("tokens-embed") &&
    !embedChrome.includes("data-theme")
  );
}

export function shellRootConsumesTokens(source: string): boolean {
  return (
    source.includes("FF_SHELL_ROOT_CLASS") &&
    source.includes("FF_SHELL_ROOT_VALUE") &&
    source.includes("data-ff-tokens")
  );
}

export function skipLinkAndFocusVisibleHeld(globals: string): boolean {
  return (
    E12_A11Y_FIXES.includes("skip-link") &&
    E12_A11Y_FIXES.includes("focus-visible") &&
    E12_A11Y_RULES.skipLinkHref === "#main-content" &&
    globals.includes(".skip-link") &&
    globals.includes(":focus-visible") &&
    globals.includes("var(--ff-focus-ring)") &&
    globals.includes("var(--ff-accent)")
  );
}

export function visualTokensHoldHardLines(): boolean {
  return (
    VISUAL_TOKENS.yamlIsSourceOfTruth &&
    VISUAL_TOKENS.draftsNeverRun &&
    VISUAL_TOKENS.vaultDisplayNameUuidOnly &&
    VISUAL_TOKENS.adv021ChromeFromSessionEmbedOnly &&
    VISUAL_TOKENS.adv024MembershipIsolationStayGrantGated &&
    VISUAL_TOKENS.isolationSuccessIsDenial &&
    VISUAL_TOKENS.notAnN8nClone &&
    VISUAL_TOKENS.noN8nOrange &&
    VISUAL_TOKENS.noSecondThemeTree &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    VISUAL_TOKENS.dangerDenialDistinctFromAccent &&
    VISUAL_TOKENS.noGreenfieldApis &&
    VISUAL_TOKENS.keep357Open &&
    huesAreDistinct(FF_ACCENT, FF_DANGER) &&
    contrastHolds(FF_TEXT, FF_CANVAS) &&
    contrastHolds(FF_TEXT, FF_SURFACE) &&
    contrastHolds(FF_MUTED, FF_CANVAS) &&
    contrastHolds(FF_MUTED, FF_SURFACE) &&
    contrastHolds(FF_DANGER, FF_CANVAS) &&
    contrastHolds(FF_DANGER, FF_SURFACE) &&
    contrastHolds(FF_ACCENT_FOREGROUND, FF_ACCENT) &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_SPACE === "4px" &&
    FF_RADIUS_SM === "8px" &&
    FF_RADIUS_LG === "12px" &&
    !FORBIDDEN_CANVAS.includes(FF_CANVAS as (typeof FORBIDDEN_CANVAS)[number])
  );
}
