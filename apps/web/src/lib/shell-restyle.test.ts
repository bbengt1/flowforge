import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./session-embed-contract.ts";
import {
  EDITOR_ICON_RAIL_MARKS,
  FF_NAV_ITEM_ACTIVE_CLASS,
  FF_NAV_ITEM_CLASS,
  FF_SHELL_ASIDE_CLASS,
  FF_SHELL_ATTR,
  FF_SHELL_HEADER_CLASS,
  FF_SHELL_VALUE,
  LIGHT_SHELL_TOKENS,
  SHELL_NAV_GROUP_LABELS,
  SHELL_NAV_GROUP_ORDER,
  SHELL_RESTYLE,
  V2_BRIEF,
  V2_CHROME_SOURCES,
  V2_EPIC,
  V2_HELP,
  V2_ID,
  V2_KEEP_STORY_OPEN,
  V2_OUT_OF_SCOPE_SOURCES,
  V2_SOURCES,
  V2_STORY,
  V2_TOKEN_FILE,
  activeNavUsesOneAccent,
  embedHostQueryIsDisplayOnly,
  embedMissingBindIsAdv021Alert,
  embedNavOmitsMembershipIsolationChrome,
  embedSharesShellClasses,
  editorIconRailIsOriginal,
  lightShellTokenPresent,
  productNavOmitsMembershipIsolationChrome,
  shellChromeRejectsForbiddenLook,
  shellRestyleHoldsHardLines,
  shellRestyleIsNotSurfaceRewrite,
  shellUsesV1Tokens,
} from "./shell-restyle.ts";
import {
  FF_ACCENT,
  FF_CANVAS,
  FF_SURFACE,
  VISUAL_TOKENS,
} from "./visual-tokens.ts";
import {
  editorWorkspaceNav,
  visibleWorkspaceNav,
  workspaceNavMark,
} from "./workspace-nav.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

const viewer = [
  "workflow.view",
  "execution.view",
  "approval.view",
  "opsconfig.view",
  "alert.view",
];
const admin = [...viewer, "workspace.administer"];

describe("V.2 Shell restyle", () => {
  it("keeps #358 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V2_STORY, 358);
    assert.equal(V2_EPIC, 353);
    assert.equal(V2_KEEP_STORY_OPEN, true);
    assert.equal(V2_ID, "V.2-shell-restyle");
    assert.equal(V2_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(V2_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(SHELL_RESTYLE.keep358Open, true);
    assert.equal(SHELL_RESTYLE.uiOnly, true);
    assert.equal(SHELL_RESTYLE.inheritV1Tokens, true);
    assert.equal(SHELL_RESTYLE.jonnyNoneExpected, true);
    assert.equal(SHELL_RESTYLE.notOverviewRewrite, true);
    assert.equal(SHELL_RESTYLE.notEditorRewrite, true);
    assert.match(V2_HELP, /one teal accent/);
    assert.match(V2_HELP, /ADV-021/);
    assert.match(V2_HELP, /No n8n orange/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /#358/);
    assert.match(frontend, /keep #358 open/i);
    assert.match(frontend, /shell restyle/i);
    assert.match(frontend, /keep #357 open/i);
    const northStar = readFileSync(
      join(here, "..", "..", "..", "..", V2_BRIEF),
      "utf8",
    );
    assert.match(northStar, /V\.2 — Shell restyle/);
    assert.match(northStar, /Dark shell on every product route/);
    const contract = source("src/lib/shell-restyle.ts");
    assert.match(contract, /Keep #358 open/);
    assert.doesNotMatch(contract, /Fixes #358|Closes #358|Close #358/);
  });

  it("applies dark charcoal V.1 tokens on every product shell surface", () => {
    const globals = source("src/app/globals.css");
    assert.equal(shellUsesV1Tokens(globals), true);
    assert.equal(FF_SHELL_ASIDE_CLASS, "ff-shell-aside");
    assert.equal(FF_SHELL_HEADER_CLASS, "ff-shell-header");
    assert.equal(FF_SHELL_ATTR, "data-ff-shell");
    assert.equal(FF_SHELL_VALUE, "v2");
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_SURFACE, "#171b22");
    assert.equal(FF_ACCENT, "#0f766e");
    assert.equal(VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed, true);
    assert.equal(SHELL_RESTYLE.darkShellOnEveryProductRoute, true);
    assert.equal(SHELL_RESTYLE.charcoalCanvasAndSurface, true);
    assert.match(globals, /\.ff-shell-aside\s*\{[\s\S]*background:\s*var\(--ff-surface\)/);
    assert.match(globals, /\.ff-shell-header\s*\{[\s\S]*background:\s*var\(--ff-surface\)/);
    assert.match(globals, /\.ff-nav-item-active[\s\S]*background:\s*var\(--ff-accent\)/);
    assert.doesNotMatch(globals, /#f6f5f1/);
    assert.doesNotMatch(globals, /#f97316/);

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.match(shell, /FF_SHELL_ASIDE_CLASS/);
    assert.match(shell, /FF_SHELL_HEADER_CLASS/);
    assert.match(shell, /data-ff-shell=\{FF_SHELL_VALUE\}/);
    const embed = source("src/components/embed/EmbedChrome.tsx");
    assert.match(embed, /FF_SHELL_HEADER_CLASS/);
    assert.match(embed, /data-ff-shell=\{FF_SHELL_VALUE\}/);
  });

  it("uses the one teal accent on the active nav item", () => {
    assert.equal(FF_NAV_ITEM_CLASS, "ff-nav-item");
    assert.equal(FF_NAV_ITEM_ACTIVE_CLASS, "ff-nav-item-active");
    assert.equal(SHELL_RESTYLE.oneAccentOnActiveNav, true);
    assert.equal(SHELL_RESTYLE.accentIsTealFamily, true);
    const nav = source("src/components/shell/WorkspaceNav.tsx");
    const embed = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(activeNavUsesOneAccent(nav), true);
    assert.equal(activeNavUsesOneAccent(embed), true);
    assert.deepEqual([...SHELL_NAV_GROUP_ORDER], [
      "build",
      "observe",
      "vault",
      "settings",
    ]);
    assert.equal(SHELL_NAV_GROUP_LABELS.build, "Build");
    assert.equal(SHELL_NAV_GROUP_LABELS.observe, "Observe");
    assert.equal(SHELL_NAV_GROUP_LABELS.vault, "Vault");
    assert.equal(SHELL_NAV_GROUP_LABELS.settings, "Settings");
    assert.match(nav, /SHELL_NAV_GROUP_LABELS/);
    const items = visibleWorkspaceNav(admin);
    assert.equal(items.find((item) => item.id === "workflows")?.group, "build");
    assert.equal(items.find((item) => item.id === "executions")?.group, "observe");
    assert.equal(
      visibleWorkspaceNav([...admin, "credential.view"]).find(
        (item) => item.id === "credentials",
      )?.group,
      "vault",
    );
    assert.equal(items.find((item) => item.id === "settings")?.group, "settings");
  });

  it("keeps the editor collapsed to an original icon-rail", () => {
    assert.equal(SHELL_RESTYLE.editorCollapsesToOriginalIconRail, true);
    assert.equal(workspaceNavMark("workflows"), EDITOR_ICON_RAIL_MARKS.workflows);
    assert.equal(workspaceNavMark("workflows"), "Wf");
    assert.equal(workspaceNavMark("settings"), "St");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.equal(editorIconRailIsOriginal(shell), true);
    assert.match(shell, /data-nav-mode=\{navMode\}/);
    assert.match(shell, /variant=\{editorRoute && !navOpen \? "rail" : "full"\}/);
    const nav = source("src/components/shell/WorkspaceNav.tsx");
    assert.match(nav, /workspaceNavMark\(item\.id\)/);
    assert.doesNotMatch(nav, /n8n-logo|Execute workflow|wf-node-default/);
  });

  it("keeps Membership / Isolation off product chrome", () => {
    assert.equal(SHELL_RESTYLE.membershipIsolationOffProductChrome, true);
    assert.equal(SHELL_RESTYLE.settingsMayLinkWhenGranted, true);
    assert.equal(productNavOmitsMembershipIsolationChrome(null), true);
    assert.equal(productNavOmitsMembershipIsolationChrome(viewer), true);
    assert.equal(productNavOmitsMembershipIsolationChrome(admin), true);
    assert.equal(embedNavOmitsMembershipIsolationChrome(viewer), true);
    assert.equal(embedNavOmitsMembershipIsolationChrome(admin), true);
    assert.equal(
      visibleWorkspaceNav(admin).some(
        (item) => item.id === "membership" || item.id === "isolation",
      ),
      false,
    );
    assert.equal(
      editorWorkspaceNav(admin, { embed: true }).some(
        (item) => item.id === "membership" || item.id === "isolation",
      ),
      false,
    );
    const nav = source("src/components/shell/WorkspaceNav.tsx");
    assert.doesNotMatch(nav, /Membership|Isolation/);
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.doesNotMatch(shell, /href="\/membership"|href="\/isolation"/);
  });

  it("uses the same shell on embed after session.embed and fail-closes ADV-021", () => {
    assert.equal(SHELL_RESTYLE.embedSameShellAfterSessionEmbed, true);
    assert.equal(SHELL_RESTYLE.missingSessionEmbedIsAdv021Alert, true);
    assert.equal(SHELL_RESTYLE.hostQueryDisplayOnly, true);
    const embed = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(embedSharesShellClasses(embed), true);
    assert.equal(embedMissingBindIsAdv021Alert(embed), true);
    assert.equal(embedHostQueryIsDisplayOnly(embed), true);
    assert.match(embed, /EMBED_CHROME_MISSING_SESSION_MESSAGE/);
    assert.match(embed, /role="alert"/);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /not chrome authority/);
    assert.match(embed, /EMBED_HOST_DISPLAY_HELP/);
    assert.match(embed, /data-doherty-wait="host-query"/);
    assert.match(embed, /isSessionEmbedMode|sessionEmbed/);
    assert.doesNotMatch(embed, /switchWorkspace\(host/);
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.match(shell, /isSessionEmbedMode\(session\.embedChrome\)/);
    assert.match(shell, /<EmbedExchangeGate/);
  });

  it("rejects n8n orange, a second theme tree, and leftover light chrome", () => {
    for (const relative of V2_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(shellChromeRejectsForbiddenLook(text), true, relative);
      assert.equal(lightShellTokenPresent(text), false, relative);
      for (const token of LIGHT_SHELL_TOKENS) {
        assert.equal(text.includes(token), false, `${relative} ${token}`);
      }
    }
    assert.equal(SHELL_RESTYLE.noN8nOrange, true);
    assert.equal(SHELL_RESTYLE.noSecondThemeTree, true);
    assert.equal(SHELL_RESTYLE.notAnN8nClone, true);
    const tokens = source(V2_TOKEN_FILE);
    assert.doesNotMatch(tokens, /#f97316|#ea4b71|#ff6d5a/);
  });

  it("does not rewrite Overview or editor surfaces (V.3 / V.4)", () => {
    for (const relative of V2_SOURCES) {
      if (relative === "src/lib/shell-restyle.ts") {
        continue;
      }
      const text = source(relative);
      assert.equal(shellRestyleIsNotSurfaceRewrite(text), true, relative);
    }
    for (const relative of V2_OUT_OF_SCOPE_SOURCES) {
      const text = source(relative);
      assert.equal(text.includes("data-ff-shell"), false, relative);
      assert.equal(text.includes("FF_SHELL_ASIDE_CLASS"), false, relative);
    }
    assert.equal(V2_SOURCES.includes("src/components/home/WorkflowHome.tsx"), false);
    assert.equal(
      V2_SOURCES.includes("src/components/workflows/EditorChrome.tsx"),
      false,
    );
  });

  it("holds YAML / draft / vault / ADV hard lines", () => {
    assert.equal(shellRestyleHoldsHardLines(), true);
    assert.equal(SHELL_RESTYLE.yamlIsSourceOfTruth, true);
    assert.equal(SHELL_RESTYLE.draftsNeverRun, true);
    assert.equal(SHELL_RESTYLE.vaultDisplayNameUuidOnly, true);
    assert.equal(SHELL_RESTYLE.adv021ChromeFromSessionEmbedOnly, true);
    assert.equal(SHELL_RESTYLE.adv024MembershipIsolationStayGrantGated, true);
    assert.equal(SHELL_RESTYLE.isolationSuccessIsDenial, true);
    assert.equal(SHELL_RESTYLE.noGreenfieldApis, true);
  });
});
