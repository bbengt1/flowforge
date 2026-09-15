import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { E12_A11Y_FIXES, E12_A11Y_RULES } from "./e12-accessibility-contract.ts";
import {
  FF_ACCENT,
  FF_ACCENT_FOREGROUND,
  FF_CANVAS,
  FF_COLOR_TOKENS,
  FF_CSS_VARIABLES,
  FF_DANGER,
  FF_FOCUS_RING,
  FF_MUTED,
  FF_RADIUS,
  FF_RADIUS_LG,
  FF_RADIUS_SM,
  FF_SHELL_ROOT_ATTR,
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
  FF_SPACE,
  FF_SURFACE,
  FF_TEXT,
  FF_TYPE_BODY,
  FF_TYPE_CAPTION,
  FF_TYPE_HEADING,
  FF_TYPE_PAGE,
  FORBIDDEN_THEME_TREES,
  N8N_ORANGE_TOKENS,
  SHADCN_TOKEN_MAP,
  V1_BRIEF,
  V1_EPIC,
  V1_HELP,
  V1_ID,
  V1_KEEP_STORY_OPEN,
  V1_CHROME_SOURCES,
  V1_SHELL_SOURCES,
  V1_STORY,
  V1_TOKEN_FILE,
  VISUAL_TOKENS,
  contrastHolds,
  contrastRatio,
  creamCanvasPresent,
  huesAreDistinct,
  n8nOrangePresent,
  secondThemeTreePresent,
  shellRootConsumesTokens,
  skipLinkAndFocusVisibleHeld,
  tokenFileIsShared,
  visualTokensHoldHardLines,
} from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("V.1 Token foundation", () => {
  it("keeps #357 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V1_STORY, 357);
    assert.equal(V1_EPIC, 353);
    assert.equal(V1_KEEP_STORY_OPEN, true);
    assert.equal(V1_ID, "V.1-token-foundation");
    assert.equal(V1_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(V1_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(VISUAL_TOKENS.keep357Open, true);
    assert.equal(VISUAL_TOKENS.foundationOnly, true);
    assert.equal(VISUAL_TOKENS.noBigBangRestyle, true);
    assert.equal(VISUAL_TOKENS.jonnyNoneExpected, true);
    assert.match(V1_HELP, /one teal-family accent/);
    assert.match(V1_HELP, /No n8n orange/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /#357/);
    assert.match(frontend, /keep #357 open/i);
    assert.match(frontend, /token foundation/i);
    const northStar = readFileSync(
      join(here, "..", "..", "..", "..", V1_BRIEF),
      "utf8",
    );
    assert.match(northStar, /V\.1 — Token foundation/);
    assert.match(northStar, /#0f766e/);
  });

  it("documents dark-first charcoal, one accent, danger/denial, type, space, and radius", () => {
    const tokens = source(V1_TOKEN_FILE);
    for (const name of FF_CSS_VARIABLES) {
      assert.match(tokens, new RegExp(`${name}:`));
    }
    assert.match(tokens, new RegExp(`--ff-canvas:\\s*${FF_CANVAS}`));
    assert.match(tokens, new RegExp(`--ff-surface:\\s*${FF_SURFACE}`));
    assert.match(tokens, new RegExp(`--ff-text:\\s*${FF_TEXT}`));
    assert.match(tokens, new RegExp(`--ff-muted:\\s*${FF_MUTED}`));
    assert.match(tokens, new RegExp(`--ff-accent:\\s*${FF_ACCENT}`));
    assert.match(tokens, new RegExp(`--ff-danger:\\s*${FF_DANGER}`));
    assert.match(tokens, new RegExp(`--ff-focus-ring:\\s*${FF_FOCUS_RING}`));
    assert.match(tokens, new RegExp(`--ff-space:\\s*${FF_SPACE}`));
    assert.match(tokens, new RegExp(`--ff-radius-sm:\\s*${FF_RADIUS_SM}`));
    assert.match(tokens, new RegExp(`--ff-radius:\\s*${FF_RADIUS}`));
    assert.match(tokens, new RegExp(`--ff-radius-lg:\\s*${FF_RADIUS_LG}`));
    assert.match(tokens, new RegExp(`--ff-type-caption:\\s*${FF_TYPE_CAPTION}`));
    assert.match(tokens, new RegExp(`--ff-type-body:\\s*${FF_TYPE_BODY}`));
    assert.match(tokens, new RegExp(`--ff-type-page:\\s*${FF_TYPE_PAGE}`));
    assert.match(tokens, new RegExp(`--ff-type-heading:\\s*${FF_TYPE_HEADING}`));
    assert.equal(FF_ACCENT, "#0f766e");
    assert.equal(FF_FOCUS_RING, FF_ACCENT);
    assert.equal(FF_SPACE, "4px");
    assert.equal(VISUAL_TOKENS.oneAccent, true);
    assert.equal(VISUAL_TOKENS.darkFirstCharcoal, true);
    assert.equal(VISUAL_TOKENS.spaceBase4px, true);
    assert.equal(VISUAL_TOKENS.radius8to12, true);
    assert.equal(Object.keys(FF_COLOR_TOKENS).includes("canvas"), true);
    assert.equal(creamCanvasPresent(tokens), false);
    assert.doesNotMatch(tokens, /#f6f5f1/);
    assert.doesNotMatch(tokens, /--ff-canvas:\s*#000\b/);
  });

  it("maps shadcn aliases to FlowForge tokens, not zinc/orange skin", () => {
    const tokens = source(V1_TOKEN_FILE);
    assert.equal(SHADCN_TOKEN_MAP.primary, "var(--ff-accent)");
    assert.equal(SHADCN_TOKEN_MAP.destructive, "var(--ff-danger)");
    assert.equal(SHADCN_TOKEN_MAP.ring, "var(--ff-focus-ring)");
    assert.equal(SHADCN_TOKEN_MAP.background, "var(--ff-canvas)");
    assert.equal(SHADCN_TOKEN_MAP.card, "var(--ff-surface)");
    assert.equal(SHADCN_TOKEN_MAP.radius, "var(--ff-radius)");
    for (const [alias, value] of Object.entries(SHADCN_TOKEN_MAP)) {
      assert.match(tokens, new RegExp(`--${alias}:\\s*${value.replace(/[()]/g, "\\$&")}`));
    }
    assert.equal(VISUAL_TOKENS.shadcnFriendlyMapping, true);
    assert.equal(VISUAL_TOKENS.notDefaultShadcnZincOrange, true);
    assert.doesNotMatch(tokens, /--primary:\s*#f97316/);
    assert.doesNotMatch(tokens, /oklch\(0\.705 0\.213 47\.604\)/);
  });

  it("rejects n8n orange and a second theme tree", () => {
    for (const relative of V1_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(n8nOrangePresent(text), false, relative);
      assert.equal(secondThemeTreePresent(text), false, relative);
    }
    const tokens = source(V1_TOKEN_FILE);
    const globals = source("src/app/globals.css");
    const embed = source("src/components/embed/EmbedChrome.tsx");
    for (const orange of N8N_ORANGE_TOKENS) {
      assert.doesNotMatch(tokens, new RegExp(orange.replace(/[()]/g, "\\$&"), "i"));
    }
    for (const tree of FORBIDDEN_THEME_TREES) {
      assert.equal(tokens.includes(tree), false, tree);
      assert.equal(globals.includes(tree), false, tree);
    }
    assert.equal(tokenFileIsShared(globals, embed), true);
    assert.equal(VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed, true);
    assert.equal(VISUAL_TOKENS.noSecondThemeTree, true);
    assert.equal(VISUAL_TOKENS.lightThemeNotRequired, true);
    assert.equal(globals.includes("tokens.css"), true);
    assert.equal(embed.includes("embed-tokens"), false);
  });

  it("applies tokens on the shell root for standalone and embed", () => {
    assert.equal(FF_SHELL_ROOT_CLASS, "ff-shell");
    assert.equal(FF_SHELL_ROOT_ATTR, "data-ff-tokens");
    assert.equal(FF_SHELL_ROOT_VALUE, "v1");
    for (const relative of V1_SHELL_SOURCES) {
      const text = source(relative);
      assert.equal(shellRootConsumesTokens(text), true, relative);
      assert.match(text, /data-ff-tokens=\{FF_SHELL_ROOT_VALUE\}/);
      assert.match(text, /FF_SHELL_ROOT_CLASS/);
    }
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.equal((shell.match(/FF_SHELL_ROOT_CLASS/g) ?? []).length >= 2, true);
    assert.match(shell, /href="#main-content"/);
    assert.match(shell, /className="skip-link"/);
    const globals = source("src/app/globals.css");
    assert.match(globals, /\.ff-shell\s*\{/);
    assert.match(globals, /background:\s*var\(--ff-canvas\)/);
    assert.match(globals, /color:\s*var\(--ff-text\)/);
    assert.match(globals, /font-size:\s*var\(--ff-type-body\)/);
    assert.match(globals, /--radius:\s*var\(--ff-radius\)/);
  });

  it("holds skip-link, focus-visible, and contrast on dark cards", () => {
    const globals = source("src/app/globals.css");
    assert.equal(skipLinkAndFocusVisibleHeld(globals), true);
    assert.ok(E12_A11Y_FIXES.includes("skip-link"));
    assert.ok(E12_A11Y_FIXES.includes("focus-visible"));
    assert.equal(E12_A11Y_RULES.skipLinkHref, "#main-content");
    assert.match(globals, /\.skip-link:focus-visible/);
    assert.match(globals, /:focus-visible \{/);
    assert.match(globals, /outline:\s*2px solid var\(--ff-focus-ring\)/);
    assert.match(globals, /\.skip-link[\s\S]*background:\s*var\(--ff-accent\)/);
    assert.match(globals, /\.skip-link[\s\S]*color:\s*var\(--ff-accent-foreground\)/);

    assert.equal(contrastHolds(FF_TEXT, FF_CANVAS), true);
    assert.equal(contrastHolds(FF_TEXT, FF_SURFACE), true);
    assert.equal(contrastHolds(FF_MUTED, FF_CANVAS), true);
    assert.equal(contrastHolds(FF_MUTED, FF_SURFACE), true);
    assert.equal(contrastHolds(FF_DANGER, FF_CANVAS), true);
    assert.equal(contrastHolds(FF_DANGER, FF_SURFACE), true);
    assert.equal(contrastHolds(FF_ACCENT_FOREGROUND, FF_ACCENT), true);
    assert.equal(contrastRatio(FF_TEXT, FF_SURFACE) >= 4.5, true);
    assert.equal(huesAreDistinct(FF_ACCENT, FF_DANGER), true);
    assert.equal(VISUAL_TOKENS.contrastHoldsOnDarkCards, true);
    assert.equal(VISUAL_TOKENS.dangerDenialDistinctFromAccent, true);
    assert.equal(VISUAL_TOKENS.isolationSuccessIsDenial, true);
    assert.equal(visualTokensHoldHardLines(), true);
  });
});
