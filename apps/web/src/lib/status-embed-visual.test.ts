import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ISOLATION_DENIAL_LABEL,
  LOUD_ADV024_DENIAL_CLASS,
  LOUD_INDETERMINATE_CLASS,
} from "./aesthetic-usability-density.ts";
import { EDITOR_ENGINE_CATALOG } from "./catalog-fail-closed.ts";
import { EDITOR_LIBRARY } from "./editor-library.ts";
import { executionStatusPresentation } from "./execution.ts";
import { MEMBERSHIP_ISOLATION_CHROME } from "./membership-isolation-chrome.ts";
import { PALETTE_CATALOG_UNAVAILABLE_HELP } from "./palette-category-first.ts";
import { PEAK_END_OPERATE, peakEndSurfaceClassName } from "./peak-end-operate-endings.ts";
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import { EMBED_CHROME_MISSING_SESSION_MESSAGE } from "./session-embed-contract.ts";
import {
  FF_STATUS_SUCCEEDED_CLASS,
  FORBIDDEN_STATUS_HEX,
  LIGHT_STATUS_TOKENS,
  STATUS_EMBED_VISUAL,
  V7_BRIEF,
  V7_EMBED_SOURCES,
  V7_EPIC,
  V7_HELP,
  V7_ID,
  V7_KEEP_STORY_OPEN,
  V7_SOURCES,
  V7_STATUS_SOURCES,
  V7_STORY,
  V7_TOKEN_FILE,
  adv024DenialContrastHolds,
  catalog403FailsClosed,
  everyExecutionStatusIsIconPlusText,
  lastRunStatusClassName,
  missingSessionEmbedFailsClosed,
  standaloneAndEmbedMatch,
  statusChromeRejectsForbiddenLook,
  statusChromeRejectsLightLook,
  statusEmbedVisualHoldsHardLines,
  statusEmbedVisualInheritsPriorStories,
  statusPresentationIsIconPlusText,
  statusToneClass,
  statusUsesV1TokenClasses,
  statusVisualHoldsAcceptance,
  successIsDistinctFromIndeterminate,
} from "./status-embed-visual.ts";
import { FF_ACCENT, FF_CANVAS, FF_DANGER, FF_SURFACE } from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("V.7 Status + embed visual gate", () => {
  it("keeps #363 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V7_STORY, 363);
    assert.equal(V7_EPIC, 353);
    assert.equal(V7_KEEP_STORY_OPEN, true);
    assert.equal(V7_ID, "V.7-status-embed-visual-gate");
    assert.equal(V7_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(V7_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(STATUS_EMBED_VISUAL.keep363Open, true);
    assert.equal(STATUS_EMBED_VISUAL.uiOnly, true);
    assert.equal(STATUS_EMBED_VISUAL.visualGateOnly, true);
    assert.equal(STATUS_EMBED_VISUAL.jonnyNoneExpected, true);
    assert.match(V7_HELP, /Icon\+text/);
    assert.match(V7_HELP, /Success ≠ indeterminate/);
    assert.match(V7_HELP, /ADV-024/);
    assert.match(V7_HELP, /session.embed/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /Status \+ embed visual gate/i);
  });

  it("locks icon+text on every status and success ≠ indeterminate", () => {
    assert.equal(everyExecutionStatusIsIconPlusText(), true);
    assert.equal(successIsDistinctFromIndeterminate(), true);
    const succeeded = executionStatusPresentation("succeeded");
    const uncertain = executionStatusPresentation("indeterminate");
    assert.equal(statusPresentationIsIconPlusText(succeeded), true);
    assert.equal(statusPresentationIsIconPlusText(uncertain), true);
    assert.notEqual(succeeded.icon, uncertain.icon);
    assert.notEqual(succeeded.label, uncertain.label);
    assert.notEqual(statusToneClass("succeeded"), statusToneClass("indeterminate"));
    assert.match(statusToneClass("succeeded"), /ff-status-succeeded/);
    assert.match(statusToneClass("indeterminate"), /ff-loud-indeterminate/);
    assert.equal(lastRunStatusClassName("success"), FF_STATUS_SUCCEEDED_CLASS);
    assert.match(lastRunStatusClassName("indeterminate"), /ff-loud-indeterminate/);
    assert.notEqual(
      lastRunStatusClassName("success"),
      lastRunStatusClassName("indeterminate"),
    );
    assert.notEqual(
      peakEndSurfaceClassName("success"),
      peakEndSurfaceClassName("indeterminate"),
    );
    assert.equal(PEAK_END_OPERATE.successExplicitAndDistinctFromIndeterminate, true);
    assert.equal(PEAK_END_OPERATE.loudIndeterminateOnOverlayAndInbox, true);
    assert.equal(PEAK_END_OPERATE.waitingDecideOnOverlayAndInbox, true);
    assert.equal(STATUS_EMBED_VISUAL.iconPlusTextOnEveryStatus, true);
    assert.equal(STATUS_EMBED_VISUAL.successDistinctFromIndeterminate, true);

    const mark = source("src/components/chrome/StatusMark.tsx");
    const badge = source("src/components/executions/ExecutionStatusBadge.tsx");
    const lastRun = source("src/components/home/HomeLastRunStatus.tsx");
    const activation = source("src/components/home/HomeActivationStatus.tsx");
    const isolation = source("src/components/isolation/IsolationExercise.tsx");
    const alert = source("src/components/alerts/AlertSeverityBadge.tsx");
    const editorActivation = source(
      "src/components/workflows/EditorActivationChrome.tsx",
    );
    assert.equal(
      statusVisualHoldsAcceptance({
        mark,
        badge,
        lastRun,
        activation,
        isolation,
        alert,
      }),
      true,
    );
    assert.match(badge, /StatusMark/);
    assert.match(badge, /presentation.icon/);
    assert.match(badge, /presentation.label/);
    assert.match(badge, /LOUD_INDETERMINATE_CLASS/);
    assert.match(lastRun, /LOUD_INDETERMINATE_CLASS/);
    assert.match(lastRun, /lastRunStatusClassName/);
    assert.match(activation, /presentation.icon/);
    assert.match(editorActivation, /presentation.icon/);
    assert.match(editorActivation, /presentation.label/);
  });

  it("holds ADV-024 denial contrast and isolation success is a Denial", () => {
    const isolation = source("src/components/isolation/IsolationExercise.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(adv024DenialContrastHolds(), true);
    assert.match(isolation, /LOUD_ADV024_DENIAL_CLASS/);
    assert.match(isolation, /ISOLATION_DENIAL_ICON/);
    assert.match(isolation, /ISOLATION_DENIAL_LABEL/);
    assert.equal(ISOLATION_DENIAL_LABEL, "Denial");
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial, true);
    assert.match(LOUD_ADV024_DENIAL_CLASS, /ff-loud-denial/);
    assert.match(globals, /\.ff-loud-denial/);
    assert.match(globals, /var\(--ff-danger\)/);
    assert.doesNotMatch(isolation, /\bpass\b/i);
    assert.equal(FF_DANGER, "#fb7185");
    assert.equal(STATUS_EMBED_VISUAL.adv024DenialContrastHolds, true);
    assert.equal(STATUS_EMBED_VISUAL.isolationSuccessIsDenial, true);
  });

  it("keeps standalone and embed matched with no second tree", () => {
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const editor = source("src/components/workflows/EditorChrome.tsx");
    const topBar = source("src/components/workflows/EditorTopBar.tsx");
    const home = source("src/components/home/WorkflowHome.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(
      standaloneAndEmbedMatch({
        embedChrome: embed,
        editorChrome: editor,
        topBar,
        home,
        globals,
      }),
      true,
    );
    assert.match(embed, /FF_SHELL_HEADER_CLASS/);
    assert.match(embed, /SessionStatusChip/);
    assert.doesNotMatch(embed, /EmbedEditorTopBar|EmbedStatusBadge|EmbedStatusMark/);
    assert.doesNotMatch(globals, /embed-tokens|tokens-embed/);
    assert.match(home, /WorkflowHome/);
    assert.equal(STATUS_EMBED_VISUAL.noSecondEmbedTree, true);
    assert.equal(STATUS_EMBED_VISUAL.noForkedEmbedChrome, true);
    assert.equal(STATUS_EMBED_VISUAL.sharedStatusComponents, true);
  });

  it("fail-closes catalog 403 and missing session.embed", () => {
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const library = source("src/components/workflows/ActionLibrary.tsx");
    assert.equal(catalog403FailsClosed(), true);
    assert.equal(missingSessionEmbedFailsClosed(embed), true);
    assert.equal(EDITOR_ENGINE_CATALOG.catalog403FailsClosed, true);
    assert.equal(EDITOR_LIBRARY.catalog403FailsClosed, true);
    assert.match(PALETTE_CATALOG_UNAVAILABLE_HELP, /HTTP 403/);
    assert.match(library, /unavailable/);
    assert.match(library, /fail closed/i);
    assert.match(embed, /EMBED_CHROME_MISSING_SESSION_MESSAGE/);
    assert.match(embed, /role="alert"/);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /session.embed/);
    assert.equal(
      R7_HARD_LINE.adv021FailClosedWithoutSessionEmbedOnEmbedV1,
      true,
    );
    assert.equal(STATUS_EMBED_VISUAL.catalog403FailsClosed, true);
    assert.equal(STATUS_EMBED_VISUAL.missingSessionEmbedFailsClosed, true);
  });

  it("paints status on V.1 tokens and rejects leftover light / n8n / second-theme chrome", () => {
    const globals = source("src/app/globals.css");
    assert.equal(statusUsesV1TokenClasses(globals), true);
    assert.match(globals, /\.ff-status-succeeded/);
    assert.match(globals, /\.ff-status-blocked/);
    assert.match(globals, /\.ff-status-pending/);
    assert.match(globals, /\.ff-status-skipped/);
    assert.match(globals, /\.ff-status-not-reached/);
    assert.match(statusToneClass("not-reached"), /ff-status-not-reached/);
    assert.doesNotMatch(
      statusToneClass("not-reached"),
      /ff-status-running|ff-status-pending|ff-status-blocked|ff-loud/,
    );
    assert.match(statusToneClass("skipped"), /ff-status-skipped/);
    assert.doesNotMatch(
      statusToneClass("skipped"),
      /ff-status-running|ff-status-succeeded|ff-loud/,
    );
    assert.match(statusToneClass("blocked"), /ff-status-blocked/);
    assert.match(statusToneClass("pending"), /ff-status-pending/);
    assert.match(globals, /\.ff-loud-indeterminate/);
    assert.match(globals, /var\(--ff-accent\)/);
    assert.match(globals, /var\(--ff-danger\)/);
    for (const hex of FORBIDDEN_STATUS_HEX) {
      assert.equal(globals.includes(hex), false, hex);
    }
    const mark = source("src/components/chrome/StatusMark.tsx");
    const badge = source("src/components/executions/ExecutionStatusBadge.tsx");
    const lastRun = source("src/components/home/HomeLastRunStatus.tsx");
    const alert = source("src/components/alerts/AlertSeverityBadge.tsx");
    for (const [relative, text] of [
      ["StatusMark", mark],
      ["ExecutionStatusBadge", badge],
      ["HomeLastRunStatus", lastRun],
      ["AlertSeverityBadge", alert],
    ] as const) {
      assert.equal(statusChromeRejectsForbiddenLook(text), true, relative);
      assert.equal(statusChromeRejectsLightLook(text), true, relative);
      for (const token of LIGHT_STATUS_TOKENS) {
        assert.equal(text.includes(token), false, `${relative} ${token}`);
      }
    }
    const tokens = source(V7_TOKEN_FILE);
    assert.doesNotMatch(tokens, /#f97316|#ea4b71|#ff6d5a/);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_SURFACE, "#171b22");
    assert.equal(FF_ACCENT, "#0f766e");
    assert.equal(STATUS_EMBED_VISUAL.noN8nOrange, true);
    assert.equal(STATUS_EMBED_VISUAL.noSecondThemeTree, true);
    assert.equal(LOUD_INDETERMINATE_CLASS.includes("ff-loud-indeterminate"), true);
  });

  it("holds hard lines and inherits V.1–V.6 / UXL.4 / UXL.8", () => {
    assert.equal(statusEmbedVisualHoldsHardLines(), true);
    assert.equal(statusEmbedVisualInheritsPriorStories(), true);
    assert.equal(STATUS_EMBED_VISUAL.yamlIsSourceOfTruth, true);
    assert.equal(STATUS_EMBED_VISUAL.draftsNeverRun, true);
    assert.equal(STATUS_EMBED_VISUAL.vaultDisplayNameUuidOnly, true);
    assert.equal(STATUS_EMBED_VISUAL.loudIndeterminateStays, true);
    assert.equal(STATUS_EMBED_VISUAL.waitingDecideStays, true);
    assert.equal(STATUS_EMBED_VISUAL.peakEndFocusedSuccessStays, true);
    assert.equal(STATUS_EMBED_VISUAL.noGreenfieldApis, true);
    for (const path of V7_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
    for (const path of V7_STATUS_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
    for (const path of V7_EMBED_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
