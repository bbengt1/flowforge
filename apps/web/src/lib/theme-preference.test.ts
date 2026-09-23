import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CANVAS_THEME_GAP,
  DARK_CODE_BOOLEAN,
  DARK_CODE_NUMBER,
  DARK_WARNING,
  DARK_WARNING_FOREGROUND,
  EXPLORER_INK,
  G39_EPIC,
  G39_ID,
  G39_STORY,
  LIGHT_CANVAS,
  SEMANTIC_CHROME,
  LIGHT_CODE_BOOLEAN,
  LIGHT_CODE_NUMBER,
  LIGHT_DANGER,
  LIGHT_DANGER_FOREGROUND,
  LIGHT_DANGER_SURFACE,
  LIGHT_MUTED,
  LIGHT_SURFACE,
  LIGHT_TEXT,
  LIGHT_WARNING,
  LIGHT_WARNING_FOREGROUND,
  THEME_COOKIE,
  colorTheme,
  darkDefaultUnchanged,
  lightThemeBlock,
  themeCookieAssignment,
  themePreferenceHoldsHardLines,
} from "./theme-preference.ts";
import { FF_CANVAS, FF_EXPLORER_FOLDER, FF_EXPLORER_NAV, secondThemeTreePresent } from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

function source(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "embed") {
        continue;
      }
      walkTsx(path, out);
      continue;
    }
    if (entry.name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("G.3.9 zinc chrome on design tokens", () => {
  it("keeps dark as the default and adds light as a follow map", () => {
    assert.equal(G39_STORY, 496);
    assert.equal(G39_EPIC, 412);
    assert.equal(G39_ID, "G.3.9-zinc-tokens-light-theme");
    assert.equal(themePreferenceHoldsHardLines(), true);
    assert.equal(darkDefaultUnchanged(), true);
    assert.deepEqual(SEMANTIC_CHROME, ["bg", "fg", "border", "accent", "danger"]);
    const preference = source("src/lib/theme-preference.ts");
    assert.equal(preference.includes("contrastHolds"), false);
    assert.equal(preference.includes("contrastRatio"), false);
    assert.match(source("e2e/axe.ts"), /export async function expectNoBlockingAxeViolations/);
    assert.equal(colorTheme(undefined), "dark");
    assert.equal(colorTheme(null), "dark");
    assert.equal(colorTheme(""), "dark");
    assert.equal(colorTheme("dark"), "dark");
    assert.equal(colorTheme(" LIGHT "), "light");
    assert.equal(colorTheme("light; ff_session=x"), "dark");
    assert.equal(THEME_COOKIE, "ff-theme");
    const cookie = themeCookieAssignment("light");
    assert.match(cookie, /^ff-theme=light;/);
    assert.equal(cookie.includes("HttpOnly"), false);
    assert.equal(cookie.includes("ff_session"), false);
    assert.equal(cookie.includes("ff_csrf"), false);
  });

  it("overrides the same tokens and leaves the explorer rail dark", () => {
    const tokens = source("src/app/tokens.css");
    const globals = source("src/app/globals.css");
    const light = lightThemeBlock(tokens);
    assert.match(tokens, new RegExp(`--ff-canvas:\\s*${FF_CANVAS}`));
    assert.match(tokens, /--ff-surface:\s*#171b22/);
    assert.match(tokens, /--ff-text:\s*#f4f4f5/);
    assert.match(tokens, new RegExp(`--ff-explorer-nav:\\s*${FF_EXPLORER_NAV}`));
    assert.match(tokens, new RegExp(`--ff-explorer-folder:\\s*${FF_EXPLORER_FOLDER}`));
    assert.match(tokens, new RegExp(`--ff-explorer-ink:\\s*${EXPLORER_INK}`));
    assert.match(tokens, /--ff-explorer-row-selected:\s*color-mix\(in srgb, var\(--ff-explorer-ink\)/);
    assert.match(tokens, /--bg:\s*var\(--ff-surface\)/);
    assert.match(tokens, /--fg:\s*var\(--ff-text\)/);
    assert.match(tokens, /--border:\s*var\(--ff-border\)/);
    assert.match(tokens, /--accent:\s*var\(--ff-accent\)/);
    assert.match(tokens, /--danger:\s*var\(--ff-danger\)/);
    assert.match(tokens, /--color-bg:\s*var\(--bg\)/);
    assert.match(tokens, /--color-fg:\s*var\(--fg\)/);
    assert.match(tokens, /--color-accent:\s*var\(--accent\)/);
    assert.match(tokens, /--color-danger:\s*var\(--danger\)/);
    assert.match(tokens, /--color-border:\s*var\(--border\)/);
    assert.equal(tokens.includes("--ff-accent-text"), false);
    assert.equal(tokens.includes("--color-accent-text"), false);
    assert.equal(tokens.includes("--color-warning-foreground"), false);
    assert.match(tokens, new RegExp(`--ff-warning:\\s*${DARK_WARNING}`));
    assert.match(tokens, new RegExp(`--ff-warning-foreground:\\s*${DARK_WARNING_FOREGROUND}`));
    assert.match(tokens, new RegExp(`--ff-code-number:\\s*${DARK_CODE_NUMBER}`));
    assert.match(tokens, new RegExp(`--ff-code-boolean:\\s*${DARK_CODE_BOOLEAN}`));
    assert.match(light, new RegExp(`--ff-canvas:\\s*${LIGHT_CANVAS}`));
    assert.match(light, new RegExp(`--ff-surface:\\s*${LIGHT_SURFACE}`));
    assert.match(light, new RegExp(`--ff-text:\\s*${LIGHT_TEXT}`));
    assert.match(light, new RegExp(`--ff-muted:\\s*${LIGHT_MUTED}`));
    assert.match(light, new RegExp(`--ff-danger:\\s*${LIGHT_DANGER}`));
    assert.match(light, new RegExp(`--ff-danger-foreground:\\s*${LIGHT_DANGER_FOREGROUND}`));
    assert.match(light, new RegExp(`--ff-danger-surface:\\s*${LIGHT_DANGER_SURFACE}`));
    assert.equal(light.includes("--bg:"), false);
    assert.equal(light.includes("--fg:"), false);
    assert.equal(light.includes("--ff-accent-text"), false);
    assert.match(light, new RegExp(`--ff-warning:\\s*${LIGHT_WARNING}`));
    assert.match(light, new RegExp(`--ff-warning-foreground:\\s*${LIGHT_WARNING_FOREGROUND}`));
    assert.match(light, new RegExp(`--ff-code-number:\\s*${LIGHT_CODE_NUMBER}`));
    assert.match(light, new RegExp(`--ff-code-boolean:\\s*${LIGHT_CODE_BOOLEAN}`));
    assert.equal(light.includes("--ff-explorer-nav"), false);
    assert.equal(light.includes("--ff-explorer-folder"), false);
    assert.equal(light.includes("#f6f5f1"), false);
    assert.equal(existsSync(join(webRoot, "src/app/tokens-light.css")), false);
    assert.equal(secondThemeTreePresent(tokens), false);
    assert.equal(secondThemeTreePresent(globals), false);
    assert.equal(globals.includes("data-theme"), false);
    assert.match(globals, /color:\s*var\(--ff-explorer-ink\)/);
    assert.match(globals, /\.ff-loud-warning[\s\S]*var\(--ff-warning-foreground\)/);
    assert.match(globals, /\.ff-explorer-drafts-banner/);
  });

  it("selects the theme from a cookie and keeps embed auth chrome off", () => {
    const layout = source("src/app/layout.tsx");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const settings = source("src/app/settings/page.tsx");
    const gate = source("src/components/embed/EmbedExchangeGate.tsx");
    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.match(layout, /data-ff-tokens=\{FF_SHELL_ROOT_VALUE\}/);
    assert.match(layout, /data-ff-theme=\{colorTheme\(cookieStore\.get\(THEME_COOKIE\)\?\.value\)\}/);
    assert.match(layout, /colorTheme=\{colorTheme\(cookieStore\.get\(THEME_COOKIE\)\?\.value\)\}/);
    assert.doesNotMatch(layout, /LoginChrome|ChangePasswordChrome|FirstRunWizard/);
    assert.match(shell, /<ThemePreferenceControl theme=\{colorTheme\} \/>/);
    const embedBranchStart = shell.indexOf("const shell = embed ? (");
    const embedBranchEnd = shell.indexOf(") : (", embedBranchStart);
    const embedBranch = shell.slice(embedBranchStart, embedBranchEnd);
    assert.equal(embedBranch.includes("ThemePreferenceControl"), false);
    assert.match(settings, /variant="settings"/);
    assert.match(settings, /ThemePreferenceControl/);
    assert.doesNotMatch(settings, /localStorage|FirstRunWizard/);
    assert.match(gate, /bg-zinc-900/);
    assert.doesNotMatch(gate, /LoginChrome|FirstRunWizard|ChangePasswordChrome/);
    assert.doesNotMatch(embedChrome, /LoginChrome|FirstRunWizard|ChangePasswordChrome|ThemePreferenceControl/);
    assert.match(source("src/components/session/LoginChrome.tsx"), /ThemePreferenceControl/);
    assert.match(source("src/components/session/ChangePasswordChrome.tsx"), /ThemePreferenceControl/);
    assert.match(source("src/components/bootstrap/FirstRunWizard.tsx"), /ThemePreferenceControl/);
    assert.equal(source("src/components/session/LoginChrome.tsx").includes("localStorage"), false);
    assert.equal(source("src/components/session/ChangePasswordChrome.tsx").includes("localStorage"), false);
    assert.equal(source("src/components/bootstrap/FirstRunWizard.tsx").includes("localStorage"), false);
  });

  it("uses tokens on Field, Dialog, and ConfirmDestructive", () => {
    const field = source("src/components/a11y/Field.tsx");
    const dialog = source("src/components/a11y/Dialog.tsx");
    const confirm = source("src/components/a11y/ConfirmDestructive.tsx");
    assert.match(field, /text-fg/);
    assert.match(field, /text-danger/);
    assert.doesNotMatch(field, /text-zinc-|text-rose-900|bg-white|text-muted-foreground|text-destructive/);
    assert.doesNotMatch(dialog, /zinc-|bg-white/);
    assert.match(confirm, /FF_LOUD_DANGER_CLASS/);
    assert.match(confirm, /FF_OVERVIEW_DIALOG_CLASS/);
    assert.match(confirm, /FF_OVERVIEW_TITLE_CLASS/);
    assert.match(confirm, /FF_OVERVIEW_MUTED_CLASS/);
    assert.doesNotMatch(confirm, /zinc-|bg-white|text-rose-/);
  });

  it("drops hardcoded zinc chrome outside the embed holdout and canvas edge", () => {
    const zincChrome = /(?:text|border|divide|decoration|caret)-zinc-|bg-zinc-(?:50|100)\b|bg-white\b/;
    const offenders: string[] = [];
    for (const path of walkTsx(join(webRoot, "src"))) {
      const text = readFileSync(path, "utf8");
      if (!zincChrome.test(text)) {
        continue;
      }
      const relative = path.slice(webRoot.length + 1);
      const allowedWhite = (text.match(/bg-white\b/g) ?? []).every((item) => item);
      const onlyScrimOrChip =
        !/(?:text|border|divide|decoration|caret)-zinc-/.test(text) &&
        !/bg-zinc-(?:50|100)\b/.test(text);
      if (onlyScrimOrChip && allowedWhite && (text.includes("hover:bg-rose-50") || text.includes("hover:bg-amber-100") || !text.includes("bg-white"))) {
        continue;
      }
      offenders.push(relative);
    }
    assert.deepEqual(offenders, []);
    const canvas = source("src/components/workflows/WorkflowCanvas.tsx");
    assert.match(canvas, /rgb\(255 255 255 \/ 0\.28\)/);
    assert.match(CANVAS_THEME_GAP, /WorkflowCanvas/);
  });
});
