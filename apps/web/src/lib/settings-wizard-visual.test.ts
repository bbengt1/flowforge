import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_STEPS,
  BOOTSTRAP_TLS_SKIP_LABEL,
  BOOTSTRAP_TLS_SKIP_WARNING,
  DEFAULT_BOOTSTRAP_TLS_ACTION,
  FIRST_RUN_BOOTSTRAP,
  SETTINGS_BOOTSTRAP_HREF,
  SETTINGS_TLS_HREF,
  emptyBootstrapStatus,
  firstRunBootstrapHoldsHardLines,
  settingsHandoffAfterComplete,
  tlsStepIsSkipped,
  type BootstrapStatus,
} from "./first-run-bootstrap.ts";
import { FF_ACCENT, FF_CANVAS, FF_SURFACE } from "./visual-tokens.ts";
import {
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_SKIP_CLASS,
  FF_WIZARD_PANEL_CLASS,
  FF_WIZARD_PROGRESS_ITEM_CLASS,
  FF_WIZARD_SKIP_CLASS,
  LIGHT_SETTINGS_WIZARD_TOKENS,
  SETTINGS_WIZARD_VISUAL,
  V6_BRIEF,
  V6_CHROME_SOURCES,
  V6_EPIC,
  V6_HELP,
  V6_ID,
  V6_KEEP_STORY_OPEN,
  V6_SOURCES,
  V6_STORY,
  V6_TOKEN_FILE,
  bStepOrderHeld,
  settingsHandoffMatchesShellTokens,
  settingsWizardChromeRejectsForbiddenLook,
  settingsWizardChromeRejectsLightLook,
  settingsWizardUsesV1TokenClasses,
  settingsWizardVisualHoldsAcceptance,
  settingsWizardVisualHoldsHardLines,
  settingsWizardVisualInheritsPriorStories,
  skippedTlsStatusIsClear,
  wizardChromeNeverOnEmbed,
  wizardDoesNotRemountAfterComplete,
  wizardOmitsSecretRetention,
  wizardSkipIsLoud,
  wizardStatusClassName,
} from "./settings-wizard-visual.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function skippedCompleteStatus(): BootstrapStatus {
  return {
    complete: true,
    incomplete: false,
    skipped: false,
    standaloneOnly: true,
    steps: {
      persistence: { ready: true },
      firstAdmin: { ready: true },
      publicUrl: { ready: true },
      tls: { ready: true, mode: "skipped" },
    },
  };
}

describe("V.6 Settings + first-run wizard", () => {
  it("keeps #362 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V6_STORY, 362);
    assert.equal(V6_EPIC, 353);
    assert.equal(V6_KEEP_STORY_OPEN, true);
    assert.equal(V6_ID, "V.6-settings-first-run-wizard");
    assert.equal(V6_BRIEF, "docs/internal/flowforge-visual-ia-north-star.md");
    assert.equal(V6_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(SETTINGS_WIZARD_VISUAL.keep362Open, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.uiOnly, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.jonnyNoneExpected, true);
    assert.match(V6_HELP, /Same tokens as the product/);
    assert.match(V6_HELP, /Wizard never on \/embed\/v1/);
    assert.match(V6_HELP, /Skip stays loud HTTP-until-Settings/);
    assert.match(V6_HELP, /No remount after complete/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /Settings \+ first-run wizard/i);
    const northStar = readFileSync(
      join(here, "..", "..", "..", "..", V6_BRIEF),
      "utf8",
    );
    assert.match(northStar, /V\.6 — Settings \+ first-run wizard/);
  });

  it("locks tokenized Settings and wizard chrome on V.1 tokens", () => {
    const globals = source("src/app/globals.css");
    const page = source("src/app/settings/page.tsx");
    const settings = source("src/components/settings/BootstrapSettings.tsx");
    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    const gate = source("src/components/bootstrap/BootstrapGate.tsx");
    assert.equal(settingsWizardUsesV1TokenClasses(globals), true);
    assert.match(globals, /\.ff-settings-panel/);
    assert.match(globals, /\.ff-wizard-panel/);
    assert.match(globals, /\.ff-wizard-progress-item/);
    assert.match(globals, /\.ff-settings-skip/);
    assert.match(globals, /\.ff-wizard-skip/);
    assert.match(globals, /background: var\(--ff-surface\)/);
    assert.match(globals, /background: var\(--ff-accent\)/);
    assert.match(page, /data-ff-settings/);
    assert.match(page, /FF_SETTINGS_VALUE/);
    assert.match(page, /FF_SETTINGS_ROOT_CLASS/);
    assert.match(settings, /FF_SETTINGS_PANEL_CLASS/);
    assert.match(settings, /id="bootstrap"/);
    assert.match(settings, /id="tls"/);
    assert.match(wizard, /data-ff-wizard/);
    assert.match(wizard, /FF_WIZARD_VALUE/);
    assert.match(wizard, /FF_WIZARD_ROOT_CLASS/);
    assert.match(wizard, /FF_WIZARD_PANEL_CLASS/);
    assert.match(wizard, /FF_WIZARD_PROGRESS_ITEM_CLASS/);
    assert.match(gate, /FF_WIZARD_ROOT_CLASS/);
    assert.equal(
      settingsWizardVisualHoldsAcceptance({ page, settings, wizard, gate }),
      true,
    );
    assert.equal(FF_SETTINGS_PANEL_CLASS, "ff-settings-panel");
    assert.equal(FF_WIZARD_PANEL_CLASS, "ff-wizard-panel");
    assert.equal(FF_WIZARD_PROGRESS_ITEM_CLASS, "ff-wizard-progress-item");
    assert.equal(SETTINGS_WIZARD_VISUAL.sameTokensAsProduct, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.inheritV1Tokens, true);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_SURFACE, "#171b22");
    assert.equal(FF_ACCENT, "#0f766e");
  });

  it("never mounts the wizard on /embed/v1", () => {
    const gate = source("src/components/bootstrap/BootstrapGate.tsx");
    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    const embed = source("src/components/embed/EmbedChrome.tsx");
    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.equal(
      wizardChromeNeverOnEmbed({ gate, wizard, embed, shell }),
      true,
    );
    assert.equal(embed.includes("FirstRunWizard"), false);
    assert.equal(embed.includes("loadBootstrapGate"), false);
    assert.match(gate, /if \(embed\)/);
    assert.match(gate, /return children/);
    assert.equal(FIRST_RUN_BOOTSTRAP.neverOnEmbedV1, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.wizardNeverOnEmbedV1, true);
  });

  it("holds B.2–B.5 order, loud Skip, no remount after complete, and no secret retention", () => {
    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    const settings = source("src/components/settings/BootstrapSettings.tsx");
    const settingsPage = source("src/app/settings/page.tsx");
    const client = source("src/lib/first-run-bootstrap-client.ts");
    assert.equal(bStepOrderHeld(), true);
    assert.deepEqual([...BOOTSTRAP_STEPS], [
      "persistence",
      "firstAdmin",
      "publicUrl",
      "tls",
    ]);
    assert.equal(DEFAULT_BOOTSTRAP_TLS_ACTION, "create-self-signed");
    assert.match(wizard, /canOpenBootstrapStep/);
    assert.match(wizard, /Confirm persistence/);
    assert.match(wizard, /Create first admin/);
    assert.match(wizard, /Save public URL/);
    assert.match(wizard, /Enable TLS and finish/);
    assert.equal(wizardSkipIsLoud({ wizard, settings }), true);
    assert.equal(BOOTSTRAP_TLS_SKIP_LABEL, "Skip for now");
    assert.match(BOOTSTRAP_TLS_SKIP_WARNING, /HTTP until/);
    assert.match(wizard, /FF_WIZARD_SKIP_CLASS/);
    assert.match(settings, /FF_SETTINGS_SKIP_CLASS/);
    assert.equal(FF_WIZARD_SKIP_CLASS, "ff-wizard-skip");
    assert.equal(FF_SETTINGS_SKIP_CLASS, "ff-settings-skip");
    assert.equal(
      wizardDoesNotRemountAfterComplete({ settingsPage, settings }),
      true,
    );
    assert.equal(settingsPage.includes("FirstRunWizard"), false);
    assert.equal(
      wizardOmitsSecretRetention({ wizard, client, settings }),
      true,
    );
    assert.equal(wizard.includes("localStorage"), false);
    assert.doesNotMatch(wizard, /type="password"/);
    assert.equal(SETTINGS_WIZARD_VISUAL.b2ToB5OrderUnchanged, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.skipStaysLoudHttpUntilSettings, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.noRemountAfterComplete, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.noPemKekPasswordInChrome, true);
  });

  it("keeps Settings #bootstrap / #tls / handoff on shell tokens and skipped mode clear", () => {
    const page = source("src/app/settings/page.tsx");
    const settings = source("src/components/settings/BootstrapSettings.tsx");
    assert.equal(settingsHandoffMatchesShellTokens({ page, settings }), true);
    assert.equal(SETTINGS_BOOTSTRAP_HREF, "/settings#bootstrap");
    assert.equal(SETTINGS_TLS_HREF, "/settings#tls");
    assert.match(settings, /id="bootstrap"/);
    assert.match(settings, /id="tls"/);
    assert.match(settings, /SETTINGS_USERS_HANDOFF_HREF/);
    assert.match(settings, /Enable TLS later/);
    assert.match(settings, /data-bootstrap-tls-skipped/);
    const skipped = skippedCompleteStatus();
    assert.equal(skippedTlsStatusIsClear(skipped), true);
    assert.equal(settingsHandoffAfterComplete(skipped), true);
    assert.equal(tlsStepIsSkipped(skipped.steps.tls), true);
    assert.equal(settingsHandoffAfterComplete(emptyBootstrapStatus()), false);
    assert.match(wizardStatusClassName("error"), /ff-wizard-danger/);
    assert.match(wizardStatusClassName("pending"), /ff-wizard-muted/);
    assert.equal(SETTINGS_WIZARD_VISUAL.settingsBootstrapTlsHandoffMatchShellTokens, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.skippedModeStillClear, true);
  });

  it("rejects leftover light chrome, n8n orange, and a second theme", () => {
    for (const relative of V6_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(settingsWizardChromeRejectsForbiddenLook(text), true, relative);
      assert.equal(settingsWizardChromeRejectsLightLook(text), true, relative);
      for (const token of LIGHT_SETTINGS_WIZARD_TOKENS) {
        assert.equal(text.includes(token), false, `${relative} ${token}`);
      }
    }
    const tokens = source(V6_TOKEN_FILE);
    assert.doesNotMatch(tokens, /#f97316|#ea4b71|#ff6d5a/);
    assert.equal(SETTINGS_WIZARD_VISUAL.noN8nOrange, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.noSecondThemeTree, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.notAnN8nClone, true);
  });

  it("holds hard lines and inherits V.1 / V.2 / B.6 / B.7", () => {
    assert.equal(settingsWizardVisualHoldsHardLines(), true);
    assert.equal(settingsWizardVisualInheritsPriorStories(), true);
    assert.equal(firstRunBootstrapHoldsHardLines(), true);
    assert.equal(SETTINGS_WIZARD_VISUAL.yamlIsSourceOfTruth, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.draftsNeverRun, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.wizardNeverOnEmbedV1, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.noGreenfieldApis, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.keep339Open, true);
    assert.equal(SETTINGS_WIZARD_VISUAL.keep347Open, true);
    for (const path of V6_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
