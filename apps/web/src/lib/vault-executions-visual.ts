/**
 * V.5: Vault + executions restyle.
 *
 * Relates to #361 / Part of #353. Keep #361 open.
 *
 * Chloe UI only. Dark find/detail and inbox density on the V.1
 * token tree (docs/internal/flowforge-visual-ia-north-star.md
 * § vault / executions / V.5). Standalone and `/embed/v1` share
 * the same CredentialVault / CredentialDetail / ExecutionHistory
 * / ExecutionDetail. No second theme. No n8n orange.
 *
 * Surfaces: `/credentials*`, `/executions*`, editor overlay
 * (status paint only). Metadata only in the vault (display-name
 * + UUID). No KEK chrome. Inbox is not a second replay graph.
 * One replay path: `/executions/{id}` / Open execution. Loud
 * `indeterminate` (icon + text + explanation). Drafts never run.
 * ADV-024 isolation success stays a denial — contrast is not
 * quieter.
 *
 * Hard lines: Vault display-name+UUID only · no KEK · ADV-024 ·
 * drafts never run · YAML SoT · not an n8n clone · loud
 * indeterminate.
 */

import {
  AESTHETIC_USABILITY,
  ISOLATION_DENIAL_LABEL,
  LOUD_ADV024_DENIAL_CLASS,
  LOUD_ADV024_LEAK_CLASS,
  LOUD_ERROR_CLASS,
  LOUD_INDETERMINATE_CLASS,
  LOUD_INDETERMINATE_SURFACE,
  loudContrastNotQuieter,
} from "./aesthetic-usability-density.ts";
import {
  CREDENTIAL_DETAIL,
  credentialDetailDoesNotReadKek,
} from "./credential-detail.ts";
import {
  CREDENTIAL_VAULT,
  CREDENTIAL_VAULT_IDENTITY_KEYS,
  CREDENTIAL_VAULT_OPEN_LABEL,
  R5_SECURITY_LINE,
  credentialVaultDoesNotReadKek,
} from "./credential-vault.ts";
import { EDITOR_RUNS } from "./editor-runs.ts";
import {
  EXECUTION_INBOX,
  EXECUTION_INBOX_DETAIL_PATH,
  EXECUTION_INBOX_OPEN_LABEL,
  INVENTED_REPLAY_ROUTE,
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
import { R7_HARD_LINE } from "./rewrite-embed-mount.ts";
import {
  FF_ACCENT,
  FF_CANVAS,
  FF_DANGER,
  FF_SURFACE,
  FORBIDDEN_THEME_TREES,
  N8N_ORANGE_TOKENS,
  VISUAL_TOKENS,
  n8nOrangePresent,
  secondThemeTreePresent,
} from "./visual-tokens.ts";

export const V5_STORY = 361;
export const V5_EPIC = 353;
export const V5_KEEP_STORY_OPEN = true;
export const V5_ID = "V.5-vault-executions-restyle" as const;
export const V5_BRIEF = "docs/internal/flowforge-visual-ia-north-star.md";
export const V5_TOKEN_FILE = "src/app/tokens.css";

export const V5_HELP =
  "Dark find/detail and inbox density using V.1 tokens. Vault identity is display-name + UUID only. No KEK chrome. Inbox is not a second replay graph. One replay path to /executions/{id} / Open execution. Indeterminate stays loud (icon + text + explanation). Drafts never run. ADV-024 isolation success stays a denial — contrast is not quieter. Not an n8n clone.";

export const VAULT_EXECUTIONS_VISUAL = {
  ...R7_HARD_LINE,
  inheritR7HardLine: true,
  inheritV1Tokens: true,
  inheritV2Shell: true,
  inheritR4InboxGuardrails: true,
  inheritR5SecurityLine: true,
  inheritUxl4PeakEnd: true,
  inheritUxl8LoudContrast: true,
  d6MigrateInPlace: true,
  uiOnly: true,
  darkFindDetail: true,
  darkInboxDensity: true,
  vaultMetadataOnly: true,
  vaultDisplayNameUuidOnly: true,
  noKekChrome: true,
  noKekInBrowser: true,
  noFingerprintAsSecret: true,
  inboxIsNotSecondReplayGraph: true,
  oneReplayPath: true,
  openExecutionGoesToDetail: true,
  loudIndeterminate: true,
  indeterminateIconTextExplanation: true,
  draftsNeverRun: true,
  yamlIsSourceOfTruth: true,
  adv024IsolationSuccessIsDenial: true,
  adv024DenialContrastStaysLoud: true,
  noQuieterDenials: true,
  oneAccent: true,
  accentIsTealFamily: true,
  noSecondThemeTree: true,
  noN8nOrange: true,
  notAnN8nClone: true,
  noGreenfieldApis: true,
  keep361Open: true,
  jonnyNoneExpected: true,
} as const;

export const FF_VAULT_ATTR = "data-ff-vault";
export const FF_VAULT_VALUE = "v5";
export const FF_INBOX_ATTR = "data-ff-inbox";
export const FF_INBOX_VALUE = "v5";

export const FF_VAULT_ROOT_CLASS = "ff-vault";
export const FF_VAULT_PANEL_CLASS = "ff-vault-panel";
export const FF_VAULT_HEADER_CLASS = "ff-vault-header";
export const FF_VAULT_ROW_CLASS = "ff-vault-row";
export const FF_VAULT_ROW_FOCUSED_CLASS = "ff-vault-row-focused";
export const FF_VAULT_LIST_CLASS = "ff-vault-list";
export const FF_VAULT_PRIMARY_CLASS = "ff-vault-primary";
export const FF_VAULT_GHOST_CLASS = "ff-vault-ghost";
export const FF_VAULT_CONTROL_CLASS = "ff-vault-control";
export const FF_VAULT_MUTED_CLASS = "ff-vault-muted";
export const FF_VAULT_TITLE_CLASS = "ff-vault-title";
export const FF_VAULT_LINK_CLASS = "ff-vault-link";
export const FF_VAULT_CHIP_CLASS = "ff-vault-chip";
export const FF_VAULT_CHIP_ACCENT_CLASS = "ff-vault-chip-accent";
export const FF_VAULT_UUID_CLASS = "ff-vault-uuid";
export const FF_VAULT_EMPTY_CLASS = "ff-vault-empty";
export const FF_VAULT_DANGER_CLASS = "ff-vault-danger";
export const FF_VAULT_EYEBROW_CLASS = "ff-vault-eyebrow";
export const FF_VAULT_HELP_CLASS = "ff-vault-help";

export const FF_INBOX_ROOT_CLASS = "ff-inbox";
export const FF_INBOX_PANEL_CLASS = "ff-inbox-panel";
export const FF_INBOX_HEADER_CLASS = "ff-inbox-header";
export const FF_INBOX_ROW_CLASS = "ff-inbox-row";
export const FF_INBOX_ROW_FOCUSED_CLASS = "ff-inbox-row-focused";
export const FF_INBOX_ROW_INDETERMINATE_CLASS = "ff-inbox-row-indeterminate";
export const FF_INBOX_ROW_WAITING_CLASS = "ff-inbox-row-waiting";
export const FF_INBOX_ROW_CURRENT_CLASS = "ff-inbox-row-current";
export const FF_INBOX_LIST_CLASS = "ff-inbox-list";
export const FF_INBOX_PRIMARY_CLASS = "ff-inbox-primary";
export const FF_INBOX_GHOST_CLASS = "ff-inbox-ghost";
export const FF_INBOX_CONTROL_CLASS = "ff-inbox-control";
export const FF_INBOX_MUTED_CLASS = "ff-inbox-muted";
export const FF_INBOX_TITLE_CLASS = "ff-inbox-title";
export const FF_INBOX_LINK_CLASS = "ff-inbox-link";
export const FF_INBOX_CHIP_CLASS = "ff-inbox-chip";
export const FF_INBOX_CHIP_ACCENT_CLASS = "ff-inbox-chip-accent";
export const FF_INBOX_EMPTY_CLASS = "ff-inbox-empty";
export const FF_INBOX_DANGER_CLASS = "ff-inbox-danger";
export const FF_INBOX_EYEBROW_CLASS = "ff-inbox-eyebrow";
export const FF_INBOX_HELP_CLASS = "ff-inbox-help";

export const FF_LOUD_INDETERMINATE_CLASS = "ff-loud-indeterminate";
export const FF_LOUD_DANGER_CLASS = "ff-loud-danger";
export const FF_LOUD_WARNING_CLASS = "ff-loud-warning";
export const FF_LOUD_DENIAL_CLASS = "ff-loud-denial";
export const FF_LOUD_LEAK_CLASS = "ff-loud-leak";

export const V5_SOURCES = [
  "src/lib/vault-executions-visual.ts",
  "src/lib/credential-vault.ts",
  "src/lib/credential-detail.ts",
  "src/lib/execution-inbox.ts",
  "src/lib/aesthetic-usability-density.ts",
  "src/components/credentials/CredentialVault.tsx",
  "src/components/credentials/CredentialVaultListbox.tsx",
  "src/components/credentials/CredentialDetail.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/executions/ExecutionDetail.tsx",
  "src/components/executions/ExecutionStatusBadge.tsx",
  "src/app/credentials/page.tsx",
  "src/app/executions/page.tsx",
  "src/app/globals.css",
] as const;

export const V5_CHROME_SOURCES = [
  "src/components/credentials/CredentialVault.tsx",
  "src/components/credentials/CredentialVaultListbox.tsx",
  "src/components/credentials/CredentialDetail.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/CredentialCard.tsx",
  "src/components/credentials/CredentialWizardDialog.tsx",
  "src/components/credentials/CredentialTestDialog.tsx",
  "src/components/credentials/DeleteImpactDialog.tsx",
  "src/components/credentials/SecretField.tsx",
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/executions/ExecutionDetail.tsx",
  "src/components/executions/ExecutionStatusBadge.tsx",
  "src/components/executions/ExecutionReplay.tsx",
  "src/components/executions/ExecutionDecideActions.tsx",
  "src/components/executions/ExecutionOperateActions.tsx",
  "src/components/executions/ExecutionArtifacts.tsx",
  "src/components/executions/ExecutionCompare.tsx",
  "src/components/executions/RolloutObservationPanel.tsx",
  "src/components/executions/ScriptIoResultPanel.tsx",
  "src/app/credentials/page.tsx",
  "src/app/credentials/[id]/page.tsx",
  "src/app/credentials/new/page.tsx",
  "src/app/executions/page.tsx",
  "src/app/executions/[id]/page.tsx",
  "src/app/globals.css",
] as const;

export const V5_VAULT_SOURCES = [
  "src/components/credentials/CredentialVault.tsx",
  "src/components/credentials/CredentialVaultListbox.tsx",
  "src/components/credentials/CredentialDetail.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/CredentialCard.tsx",
] as const;

export const V5_INBOX_SOURCES = [
  "src/components/executions/ExecutionHistory.tsx",
  "src/components/executions/ExecutionHistoryListbox.tsx",
  "src/components/executions/ExecutionDetail.tsx",
] as const;

export const LIGHT_VAULT_INBOX_TOKENS = [
  "bg-white",
  "bg-white/80",
  "bg-white/95",
  "bg-white/60",
  "border-zinc-200",
  "border-zinc-300",
  "border-zinc-100",
  "bg-zinc-50",
  "bg-zinc-100",
  "bg-teal-50",
  "text-zinc-900",
  "text-teal-950",
  "#f6f5f1",
] as const;

export const KEK_CHROME_TOKENS = [
  "CREDENTIAL_KEK",
  "keyReference",
  "credential_kek",
] as const;

export const FINGERPRINT_SECRET_TOKENS = [
  "Fingerprint",
  "fingerprint",
  "keyReference",
] as const;

export const SECOND_REPLAY_GRAPH_TOKENS = [
  "ExecutionReplay",
  "/replay",
  "second replay graph",
  "inbox graph",
] as const;

export function vaultInboxUsesV1TokenClasses(globals: string): boolean {
  return (
    globals.includes(`.${FF_VAULT_PANEL_CLASS}`) &&
    globals.includes(`.${FF_INBOX_PANEL_CLASS}`) &&
    globals.includes(`.${FF_VAULT_ROW_CLASS}`) &&
    globals.includes(`.${FF_INBOX_ROW_CLASS}`) &&
    globals.includes(`.${FF_LOUD_INDETERMINATE_CLASS}`) &&
    globals.includes(`.${FF_LOUD_DENIAL_CLASS}`) &&
    globals.includes("background: var(--ff-surface)") &&
    globals.includes("background: var(--ff-accent)") &&
    globals.includes("color: var(--ff-accent-foreground)") &&
    globals.includes("var(--ff-text)") &&
    globals.includes("var(--ff-muted)") &&
    globals.includes("var(--ff-border)") &&
    globals.includes("var(--ff-danger)") &&
    globals.includes("var(--ff-danger-surface)")
  );
}

export function vaultInboxChromeRejectsLightLook(source: string): boolean {
  return LIGHT_VAULT_INBOX_TOKENS.every((token) => !source.includes(token));
}

export function vaultChromeOmitsKek(source: string): boolean {
  return KEK_CHROME_TOKENS.every((token) => !source.includes(token));
}

export function vaultChromeOmitsFingerprintAsSecret(source: string): boolean {
  return !source.includes("Fingerprint") && !source.includes("keyReference");
}

export function inboxOmitsSecondReplayGraph(source: string): boolean {
  return (
    !source.includes("ExecutionReplay") &&
    !source.includes(INVENTED_REPLAY_ROUTE) &&
    !source.includes("second replay graph")
  );
}

export function vaultVisualHoldsAcceptance(input: {
  vault: string;
  listbox: string;
  detail: string;
  wizard: string;
}): boolean {
  return (
    input.vault.includes("data-ff-vault") &&
    input.vault.includes("FF_VAULT_VALUE") &&
    input.vault.includes("FF_VAULT_ROOT_CLASS") &&
    input.vault.includes("FF_VAULT_PANEL_CLASS") &&
    input.vault.includes("FF_VAULT_PRIMARY_CLASS") &&
    input.listbox.includes("FF_VAULT_LIST_CLASS") &&
    input.listbox.includes("FF_VAULT_ROW_CLASS") &&
    input.listbox.includes("FF_VAULT_UUID_CLASS") &&
    input.listbox.includes("row.displayName") &&
    input.listbox.includes("row.id") &&
    input.detail.includes("FF_VAULT_PANEL_CLASS") &&
    input.detail.includes("header?.identity.displayName") &&
    input.detail.includes("header?.identity.id") &&
    input.wizard.includes("FF_VAULT_PANEL_CLASS") &&
    vaultChromeOmitsKek(input.vault) &&
    vaultChromeOmitsKek(input.listbox) &&
    vaultChromeOmitsKek(input.detail)
  );
}

export function inboxVisualHoldsAcceptance(input: {
  history: string;
  listbox: string;
  detail: string;
  badge: string;
}): boolean {
  return (
    input.history.includes("data-ff-inbox") &&
    input.history.includes("FF_INBOX_VALUE") &&
    input.history.includes("FF_INBOX_ROOT_CLASS") &&
    input.history.includes("FF_INBOX_PANEL_CLASS") &&
    input.listbox.includes("FF_INBOX_LIST_CLASS") &&
    input.listbox.includes("FF_INBOX_ROW_INDETERMINATE_CLASS") &&
    input.listbox.includes("EXECUTION_INBOX_OPEN_LABEL") &&
    input.listbox.includes("INDETERMINATE_STATUS_HELP") &&
    input.listbox.includes("PeakEndEnding") &&
    input.detail.includes("FF_INBOX_PANEL_CLASS") &&
    input.detail.includes("ExecutionStatusBadge") &&
    input.badge.includes("LOUD_INDETERMINATE_CLASS") &&
    input.badge.includes("presentation.icon") &&
    input.badge.includes("presentation.label") &&
    inboxOmitsSecondReplayGraph(input.history) &&
    inboxOmitsSecondReplayGraph(input.listbox)
  );
}

export function vaultExecutionsVisualHoldsHardLines(): boolean {
  return (
    VAULT_EXECUTIONS_VISUAL.yamlIsSourceOfTruth &&
    VAULT_EXECUTIONS_VISUAL.draftsNeverRun &&
    VAULT_EXECUTIONS_VISUAL.vaultDisplayNameUuidOnly &&
    VAULT_EXECUTIONS_VISUAL.noKekChrome &&
    VAULT_EXECUTIONS_VISUAL.noKekInBrowser &&
    VAULT_EXECUTIONS_VISUAL.inboxIsNotSecondReplayGraph &&
    VAULT_EXECUTIONS_VISUAL.oneReplayPath &&
    VAULT_EXECUTIONS_VISUAL.loudIndeterminate &&
    VAULT_EXECUTIONS_VISUAL.adv024IsolationSuccessIsDenial &&
    VAULT_EXECUTIONS_VISUAL.adv024DenialContrastStaysLoud &&
    VAULT_EXECUTIONS_VISUAL.noQuieterDenials &&
    VAULT_EXECUTIONS_VISUAL.notAnN8nClone &&
    VAULT_EXECUTIONS_VISUAL.noN8nOrange &&
    VAULT_EXECUTIONS_VISUAL.noSecondThemeTree &&
    VAULT_EXECUTIONS_VISUAL.keep361Open &&
    VAULT_EXECUTIONS_VISUAL.inheritV1Tokens &&
    VAULT_EXECUTIONS_VISUAL.uiOnly &&
    VAULT_EXECUTIONS_VISUAL.noGreenfieldApis &&
    VISUAL_TOKENS.sameTokenFileStandaloneAndEmbed &&
    VISUAL_TOKENS.oneAccent &&
    FF_ACCENT.toLowerCase() === "#0f766e" &&
    FF_CANVAS.toLowerCase() === "#0f1218" &&
    FF_SURFACE.toLowerCase() === "#171b22" &&
    FF_DANGER.toLowerCase() === "#fb7185" &&
    CREDENTIAL_VAULT.displayNamePlusUuidOnly &&
    CREDENTIAL_VAULT.noKekInBrowser &&
    R5_SECURITY_LINE.noKekInBrowser &&
    R5_SECURITY_LINE.displayNamePlusUuidOnly &&
    credentialVaultDoesNotReadKek() &&
    credentialDetailDoesNotReadKek() &&
    CREDENTIAL_DETAIL.noKekInBrowser &&
    executionInboxDraftsNeverRun() &&
    executionInboxHasSingleOperatePath() &&
    executionInboxIndeterminateIsLoud() &&
    EXECUTION_INBOX.noInboxReplayGraph &&
    EXECUTION_INBOX_DETAIL_PATH === "/executions/{id}" &&
    EXECUTION_INBOX_OPEN_LABEL === "Open" &&
    CREDENTIAL_VAULT_OPEN_LABEL === "Open" &&
    CREDENTIAL_VAULT_IDENTITY_KEYS[0] === "displayName" &&
    CREDENTIAL_VAULT_IDENTITY_KEYS[1] === "id" &&
    R4_GUARDRAILS.noInboxReplayGraph &&
    R4_GUARDRAILS.loudIndeterminate &&
    R4_GUARDRAILS.draftsNeverRun &&
    EDITOR_RUNS.noSecondReplayCanvas &&
    PEAK_END_OPERATE.loudIndeterminateOnOverlayAndInbox &&
    MEMBERSHIP_ISOLATION_CHROME.isolationSuccessIsDenial &&
    isolationHeldIsSuccess(true) &&
    ISOLATION_DENIAL_LABEL === "Denial" &&
    LOUD_INDETERMINATE_CLASS.includes(FF_LOUD_INDETERMINATE_CLASS) &&
    LOUD_ADV024_DENIAL_CLASS.includes(FF_LOUD_DENIAL_CLASS) &&
    loudContrastNotQuieter(LOUD_INDETERMINATE_CLASS) &&
    loudContrastNotQuieter(LOUD_ERROR_CLASS) &&
    loudContrastNotQuieter(LOUD_ADV024_DENIAL_CLASS) &&
    loudContrastNotQuieter(LOUD_ADV024_LEAK_CLASS) &&
    R7_HARD_LINE.adv024MembershipIsolationStayGrantGated
  );
}

export function vaultExecutionsVisualInheritsPriorStories(): boolean {
  return (
    VAULT_EXECUTIONS_VISUAL.inheritV1Tokens &&
    VAULT_EXECUTIONS_VISUAL.inheritV2Shell &&
    VAULT_EXECUTIONS_VISUAL.inheritR4InboxGuardrails &&
    VAULT_EXECUTIONS_VISUAL.inheritR5SecurityLine &&
    VAULT_EXECUTIONS_VISUAL.inheritUxl4PeakEnd &&
    VAULT_EXECUTIONS_VISUAL.inheritUxl8LoudContrast &&
    CREDENTIAL_VAULT.metadataOnly &&
    EXECUTION_INBOX.oneOperatePath &&
    AESTHETIC_USABILITY.adv024DenialContrastStaysLoud &&
    AESTHETIC_USABILITY.loudStatusDoesNotGetQuieter &&
    AESTHETIC_USABILITY.isolationSuccessIsDenialNotPass &&
    PEAK_END_OPERATE.inboxIsNotSecondReplayGraph &&
    LOUD_INDETERMINATE_SURFACE.includes(FF_LOUD_INDETERMINATE_CLASS)
  );
}

export function vaultInboxChromeRejectsForbiddenLook(source: string): boolean {
  return (
    !n8nOrangePresent(source) &&
    !secondThemeTreePresent(source) &&
    vaultInboxChromeRejectsLightLook(source) &&
    vaultChromeOmitsKek(source) &&
    !FORBIDDEN_THEME_TREES.some((tree) => source.includes(tree)) &&
    !N8N_ORANGE_TOKENS.some((token) =>
      source.toLowerCase().includes(token.toLowerCase()),
    )
  );
}
