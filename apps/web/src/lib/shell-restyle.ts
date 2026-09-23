/**
 * V.2: Shell restyle.
 *
 * Relates to #358 / Part of #353. Keep #358 open.
 *
 * Chloe UI only. Dark product chrome on the V.1 token tree
 * (docs/internal/flowforge-visual-ia-north-star.md § shell / V.2).
 * Standalone and `/embed/v1` share this one look. No second theme.
 * No n8n orange. Overview / editor surface rebuilds stay in V.3 / V.4.
 *
 * Surfaces: workspace nav, switcher, Commands, editor icon-rail.
 * Active item uses the one teal accent. Editor still collapses to
 * original marks. Membership / Isolation stay off product chrome
 * (ADV-024 — Settings may link when granted). Embed uses the same
 * shell after `session.embed`; missing bind is still an ADV-021
 * alert. Host query stays display-only.
 *
 * Hard lines: YAML SoT · drafts never run · vault display-name+UUID ·
 * ADV-021/024 · isolation success is a denial · not an n8n clone ·
 * no greenfield APIs.
 */

import { MEMBERSHIP_ISOLATION_CHROME } from "./membership-isolation-chrome.ts";
import {
  R7_HARD_LINE,
  INVENTED_EMBED_TREES,
} from "./rewrite-embed-mount.ts";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./session-embed-contract.ts";
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
import {
  editorWorkspaceNav,
  visibleWorkspaceNav,
  workspaceNavMark,
  type WorkspaceNavGroup,
  type WorkspaceNavId,
} from "./workspace-nav.ts";

export const V2_STORY = 358;
export const V2_EPIC = 353;
export const V2_KEEP_STORY_OPEN = true;
export const V2_ID = "V.2-shell-restyle" as const;
export const V2_BRIEF = "docs/internal/flowforge-visual-ia-north-star.md";
export const V2_TOKEN_FILE = "src/app/tokens.css";

export const V2_HELP =
  "Dark charcoal shell on every product route using V.1 tokens. Active nav uses the one teal accent. Editor still collapses to an original icon-rail. Membership / Isolation stay off product chrome. Embed uses the same shell after session.embed; missing bind is still an ADV-021 alert. Host query is display-only. No second theme tree. No n8n orange. Not a full Overview or editor rewrite.";

export const SHELL_RESTYLE = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  darkShellOnEveryProductRoute: true,
  charcoalCanvasAndSurface: true,
  oneAccentOnActiveNav: true,
  accentIsTealFamily: true,
  labeledNavGroups: true,
  editorCollapsesToOriginalIconRail: true,
  membershipIsolationOffProductChrome: true,
  settingsMayLinkWhenGranted: true,
  embedSameShellAfterSessionEmbed: true,
  missingSessionEmbedIsAdv021Alert: true,
  hostQueryDisplayOnly: true,
  noSecondThemeTree: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  notOverviewRewrite: true,
  notEditorRewrite: true,
  yamlIsSourceOfTruth: true,
  draftsNeverRun: true,
  vaultDisplayNameUuidOnly: true,
  adv021ChromeFromSessionEmbedOnly: true,
  adv024MembershipIsolationStayGrantGated: true,
  isolationSuccessIsDenial: true,
  noGreenfieldApis: true,
  keep358Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_SHELL_ATTR = "data-ff-shell";
export const FF_SHELL_VALUE = "v2";

export const FF_SHELL_ASIDE_CLASS = "ff-shell-aside";
export const FF_SHELL_HEADER_CLASS = "ff-shell-header";
export const FF_SHELL_CONTROL_CLASS = "ff-shell-control";
export const FF_SHELL_PANEL_CLASS = "ff-shell-panel";
export const FF_SHELL_MUTED_CLASS = "ff-shell-muted";
export const FF_NAV_ITEM_CLASS = "ff-nav-item";
export const FF_NAV_ITEM_ACTIVE_CLASS = "ff-nav-item-active";
export const FF_NAV_GROUP_LABEL_CLASS = "ff-nav-group-label";

export const SHELL_NAV_GROUP_LABELS: Record<WorkspaceNavGroup, string> = {
  build: "Build",
  observe: "Observe",
  vault: "Vault",
  settings: "Settings",
};

export const SHELL_NAV_GROUP_ORDER: readonly WorkspaceNavGroup[] = [
  "build",
  "observe",
  "vault",
  "settings",
];

export const EDITOR_ICON_RAIL_MARKS: Readonly<Record<WorkspaceNavId, string>> = {
  workflows: "Wf",
  actions: "Ac",
  credentials: "Cr",
  targets: "Tg",
  profiles: "Pr",
  config: "Cf",
  executions: "Ex",
  templates: "Tp",
  approvals: "Ap",
  alerts: "Al",
  audit: "Au",
  settings: "St",
  membership: "Mb",
  isolation: "Is",
  portal: "Pt",
};

export const V2_SOURCES = [
  "src/lib/shell-restyle.ts",
  "src/app/globals.css",
  "src/lib/workspace-nav.ts",
  "src/components/shell/WorkspaceShell.tsx",
  "src/components/shell/WorkspaceNav.tsx",
  "src/components/shell/WorkspaceSwitcher.tsx",
  "src/components/shell/CommandPalette.tsx",
  "src/components/shell/GlobalSearch.tsx",
  "src/components/shell/NotificationCenter.tsx",
  "src/components/embed/EmbedChrome.tsx",
] as const;

export const V2_CHROME_SOURCES = [
  "src/app/globals.css",
  "src/components/shell/WorkspaceShell.tsx",
  "src/components/shell/WorkspaceNav.tsx",
  "src/components/shell/WorkspaceSwitcher.tsx",
  "src/components/shell/CommandPalette.tsx",
  "src/components/shell/GlobalSearch.tsx",
  "src/components/shell/NotificationCenter.tsx",
  "src/components/embed/EmbedChrome.tsx",
] as const;

/** Surfaces V.2 must not rewrite — those are V.3 / V.4. */
export const V2_OUT_OF_SCOPE_SOURCES = [
  "src/components/home/WorkflowHome.tsx",
  "src/components/workflows/EditorChrome.tsx",
  "src/components/workflows/EditorTopBar.tsx",
  "src/components/workflows/WorkflowCanvas.tsx",
] as const;

export const LIGHT_SHELL_TOKENS = [
  "bg-white",
  "bg-white/80",
  "border-zinc-200",
  "border-zinc-300",
  "bg-teal-50",
  "text-teal-950",
  "#f6f5f1",
] as const;

export function shellRestyleHoldsHardLines(): boolean {
  return (
    SHELL_RESTYLE.yamlIsSourceOfTruth &&
    SHELL_RESTYLE.draftsNeverRun &&
    SHELL_RESTYLE.vaultDisplayNameUuidOnly &&
    SHELL_RESTYLE.adv021ChromeFromSessionEmbedOnly &&
    SHELL_RESTYLE.adv024MembershipIsolationStayGrantGated &&
    SHELL_RESTYLE.isolationSuccessIsDenial &&
    SHELL_RESTYLE.notAnN8nClone &&
    SHELL_RESTYLE.noN8nOrange &&
    SHELL_RESTYLE.noSecondThemeTree &&
    SHELL_RESTYLE.embedSameShellAfterSessionEmbed &&
    SHELL_RESTYLE.missingSessionEmbedIsAdv021Alert &&
    SHELL_RESTYLE.hostQueryDisplayOnly &&
    SHELL_RESTYLE.membershipIsolationOffProductChrome &&
    SHELL_RESTYLE.notOverviewRewrite &&
    SHELL_RESTYLE.notEditorRewrite &&
    SHELL_RESTYLE.keep358Open &&
    SHELL_RESTYLE.inheritV1Tokens &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_CANVAS.toLowerCase() === "#0f1218" &&
    FF_SURFACE.toLowerCase() === "#171b22" &&
    MEMBERSHIP_ISOLATION_CHROME.offProductChrome &&
    R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1 &&
    R7_HARD_LINE.hostQueryDisplayOnlyNeverAuthorization
  );
}

export function shellUsesV1Tokens(globals: string): boolean {
  return (
    globals.includes(`.${FF_SHELL_ASIDE_CLASS}`) &&
    globals.includes(`.${FF_SHELL_HEADER_CLASS}`) &&
    globals.includes(`.${FF_NAV_ITEM_ACTIVE_CLASS}`) &&
    globals.includes("background: var(--ff-surface)") &&
    globals.includes("background: var(--ff-accent)") &&
    globals.includes("color: var(--ff-accent-foreground)") &&
    globals.includes("background: var(--ff-canvas)") &&
    globals.includes("var(--ff-text)") &&
    globals.includes("var(--ff-muted)") &&
    globals.includes("var(--ff-border)")
  );
}

export function activeNavUsesOneAccent(source: string): boolean {
  const usesActiveClass =
    source.includes("FF_NAV_ITEM_ACTIVE_CLASS") ||
    source.includes(FF_NAV_ITEM_ACTIVE_CLASS);
  const usesItemClass =
    source.includes("FF_NAV_ITEM_CLASS") || source.includes(FF_NAV_ITEM_CLASS);
  return (
    usesActiveClass &&
    usesItemClass &&
    !source.includes("bg-teal-50") &&
    !source.includes("text-teal-950")
  );
}

export function editorIconRailIsOriginal(source: string): boolean {
  return (
    source.includes('data-nav-mode={navMode}') &&
    source.includes('variant={editorRoute && !navOpen ? "rail" : "full"}') &&
    workspaceNavMark("workflows") === EDITOR_ICON_RAIL_MARKS.workflows &&
    workspaceNavMark("settings") === EDITOR_ICON_RAIL_MARKS.settings &&
    !source.includes("n8n-logo") &&
    !source.includes("Execute workflow")
  );
}

export function productNavOmitsMembershipIsolationChrome(
  permissions: readonly string[] | null | undefined,
): boolean {
  return !visibleWorkspaceNav(permissions).some(
    (item) => item.id === "membership" || item.id === "isolation",
  );
}

export function embedNavOmitsMembershipIsolationChrome(
  permissions: readonly string[] | null | undefined,
): boolean {
  return !editorWorkspaceNav(permissions, { embed: true }).some(
    (item) => item.id === "membership" || item.id === "isolation",
  );
}

export function embedSharesShellClasses(embedChrome: string): boolean {
  const usesHeader =
    embedChrome.includes("FF_SHELL_HEADER_CLASS") ||
    embedChrome.includes(FF_SHELL_HEADER_CLASS);
  const usesNavItem =
    embedChrome.includes("FF_NAV_ITEM_CLASS") ||
    embedChrome.includes(FF_NAV_ITEM_CLASS);
  const usesActive =
    embedChrome.includes("FF_NAV_ITEM_ACTIVE_CLASS") ||
    embedChrome.includes(FF_NAV_ITEM_ACTIVE_CLASS);
  return (
    usesHeader &&
    usesNavItem &&
    usesActive &&
    embedChrome.includes("data-ff-shell") &&
    embedChrome.includes("FF_SHELL_VALUE") &&
    !INVENTED_EMBED_TREES.some((tree) => embedChrome.includes(tree))
  );
}

export function embedMissingBindIsAdv021Alert(embedChrome: string): boolean {
  return (
    embedChrome.includes("EMBED_CHROME_MISSING_SESSION_MESSAGE") &&
    embedChrome.includes('role="alert"') &&
    embedChrome.includes("missingEmbed") &&
    EMBED_CHROME_MISSING_SESSION_MESSAGE.length > 0
  );
}

export function embedHostQueryIsDisplayOnly(embedChrome: string): boolean {
  return (
    embedChrome.includes("hostDisplay") &&
    embedChrome.includes("EMBED_HOST_DISPLAY_HELP") &&
    embedChrome.includes('data-doherty-wait="host-query"') &&
    !embedChrome.includes("switchWorkspace(host") &&
    !embedChrome.includes("optimisticWorkspaceSwitch")
  );
}

export function lightShellTokenPresent(source: string): boolean {
  return LIGHT_SHELL_TOKENS.some((token) => source.includes(token));
}

export function shellChromeRejectsForbiddenLook(source: string): boolean {
  return (
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source) &&
    !lightShellTokenPresent(source) &&
    !FORBIDDEN_THEME_TREES.some((tree) => source.includes(tree)) &&
    !N8N_ORANGE_TOKENS.some((token) =>
      source.toLowerCase().includes(token.toLowerCase()),
    )
  );
}

export function shellRestyleIsNotSurfaceRewrite(source: string): boolean {
  return (
    !source.includes("data-o1=") &&
    !source.includes("data-o3=") &&
    !source.includes("@/components/home/WorkflowHome") &&
    !source.includes("@/components/workflows/EditorTopBar") &&
    !source.includes("@/components/workflows/EditorChrome") &&
    !source.includes("@/components/workflows/WorkflowCanvas")
  );
}
