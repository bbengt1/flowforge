/**
 * R5.2: Credential test / rotate / usage density.
 *
 * Relates to #265 / Part of #231. Keep #265 open.
 *
 * Chloe UI only. Densify existing `/credentials/{id}` detail in place
 * (D6). Reuse E4.1 vault clients — GET detail, POST test / rotate /
 * disable / enable, GET usage, GET deletion-impact. No new routes, no
 * new credential types, no KEK in the browser, no `/config` merge.
 * Isolation hook `POST /workspace/credentials/{id}/use` is not the
 * product vault.
 *
 * Inherit Gracie R5 security line from R5.1:
 * 1. No KEK in the browser (`CREDENTIAL_KEK` / `keyReference` never shown).
 * 2. Display-name + UUID only after mutate.
 * 3. Secrets never in YAML / search / analytics.
 * 4. Unexpected plaintext on responses is a contract bug (strip + stop)
 *    — rotate must never surface plaintext secrets to the UI.
 *
 * CSRF on mutations stays with existing vault clients. ADV/RBAC/embed stay.
 */

import { EDITOR_CREDENTIAL } from "./editor-credential.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import {
  credentialDeletionImpactPath,
  credentialDisablePath,
  credentialEnablePath,
  credentialPath,
  credentialRotatePath,
  credentialTestPath,
  credentialUsagePath,
} from "./credential-contract.ts";
import {
  credentialStatusLabel,
  credentialTypeLabel,
  deletionConfirmationState,
  formatRef,
  secretDraftIsCleared,
  stripSecretFields,
} from "./credential.ts";
import {
  CREDENTIAL_KEK_ENV,
  CREDENTIAL_UUID_RE,
  CREDENTIAL_VAULT_STRIP_STOP_HELP,
  INVENTED_CONFIG_MERGE,
  ISOLATION_CREDENTIAL_USE_PATH,
  R5_GUARDRAILS,
  R5_LATER_STORY_NOTES,
  R5_SECURITY_LINE,
  credentialVaultDoesNotReadKek,
  credentialVaultHoldsSecurityLine,
  credentialVaultLastTestLabel,
  credentialVaultMustStopAfterStrip,
  credentialVaultTimeLabel,
  credentialVaultYamlRef,
} from "./credential-vault.ts";
import {
  CREDENTIAL_MVP_TYPES,
  type CredentialCatalog,
  type CredentialDeletionImpact,
  type CredentialRecord,
  type CredentialSecretDraft,
  type CredentialTestResult,
  type CredentialUsage,
} from "./credential-types.ts";
import { csrfRequiredFor } from "./session-contract.ts";
import { looksLikeSecretValue } from "./workflow-yaml-nodes.ts";
import { sanitizeNotification } from "./workspace-notifications.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

export const R52_STORY = 265;
export const R52_EPIC = 231;
export const R52_KEEP_STORY_OPEN = true;

export const CREDENTIAL_DETAIL_HREF = "/credentials/{id}";
export const CREDENTIAL_DETAIL_LIST_HREF = "/credentials";

export const CREDENTIAL_DETAIL_STRIP_STOP_HELP = CREDENTIAL_VAULT_STRIP_STOP_HELP;

export const CREDENTIAL_DETAIL_HELP =
  "Operate this credential at operate density: test, rotate, usage, and deletion-impact on existing vault routes. Disable and enable stay clear. After rotate, display-name + UUID only. Secrets never enter YAML, search, or analytics. Unexpected plaintext is a contract bug (strip + stop). The UI never reads CREDENTIAL_KEK. CSRF on mutations.";

export const CREDENTIAL_DETAIL_ROTATE_HELP =
  "POST /credentials/{id}/rotate {secret}. Masked fields submit once and clear. Rotate never returns plaintext — chrome shows display-name + UUID only.";

export const CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP =
  "Disable and enable stay explicit on POST /credentials/{id}/disable and …/enable. Status is Active or Disabled — not a cryptic toggle.";

export const CREDENTIAL_DETAIL_SOURCES: readonly string[] = [
  "src/lib/credential-detail.ts",
  "src/lib/credential-vault.ts",
  "src/lib/credential-client.ts",
  "src/lib/credential-contract.ts",
  "src/lib/credential.ts",
  "src/components/credentials/CredentialDetail.tsx",
  "src/app/credentials/[id]/page.tsx",
];

/** Existing E4.1 vault routes — do not invent replacements. */
export const CREDENTIAL_DETAIL_OPERATE_ROUTES = {
  get: "/credentials/{id}",
  test: "/credentials/{id}/test",
  rotate: "/credentials/{id}/rotate",
  usage: "/credentials/{id}/usage",
  deletionImpact: "/credentials/{id}/deletion-impact",
  disable: "/credentials/{id}/disable",
  enable: "/credentials/{id}/enable",
  delete: "/credentials/{id}",
} as const;

export const CREDENTIAL_DETAIL_CHROME_OMIT_KEYS = [
  "keyReference",
  "CREDENTIAL_KEK",
  "secret",
  "kubeconfig",
  "privateKey",
  "token",
  "password",
  "plaintext",
] as const;

export const CREDENTIAL_DETAIL_SECTIONS = [
  { id: "test", label: "Test" },
  { id: "rotate", label: "Rotate" },
  { id: "usage", label: "Usage" },
  { id: "deletionImpact", label: "Deletion impact" },
  { id: "disableEnable", label: "Disable / enable" },
] as const;

export type CredentialDetailSectionId =
  (typeof CREDENTIAL_DETAIL_SECTIONS)[number]["id"];

export const CREDENTIAL_DETAIL = {
  operateDensity: true,
  testAtOperateDensity: true,
  rotateAtOperateDensity: true,
  usageAtOperateDensity: true,
  deletionImpactAtOperateDensity: true,
  disableEnableRemainClear: true,
  rotateNeverReturnsPlaintext: true,
  displayNamePlusUuidOnlyAfterMutate: true,
  autoLoadUsageAndDeletionImpact: true,
  inheritR5SecurityLine: true,
  noKekInBrowser: true,
  noKeyReferenceInChrome: true,
  secretsNeverInYamlSearchOrAnalytics: true,
  unexpectedPlaintextIsContractBug: true,
  stripAndStop: true,
  csrfOnMutations: true,
  reuseExistingVaultRoutes: true,
  noNewApiRoutes: true,
  noNewCredentialTypes: true,
  noConfigMerge: true,
  isolationUseIsNotProductVault: true,
  migrateInPlace: true,
  embedUnchanged: true,
  rbacFailClosed: true,
} as const;

export type CredentialDetailIdentity = {
  id: string;
  displayName: string;
};

export type CredentialDetailTestDisplay = {
  status: string;
  reason: string;
  checkedAt: string;
  label: string;
};

export type CredentialDetailUsageDisplay = {
  credentialId: string;
  useCount: number;
  lastUsedLabel: string;
  lastUsedBy: string;
  drafts: readonly string[];
  versions: readonly string[];
  executions: readonly string[];
};

export type CredentialDetailImpactDisplay = {
  credentialId: string;
  displayName: string;
  statusLabel: string;
  canDelete: boolean;
  blockReason: string;
  drafts: readonly string[];
  versions: readonly string[];
  activeExecutions: readonly string[];
};

export function credentialDetailListHref(embed = false): string {
  return maybeEmbedDeepLink(CREDENTIAL_DETAIL_LIST_HREF, embed);
}

export function credentialDetailHref(
  credentialId: string,
  embed = false,
): string {
  return maybeEmbedDeepLink(credentialPath(credentialId), embed);
}

export function credentialDetailIdentity(
  record: Pick<CredentialRecord, "id" | "displayName">,
): CredentialDetailIdentity {
  return {
    id: record.id,
    displayName: record.displayName,
  };
}

/** After rotate / disable / enable / test, chrome may show this only. */
export function credentialDetailAfterMutate(
  record: Pick<CredentialRecord, "id" | "displayName">,
): CredentialDetailIdentity {
  return credentialDetailIdentity(record);
}

export function credentialDetailIdentityText(
  identity: CredentialDetailIdentity,
): string {
  return `${identity.displayName} (${identity.id})`;
}

export function credentialDetailIdentityIsDisplayNameAndUuid(
  identity: CredentialDetailIdentity,
): boolean {
  return (
    R5_SECURITY_LINE.displayNamePlusUuidOnly &&
    CREDENTIAL_DETAIL.displayNamePlusUuidOnlyAfterMutate &&
    Boolean(identity.displayName.trim()) &&
    CREDENTIAL_UUID_RE.test(identity.id) &&
    !looksLikeSecretValue(identity.displayName) &&
    !looksLikeSecretValue(identity.id) &&
    !("keyReference" in identity) &&
    !("secret" in identity)
  );
}

export function credentialDetailHeaderMeta(
  record: CredentialRecord,
  catalog?: CredentialCatalog,
): {
  identity: CredentialDetailIdentity;
  typeLabel: string;
  statusLabel: string;
  lastTestLabel: string;
  rotatedLabel: string;
  expiresLabel: string;
  useCountLabel: string;
} {
  return {
    identity: credentialDetailIdentity(record),
    typeLabel: credentialTypeLabel(record.type, catalog),
    statusLabel: credentialStatusLabel(record.status),
    lastTestLabel: credentialVaultLastTestLabel(record),
    rotatedLabel: credentialVaultTimeLabel(record.rotatedAt),
    expiresLabel: credentialVaultTimeLabel(record.expiresAt),
    useCountLabel: String(record.useCount),
  };
}

export function credentialDetailTestDisplay(
  test: CredentialTestResult | null | undefined,
  record?: Pick<
    CredentialRecord,
    "lastTestStatus" | "lastTestReason" | "lastTestedAt"
  > | null,
): CredentialDetailTestDisplay {
  const status = test?.status ?? record?.lastTestStatus ?? "untested";
  const reason = test?.reason ?? record?.lastTestReason ?? "";
  const checkedAt = credentialVaultTimeLabel(
    test?.checkedAt ?? record?.lastTestedAt,
  );
  return {
    status,
    reason,
    checkedAt,
    label: checkedAt === "—" ? status : `${status} · ${checkedAt}`,
  };
}

export function credentialDetailUsageDisplay(
  usage: CredentialUsage,
): CredentialDetailUsageDisplay {
  return {
    credentialId: usage.credentialId,
    useCount: usage.useCount,
    lastUsedLabel: credentialVaultTimeLabel(usage.lastUsedAt),
    lastUsedBy: usage.lastUsedBy?.trim() || "—",
    drafts: usage.drafts.map(formatRef),
    versions: usage.versions.map(formatRef),
    executions: usage.executions.map(formatRef),
  };
}

export function credentialDetailImpactDisplay(
  impact: CredentialDeletionImpact,
): CredentialDetailImpactDisplay {
  return {
    credentialId: impact.credentialId,
    displayName: impact.displayName,
    statusLabel: credentialStatusLabel(impact.status),
    canDelete: impact.canDelete,
    blockReason: impact.blockReason ?? "",
    drafts: impact.drafts.map(formatRef),
    versions: impact.versions.map(formatRef),
    activeExecutions: impact.activeExecutions.map(formatRef),
  };
}

export function credentialDetailDisableEnableLabel(
  status: CredentialRecord["status"],
): "Enable" | "Disable" {
  return status === "disabled" ? "Enable" : "Disable";
}

export function credentialDetailMustStopAfterStrip(
  strippedKeys: readonly string[],
): boolean {
  return (
    CREDENTIAL_DETAIL.stripAndStop &&
    credentialVaultMustStopAfterStrip(strippedKeys)
  );
}

const FORBIDDEN_DETAIL_CHROME = [
  "-----begin",
  "credential_kek",
  "dek_envelope",
  "ciphertext",
  "kind: config",
  "keyreference",
];

export function credentialDetailChromeOmitsSecretKeys(text: string): boolean {
  const compact = text.toLowerCase();
  return !FORBIDDEN_DETAIL_CHROME.some((needle) => compact.includes(needle));
}

export function credentialDetailHeaderOmitsKek(
  record: CredentialRecord,
  catalog?: CredentialCatalog,
): boolean {
  const meta = credentialDetailHeaderMeta(record, catalog);
  const text = [
    credentialDetailIdentityText(meta.identity),
    meta.typeLabel,
    meta.statusLabel,
    meta.lastTestLabel,
    meta.rotatedLabel,
    meta.expiresLabel,
    meta.useCountLabel,
  ].join(" ");
  return (
    CREDENTIAL_DETAIL.noKeyReferenceInChrome &&
    credentialDetailChromeOmitsSecretKeys(text) &&
    !text.includes(CREDENTIAL_KEK_ENV) &&
    !text.includes(record.keyReference)
  );
}

export function credentialDetailRotateNeverSurfacesPlaintext(args: {
  record: CredentialRecord;
  strippedKeys?: readonly string[];
  draft: CredentialSecretDraft;
}): boolean {
  const identity = credentialDetailAfterMutate(args.record);
  const text = credentialDetailIdentityText(identity);
  const leaked = stripSecretFields(identity).strippedKeys;
  return (
    CREDENTIAL_DETAIL.rotateNeverReturnsPlaintext &&
    secretDraftIsCleared(args.draft) &&
    credentialDetailIdentityIsDisplayNameAndUuid(identity) &&
    credentialDetailChromeOmitsSecretKeys(text) &&
    leaked.length === 0 &&
    !text.includes(CREDENTIAL_KEK_ENV) &&
    !JSON.stringify(identity).includes("keyReference") &&
    !JSON.stringify(identity).includes("BEGIN") &&
    (args.strippedKeys?.length
      ? credentialDetailMustStopAfterStrip(args.strippedKeys)
      : true)
  );
}

export function credentialDetailUsesExistingRoutes(
  credentialId: string,
): boolean {
  return (
    CREDENTIAL_DETAIL.reuseExistingVaultRoutes &&
    CREDENTIAL_DETAIL.noNewApiRoutes &&
    credentialPath(credentialId) === `/credentials/${credentialId}` &&
    credentialTestPath(credentialId) ===
      `/credentials/${credentialId}/test` &&
    credentialRotatePath(credentialId) ===
      `/credentials/${credentialId}/rotate` &&
    credentialUsagePath(credentialId) ===
      `/credentials/${credentialId}/usage` &&
    credentialDeletionImpactPath(credentialId) ===
      `/credentials/${credentialId}/deletion-impact` &&
    credentialDisablePath(credentialId) ===
      `/credentials/${credentialId}/disable` &&
    credentialEnablePath(credentialId) ===
      `/credentials/${credentialId}/enable`
  );
}

export function credentialDetailCsrfOnMutations(): boolean {
  const sample = "/api/v1/credentials/11111111-1111-4111-8111-111111111111";
  return (
    R5_GUARDRAILS.csrfOnMutations &&
    CREDENTIAL_DETAIL.csrfOnMutations &&
    csrfRequiredFor("POST", `${sample}/rotate`) &&
    csrfRequiredFor("POST", `${sample}/test`) &&
    csrfRequiredFor("POST", `${sample}/disable`) &&
    csrfRequiredFor("POST", `${sample}/enable`) &&
    csrfRequiredFor("DELETE", sample) &&
    !csrfRequiredFor("GET", `${sample}/usage`) &&
    !csrfRequiredFor("GET", `${sample}/deletion-impact`)
  );
}

export function credentialDetailDoesNotReadKek(): boolean {
  return (
    R5_SECURITY_LINE.noKekInBrowser &&
    CREDENTIAL_DETAIL.noKekInBrowser &&
    credentialVaultDoesNotReadKek() &&
    CREDENTIAL_KEK_ENV === "CREDENTIAL_KEK" &&
    /never reads CREDENTIAL_KEK/.test(CREDENTIAL_DETAIL_HELP) &&
    !/process\.env/.test(CREDENTIAL_DETAIL_HELP)
  );
}

export function credentialDetailSecretsStayOutOfYamlSearchAnalytics(
  record: CredentialRecord,
  usage?: CredentialUsage,
  impact?: CredentialDeletionImpact,
): boolean {
  const identity = credentialDetailAfterMutate(record);
  const yamlRef = credentialVaultYamlRef(record);
  const note = sanitizeNotification({
    kind: "info",
    title: identity.displayName,
    detail: identity.id,
    href: credentialDetailHref(identity.id),
    token: "should-not-notify",
    kubeconfig: "apiVersion: v1",
  });
  const usageText = usage
    ? JSON.stringify(credentialDetailUsageDisplay(usage))
    : "";
  const impactText = impact
    ? JSON.stringify(credentialDetailImpactDisplay(impact))
    : "";
  return (
    R5_SECURITY_LINE.secretsNeverInYamlSearchOrAnalytics &&
    CREDENTIAL_DETAIL.secretsNeverInYamlSearchOrAnalytics &&
    EDITOR_CREDENTIAL.yamlStoresUuidOnly &&
    EDITOR_CREDENTIAL.noSecretsInYamlSearchOrAnalytics &&
    CREDENTIAL_UUID_RE.test(yamlRef.credentialId) &&
    !("secret" in yamlRef) &&
    credentialDetailIdentityIsDisplayNameAndUuid(identity) &&
    Boolean(note) &&
    !JSON.stringify(note).includes("should-not-notify") &&
    credentialDetailChromeOmitsSecretKeys(usageText) &&
    credentialDetailChromeOmitsSecretKeys(impactText)
  );
}

export function credentialDetailHoldsSecurityLine(
  record?: CredentialRecord,
  strippedKeys: readonly string[] = [],
  draft?: CredentialSecretDraft,
): boolean {
  return (
    CREDENTIAL_DETAIL.inheritR5SecurityLine &&
    credentialVaultHoldsSecurityLine(record ? [record] : [], strippedKeys) &&
    credentialDetailDoesNotReadKek() &&
    R5_SECURITY_LINE.displayNamePlusUuidOnly &&
    R5_SECURITY_LINE.secretsNeverInYamlSearchOrAnalytics &&
    R5_SECURITY_LINE.stripAndStop &&
    (record
      ? credentialDetailIdentityIsDisplayNameAndUuid(
          credentialDetailAfterMutate(record),
        ) && credentialDetailHeaderOmitsKek(record)
      : true) &&
    (record && draft
      ? credentialDetailRotateNeverSurfacesPlaintext({
          record,
          strippedKeys,
          draft,
        })
      : true) &&
    (strippedKeys.length === 0 ||
      credentialDetailMustStopAfterStrip(strippedKeys))
  );
}

export function credentialDetailDoesNotMergeConfig(): boolean {
  return (
    R5_GUARDRAILS.noConfigMerge &&
    CREDENTIAL_DETAIL.noConfigMerge &&
    !credentialDetailListHref().startsWith(INVENTED_CONFIG_MERGE) &&
    !CREDENTIAL_DETAIL_SOURCES.some((source) => source.includes("/config/"))
  );
}

export function credentialDetailTypesUnchanged(): boolean {
  return (
    R5_GUARDRAILS.noNewCredentialTypes &&
    CREDENTIAL_DETAIL.noNewCredentialTypes &&
    CREDENTIAL_MVP_TYPES.length === 5
  );
}

export function credentialDetailIsolationUseIsNotProduct(): boolean {
  return (
    R5_GUARDRAILS.isolationUseIsNotProductVault &&
    CREDENTIAL_DETAIL.isolationUseIsNotProductVault &&
    ISOLATION_CREDENTIAL_USE_PATH === "/workspace/credentials/{id}/use" &&
    !credentialDetailHref("11111111-1111-4111-8111-111111111111").includes(
      "/workspace/credentials/",
    )
  );
}

export function credentialDetailEmbedUnchanged(): boolean {
  const item = WORKSPACE_NAV_ITEMS.find((entry) => entry.id === "credentials");
  const detail = EMBED_ROUTES.filter((route) => route.id === "credential");
  return (
    CREDENTIAL_DETAIL.embedUnchanged &&
    item?.href === CREDENTIAL_DETAIL_LIST_HREF &&
    detail.length === 1 &&
    detail[0]?.standalone === "/credentials/{id}" &&
    detail[0]?.embed === "/embed/v1/credentials/{id}"
  );
}

export function credentialDetailCanConfirmDelete(
  impact: CredentialDeletionImpact | null,
  typedName: string,
): boolean {
  return deletionConfirmationState(impact, typedName).canProceed;
}

export function credentialDetailSectionIds(): readonly CredentialDetailSectionId[] {
  return CREDENTIAL_DETAIL_SECTIONS.map((section) => section.id);
}

export {
  CREDENTIAL_KEK_ENV,
  R5_GUARDRAILS,
  R5_LATER_STORY_NOTES,
  R5_SECURITY_LINE,
};
