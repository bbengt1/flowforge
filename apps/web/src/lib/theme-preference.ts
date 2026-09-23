/**
 * G.3.9: zinc chrome on the V.1 token tree, plus a light follow map.
 *
 * Relates to #496 / Part of #412.
 *
 * Dark stays the default (`:root` in tokens.css). Light overrides the
 * same `--ff-*` variables on `:root[data-ff-theme="light"]`. Themeable
 * chrome uses the semantic names bg, fg, border, accent, and danger.
 * There is no second token file and no second component tree. Explorer
 * nav stays the dark rail so folder chrome does not shift. Contrast
 * stays on the axe gate. The preference is a `ff-theme` cookie, not a
 * secret and not the session cookie.
 *
 * Hard lines: ADV-021 · drafts never run · no secrets in browser/room ·
 * fail-closed · wizard/Login/Change-password never on embed · not an
 * n8n clone · vault display-name+UUID only.
 */

import {
  FF_ACCENT,
  FF_CANVAS,
  FF_DANGER,
  FF_DANGER_FOREGROUND,
  FF_DANGER_SURFACE,
  FF_EXPLORER_FOLDER,
  FF_EXPLORER_NAV,
  FF_MUTED,
  FF_SURFACE,
  FF_TEXT,
  n8nOrangePresent,
} from "./visual-tokens.ts";

export const G39_STORY = 496;
export const G39_EPIC = 412;
export const G39_ID = "G.3.9-zinc-tokens-light-theme" as const;

export const THEME_COOKIE = "ff-theme";
export const THEME_ATTR = "data-ff-theme";
export const THEME_MAX_AGE = 60 * 60 * 24 * 365;

export type ColorTheme = "dark" | "light";

/** G.3.12 closed the parked canvas stroke. Node family shapes stay. */
export const CANVAS_THEME_GAP =
  "WorkflowCanvas edge stroke uses var(--ff-accent) when selected and color-mix of var(--ff-text) at 28% otherwise. Node family shapes are unchanged.";

/** Themeable chrome. Axe owns contrast; this list is not a checker. */
export const SEMANTIC_CHROME = ["bg", "fg", "border", "accent", "danger"] as const;

export const LIGHT_CANVAS = "#e6e8ee";
export const LIGHT_SURFACE = "#f4f5f8";
export const LIGHT_TEXT = "#1a1d24";
export const LIGHT_MUTED = "#4e5563";
export const LIGHT_DANGER = "#9f1239";
export const LIGHT_DANGER_FOREGROUND = "#fff1f2";
export const LIGHT_DANGER_SURFACE = "#9f1239";
export const LIGHT_BORDER = "rgb(26 29 36 / 0.16)";
export const LIGHT_WARNING = "#b45309";
export const LIGHT_WARNING_FOREGROUND = "#78350f";
export const LIGHT_CODE_NUMBER = "#0369a1";
export const LIGHT_CODE_BOOLEAN = "#6b21a8";

export const DARK_WARNING = "#d97706";
export const DARK_WARNING_FOREGROUND = "#fde68a";
export const DARK_CODE_NUMBER = "#7dd3fc";
export const DARK_CODE_BOOLEAN = "#d8b4fe";
export const EXPLORER_INK = "#f4f4f5";

export const THEME_PREFERENCE = {
  darkIsDefault: true,
  lightIsFollowMap: true,
  sameTokenFile: true,
  noSecondThemeFile: true,
  noSecondComponentTree: true,
  lightViaThemeAttributeOnly: true,
  semanticChromeOnly: true,
  axeOwnsContrast: true,
  explorerRailStaysDark: true,
  draftsNeverRun: true,
  noSecretsInBrowser: true,
  themeCookieIsNotASecret: true,
  failClosedToDark: true,
  wizardNeverOnEmbed: true,
  loginNeverOnEmbed: true,
  changePasswordNeverOnEmbed: true,
  adv021HoldoutUnchanged: true,
  vaultDisplayNameUuidOnly: true,
  notAnN8nClone: true,
  canvasEdgeGap: false,
} as const;

/** Unknown values fail closed to the dark default. */
export function colorTheme(value: string | undefined | null): ColorTheme {
  return value?.trim().toLowerCase() === "light" ? "light" : "dark";
}

export function themeCookieAssignment(theme: ColorTheme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax`;
}

export function lightThemeBlock(tokensCss: string): string {
  const start = tokensCss.indexOf(`:root[${THEME_ATTR}="light"] {`);
  const end = tokensCss.indexOf("@theme", start);
  if (start < 0 || end < 0) {
    return "";
  }
  return tokensCss.slice(start, end);
}

export function darkDefaultUnchanged(): boolean {
  return (
    FF_CANVAS === "#0f1218" &&
    FF_SURFACE === "#171b22" &&
    FF_TEXT === "#f4f4f5" &&
    FF_MUTED === "#b4b8c0" &&
    FF_ACCENT === "#0f766e" &&
    FF_DANGER === "#fb7185" &&
    FF_DANGER_FOREGROUND === "#fff1f2" &&
    FF_DANGER_SURFACE === "#3f151c" &&
    FF_EXPLORER_NAV === "#1a1d24" &&
    FF_EXPLORER_FOLDER === "#e8c04a" &&
    EXPLORER_INK === "#f4f4f5" &&
    !n8nOrangePresent(LIGHT_CANVAS) &&
    !n8nOrangePresent(LIGHT_DANGER) &&
    !n8nOrangePresent(DARK_WARNING) &&
    !n8nOrangePresent(FF_EXPLORER_FOLDER)
  );
}

export function themePreferenceHoldsHardLines(): boolean {
  return (
    THEME_PREFERENCE.darkIsDefault &&
    THEME_PREFERENCE.sameTokenFile &&
    THEME_PREFERENCE.noSecondThemeFile &&
    THEME_PREFERENCE.noSecondComponentTree &&
    THEME_PREFERENCE.lightViaThemeAttributeOnly &&
    THEME_PREFERENCE.semanticChromeOnly &&
    THEME_PREFERENCE.axeOwnsContrast &&
    THEME_PREFERENCE.explorerRailStaysDark &&
    THEME_PREFERENCE.draftsNeverRun &&
    THEME_PREFERENCE.noSecretsInBrowser &&
    THEME_PREFERENCE.failClosedToDark &&
    THEME_PREFERENCE.wizardNeverOnEmbed &&
    THEME_PREFERENCE.loginNeverOnEmbed &&
    THEME_PREFERENCE.changePasswordNeverOnEmbed &&
    THEME_PREFERENCE.adv021HoldoutUnchanged &&
    THEME_PREFERENCE.vaultDisplayNameUuidOnly &&
    THEME_PREFERENCE.notAnN8nClone &&
    THEME_COOKIE === "ff-theme" &&
    colorTheme(undefined) === "dark" &&
    colorTheme("light") === "light"
  );
}
