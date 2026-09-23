import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ISOLATION_DENIAL_LABEL,
  LOUD_ADV024_DENIAL_CLASS,
  LOUD_ADV024_LEAK_CLASS,
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
  loudContrastNotQuieter,
} from "./aesthetic-usability-density.ts";
import { CREDENTIAL_VAULT, R5_SECURITY_LINE } from "./credential-vault.ts";
import { EDITOR_RUNS } from "./editor-runs.ts";
import {
  EXECUTION_INBOX,
  EXECUTION_INBOX_DETAIL_PATH,
  R4_GUARDRAILS,
  executionInboxDraftsNeverRun,
  executionInboxHasSingleOperatePath,
  executionInboxIndeterminateIsLoud,
} from "./execution-inbox.ts";
import {
  MEMBERSHIP_ISOLATION_CHROME,
  isolationHeldIsSuccess,
} from "./membership-isolation-chrome.ts";
import { PEAK_END_OPERATE } from "./peak-end-operate-endings.ts";
import { FF_ACCENT, FF_CANVAS, FF_DANGER, FF_SURFACE } from "./visual-tokens.ts";
import {
  FF_INBOX_PANEL_CLASS,
  FF_INBOX_ROW_INDETERMINATE_CLASS,
  FF_LOUD_DENIAL_CLASS,
  FF_LOUD_INDETERMINATE_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_UUID_CLASS,
  LIGHT_VAULT_INBOX_TOKENS,
  V5_BRIEF,
  V5_CHROME_SOURCES,
  V5_EPIC,
  V5_HELP,
  V5_ID,
  V5_KEEP_STORY_OPEN,
  V5_SOURCES,
  V5_STORY,
  V5_TOKEN_FILE,
  VAULT_EXECUTIONS_VISUAL,
  inboxOmitsSecondReplayGraph,
  inboxVisualHoldsAcceptance,
  vaultChromeOmitsFingerprintAsSecret,
  vaultChromeOmitsKek,
  vaultExecutionsVisualHoldsHardLines,
  vaultExecutionsVisualInheritsPriorStories,
  vaultInboxChromeRejectsForbiddenLook,
  vaultInboxChromeRejectsLightLook,
  vaultInboxUsesV1TokenClasses,
  vaultVisualHoldsAcceptance,
} from "./vault-executions-visual.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

describe("V.5 Vault + executions restyle", () => {
  it("keeps #361 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V5_STORY, 361);
    assert.equal(V5_EPIC, 353);
    assert.equal(V5_KEEP_STORY_OPEN, true);
    assert.equal(V5_ID, "V.5-vault-executions-restyle");
    assert.equal(V5_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(V5_TOKEN_FILE, "src/app/tokens.css");
    assert.equal(VAULT_EXECUTIONS_VISUAL.keep361Open, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.uiOnly, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.jonnyNoneExpected, true);
    assert.match(V5_HELP, /Dark find\/detail/);
    assert.match(V5_HELP, /No KEK chrome/);
    assert.match(V5_HELP, /Not an n8n clone/);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /dark find\/detail/i);
    assert.match(frontend, /dark inbox/i);
  });

  it("locks dark vault find/detail and inbox density on V.1 tokens", () => {
    const globals = source("src/app/globals.css");
    const vault = source("src/components/credentials/CredentialVault.tsx");
    const listbox = source("src/components/credentials/CredentialVaultListbox.tsx");
    const detail = source("src/components/credentials/CredentialDetail.tsx");
    const wizard = source("src/components/credentials/CredentialWizard.tsx");
    const history = source("src/components/executions/ExecutionHistory.tsx");
    const inboxList = source("src/components/executions/ExecutionHistoryListbox.tsx");
    const execution = source("src/components/executions/ExecutionDetail.tsx");
    assert.equal(vaultInboxUsesV1TokenClasses(globals), true);
    assert.match(globals, /\.ff-vault-panel/);
    assert.match(globals, /\.ff-inbox-panel/);
    assert.match(globals, /\.ff-loud-indeterminate/);
    assert.match(globals, /\.ff-loud-denial/);
    assert.match(globals, /background: var\(--ff-surface\)/);
    assert.match(globals, /var\(--ff-danger-surface\)/);
    assert.match(vault, /data-ff-vault/);
    assert.match(vault, /FF_VAULT_VALUE/);
    assert.match(vault, /FF_VAULT_ROOT_CLASS/);
    assert.match(vault, /FF_VAULT_PANEL_CLASS/);
    assert.match(listbox, /FF_VAULT_UUID_CLASS/);
    assert.match(detail, /FF_VAULT_PANEL_CLASS/);
    assert.match(wizard, /FF_VAULT_PANEL_CLASS/);
    assert.match(history, /data-ff-inbox/);
    assert.match(history, /FF_INBOX_VALUE/);
    assert.match(history, /FF_INBOX_PANEL_CLASS/);
    assert.match(inboxList, /FF_INBOX_ROW_INDETERMINATE_CLASS/);
    assert.match(execution, /FF_INBOX_PANEL_CLASS/);
    assert.equal(
      vaultVisualHoldsAcceptance({ vault, listbox, detail, wizard }),
      true,
    );
    assert.equal(FF_VAULT_PANEL_CLASS, "ff-vault-panel");
    assert.equal(FF_INBOX_PANEL_CLASS, "ff-inbox-panel");
    assert.equal(VAULT_EXECUTIONS_VISUAL.darkFindDetail, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.darkInboxDensity, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.inheritV1Tokens, true);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_SURFACE, "#171b22");
    assert.equal(FF_ACCENT, "#0f766e");
  });

  it("keeps vault metadata as display-name + UUID and omits KEK chrome", () => {
    const vault = source("src/components/credentials/CredentialVault.tsx");
    const listbox = source("src/components/credentials/CredentialVaultListbox.tsx");
    const detail = source("src/components/credentials/CredentialDetail.tsx");
    const card = source("src/components/credentials/CredentialCard.tsx");
    assert.equal(vaultChromeOmitsKek(vault), true);
    assert.equal(vaultChromeOmitsKek(listbox), true);
    assert.equal(vaultChromeOmitsKek(detail), true);
    assert.equal(vaultChromeOmitsKek(card), true);
    assert.equal(vaultChromeOmitsFingerprintAsSecret(card), true);
    assert.match(listbox, /row\.displayName/);
    assert.match(listbox, /row\.id/);
    assert.match(listbox, /FF_VAULT_UUID_CLASS/);
    assert.match(detail, /header\?\.identity\.displayName/);
    assert.match(detail, /header\?\.identity\.id/);
    assert.doesNotMatch(card, /Fingerprint/);
    assert.doesNotMatch(vault, /CREDENTIAL_KEK|keyReference/);
    assert.doesNotMatch(detail, /CREDENTIAL_KEK|keyReference/);
    assert.equal(FF_VAULT_UUID_CLASS, "ff-vault-uuid");
    assert.equal(CREDENTIAL_VAULT.displayNamePlusUuidOnly, true);
    assert.equal(CREDENTIAL_VAULT.noKekInBrowser, true);
    assert.equal(R5_SECURITY_LINE.noKekInBrowser, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.vaultDisplayNameUuidOnly, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noKekChrome, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noFingerprintAsSecret, true);
  });

  it("keeps inbox off a second replay graph, one path to /executions/{id}, and drafts never run", () => {
    const history = source("src/components/executions/ExecutionHistory.tsx");
    const listbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    const badge = source("src/components/executions/ExecutionStatusBadge.tsx");
    const detail = source("src/components/executions/ExecutionDetail.tsx");
    assert.equal(inboxOmitsSecondReplayGraph(history), true);
    assert.equal(inboxOmitsSecondReplayGraph(listbox), true);
    assert.doesNotMatch(history, /ExecutionReplay/);
    assert.doesNotMatch(history, /\/replay/);
    assert.doesNotMatch(listbox, /ExecutionReplay/);
    assert.match(listbox, /EXECUTION_INBOX_OPEN_LABEL/);
    assert.match(listbox, /INDETERMINATE_STATUS_HELP/);
    assert.equal(executionInboxHasSingleOperatePath(), true);
    assert.equal(executionInboxDraftsNeverRun(), true);
    assert.equal(EXECUTION_INBOX_DETAIL_PATH, "/executions/{id}");
    assert.equal(EXECUTION_INBOX.noInboxReplayGraph, true);
    assert.equal(R4_GUARDRAILS.noInboxReplayGraph, true);
    assert.equal(EDITOR_RUNS.noSecondReplayCanvas, true);
    assert.equal(PEAK_END_OPERATE.inboxIsNotSecondReplayGraph, true);
    assert.equal(
      inboxVisualHoldsAcceptance({ history, listbox, detail, badge }),
      true,
    );
    assert.equal(VAULT_EXECUTIONS_VISUAL.inboxIsNotSecondReplayGraph, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.oneReplayPath, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.draftsNeverRun, true);
  });

  it("keeps indeterminate loud (icon + text + explanation) and ADV-024 denial contrast", () => {
    const listbox = source("src/components/executions/ExecutionHistoryListbox.tsx");
    const badge = source("src/components/executions/ExecutionStatusBadge.tsx");
    const isolation = source("src/components/isolation/IsolationExercise.tsx");
    const globals = source("src/app/globals.css");
    assert.equal(executionInboxIndeterminateIsLoud(), true);
    assert.match(badge, /LOUD_INDETERMINATE_CLASS/);
    assert.match(badge, /presentation\.icon/);
    assert.match(badge, /presentation\.label/);
    assert.match(listbox, /FF_INBOX_ROW_INDETERMINATE_CLASS/);
    assert.match(listbox, /PeakEndEnding/);
    assert.match(listbox, /INDETERMINATE_STATUS_HELP/);
    assert.equal(FF_INBOX_ROW_INDETERMINATE_CLASS, "ff-inbox-row-indeterminate");
    assert.equal(FF_LOUD_INDETERMINATE_CLASS, "ff-loud-indeterminate");
    assert.match(LOUD_INDETERMINATE_CLASS, /ff-loud-indeterminate/);
    assert.match(LOUD_ADV024_DENIAL_CLASS, /ff-loud-denial/);
    assert.equal(loudContrastNotQuieter(LOUD_INDETERMINATE_CLASS), true);
    assert.equal(loudContrastNotQuieter(LOUD_ERROR_CLASS), true);
    assert.equal(loudContrastNotQuieter(LOUD_ADV024_DENIAL_CLASS), true);
    assert.equal(loudContrastNotQuieter(LOUD_ADV024_LEAK_CLASS), true);
    assert.match(isolation, /LOUD_ADV024_DENIAL_CLASS/);
    assert.match(isolation, /ISOLATION_DENIAL_ICON/);
    assert.match(isolation, /ISOLATION_DENIAL_LABEL/);
    assert.equal(ISOLATION_DENIAL_LABEL, "Denial");
    assert.equal(isolationHeldIsSuccess(true), true);
    assert.equal(MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial, true);
    assert.match(globals, /\.ff-loud-denial/);
    assert.match(globals, /var\(--ff-danger\)/);
    assert.equal(FF_DANGER, "#fb7185");
    assert.equal(FF_LOUD_DENIAL_CLASS, "ff-loud-denial");
    assert.equal(VAULT_EXECUTIONS_VISUAL.loudIndeterminate, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.indeterminateIconTextExplanation, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.adv024IsolationSuccessIsDenial, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.adv024DenialContrastStaysLoud, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noQuieterDenials, true);
  });

  it("rejects leftover light chrome, n8n orange, KEK chrome, and a second theme", () => {
    for (const relative of V5_CHROME_SOURCES) {
      const text = source(relative);
      assert.equal(vaultInboxChromeRejectsForbiddenLook(text), true, relative);
      assert.equal(vaultInboxChromeRejectsLightLook(text), true, relative);
      for (const token of LIGHT_VAULT_INBOX_TOKENS) {
        assert.equal(text.includes(token), false, `${relative} ${token}`);
      }
    }
    const tokens = source(V5_TOKEN_FILE);
    assert.doesNotMatch(tokens, /#f97316|#ea4b71|#ff6d5a/);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noN8nOrange, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noSecondThemeTree, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.notAnN8nClone, true);
  });

  it("holds hard lines and inherits V.1 / R4 / R5 / UXL stories", () => {
    assert.equal(vaultExecutionsVisualHoldsHardLines(), true);
    assert.equal(vaultExecutionsVisualInheritsPriorStories(), true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.yamlIsSourceOfTruth, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.draftsNeverRun, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.vaultDisplayNameUuidOnly, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noKekInBrowser, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.adv024IsolationSuccessIsDenial, true);
    assert.equal(VAULT_EXECUTIONS_VISUAL.noGreenfieldApis, true);
    assert.equal(R4_GUARDRAILS.loudIndeterminate, true);
    assert.equal(R4_GUARDRAILS.draftsNeverRun, true);
    for (const path of V5_SOURCES) {
      assert.equal(source(path).length > 0, true);
    }
  });
});
