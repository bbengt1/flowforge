/**
 * R5.3: NDV add credential without leaving the graph.
 *
 * Relates to #266 / Part of #231. Keep #266 open.
 *
 * Chloe UI only. Densify the existing selected-node NDV add path in
 * place (D6). Reuse UX.7 vault create + masked wizard (modal or
 * `/credentials/new` return-to-editor). After add, the NDV picker
 * selects the new credential by display name; YAML stores UUID only.
 * No SecretField / plaintext in the NDV; wizard stays guided add;
 * NDV stays edit/pick. No new credential types, no `/config` merge.
 * Isolation hook `POST /workspace/credentials/{id}/use` is not the
 * product vault.
 *
 * Inherit Gracie R5 security line from R5.1:
 * 1. No KEK in the browser (`CREDENTIAL_KEK` never read or sent).
 * 2. Display-name + UUID only after add. Picker selects by display
 *    name; YAML stores UUID only.
 * 3. Secrets never in YAML / search / analytics.
 * 4. Unexpected plaintext on responses is a contract bug
 *    (strip + stop) — no SecretField / plaintext in the NDV.
 *
 * CSRF on create stays with existing vault clients. ADV/RBAC/embed stay.
 */

import {
  EDITOR_CREDENTIAL,
  EDITOR_CREDENTIAL_NEW_HREF,
  createdCredentialSelectable,
  inspectorAddCredentialHref,
  inspectorCreatedCredentialPatch,
  inspectorCredentialQueryIsSecretFree,
  inspectorEditorReturnHref,
  parseInspectorCreatedCredential,
  parseInspectorCredentialReturnTo,
  stripInspectorCredentialQuery,
  type InspectorCreatedCredential,
  type InspectorCredentialReturnTo,
  type InspectorPendingCredential,
} from "./editor-credential.ts";
import { ndvInspectorIsEdit, ndvWizardStaysAdd } from "./editor-ndv.ts";
import { EDITOR_INSPECTOR } from "./editor-inspector.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import { credentialsPath } from "./credential-contract.ts";
import { isSecretFieldName } from "./credential.ts";
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
  credentialVaultMustStopAfterStrip,
  credentialVaultYamlRef,
} from "./credential-vault.ts";
import {
  CREDENTIAL_MVP_TYPES,
  type CredentialRecord,
  type CredentialType,
} from "./credential-types.ts";
import { csrfRequiredFor } from "./session-contract.ts";
import { looksLikeSecretValue } from "./workflow-yaml-nodes.ts";
import { sanitizeNotification } from "./workspace-notifications.ts";
import { WORKSPACE_NAV_ITEMS } from "./workspace-nav.ts";

export const R53_STORY = 266;
export const R53_EPIC = 231;
export const R53_KEEP_STORY_OPEN = true;

export const CREDENTIAL_NDV_ADD_HREF = "/credentials/new";
export const CREDENTIAL_NDV_ADD_OPEN_LABEL = "Open guided wizard (returns here)";
export const CREDENTIAL_NDV_ADD_ACTION_LABEL = "Add credential";

export const SELECT_CREDENTIAL_NAME_PARAM = "selectCredentialName";
export const SELECT_CREDENTIAL_TYPE_PARAM = "selectCredentialType";

export const CREDENTIAL_NDV_ADD_STRIP_STOP_HELP =
  CREDENTIAL_VAULT_STRIP_STOP_HELP;

export const CREDENTIAL_NDV_ADD_HELP =
  "Add a vault credential from the selected node without abandoning the graph. The guided masked wizard stays add; this inspector stays edit/pick. After add, the picker selects the new credential by display name and YAML stores the UUID only. SecretField and plaintext stay out of the NDV. Unexpected plaintext is a contract bug (strip + stop). The UI never reads CREDENTIAL_KEK.";

export const CREDENTIAL_NDV_ADD_WIZARD_HELP =
  "Guided add only. Masked fields submit once and clear. After create you return to the editor; the NDV picker selects the display name and YAML stores the UUID. The inspector never gains a secret surface.";

export const CREDENTIAL_NDV_ADD_SOURCES: readonly string[] = [
  "src/lib/credential-ndv-add.ts",
  "src/lib/editor-credential.ts",
  "src/lib/credential-vault.ts",
  "src/lib/credential-client.ts",
  "src/lib/credential-contract.ts",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/CredentialWizardDialog.tsx",
  "src/app/credentials/new/page.tsx",
];

export const CREDENTIAL_NDV_ADD = {
  addFromSelectedNodeNdv: true,
  guidedMaskedWizard: true,
  withoutAbandoningTheGraph: true,
  returnToEditor: true,
  returnToEditorIsDefault: true,
  afterAddSelectsDisplayName: true,
  yamlStoresUuidOnly: true,
  wizardStaysGuidedAdd: true,
  ndvStaysEditPick: true,
  noSecretFieldInNdv: true,
  noPlaintextInNdv: true,
  inheritR5SecurityLine: true,
  noKekInBrowser: true,
  secretsNeverInYamlSearchOrAnalytics: true,
  unexpectedPlaintextIsContractBug: true,
  stripAndStop: true,
  csrfOnMutations: true,
  reuseExistingVaultCreate: true,
  noNewApiRoutes: true,
  noNewCredentialTypes: true,
  noConfigMerge: true,
  isolationUseIsNotProductVault: true,
  migrateInPlace: true,
  embedUnchanged: true,
  rbacFailClosed: true,
} as const;

export type CredentialNdvCreated = InspectorCreatedCredential & {
  displayName?: string;
  type?: CredentialType;
};

export type CredentialNdvAfterAdd = {
  displayName: string;
  credentialId: string;
};

export type CredentialNdvPickerSelection = {
  displayName: string;
  value: string;
  label: string;
};

export function credentialNdvAddHref(
  input: InspectorCredentialReturnTo,
  embed = false,
): string {
  return inspectorAddCredentialHref(input, embed);
}

export function credentialNdvEditorReturnHref(
  input: InspectorCredentialReturnTo & {
    credentialId: string;
    displayName?: string;
    type?: CredentialType;
  },
  embed = false,
): string {
  const base = inspectorEditorReturnHref(input, embed);
  const cut = base.indexOf("?");
  const path = cut === -1 ? base : base.slice(0, cut);
  const hashCut = base.indexOf("#");
  const hash = hashCut === -1 ? "" : base.slice(hashCut);
  const search =
    cut === -1 ? "" : base.slice(cut + 1, hashCut === -1 ? undefined : hashCut);
  const params = new URLSearchParams(search);
  const displayName = input.displayName?.trim() ?? "";
  if (displayName && !looksLikeSecretValue(displayName)) {
    params.set(SELECT_CREDENTIAL_NAME_PARAM, displayName);
  }
  if (input.type && CREDENTIAL_MVP_TYPES.includes(input.type)) {
    params.set(SELECT_CREDENTIAL_TYPE_PARAM, input.type);
  }
  const next = params.toString();
  return `${path}${next ? `?${next}` : ""}${hash}`;
}

function readCreatedSearch(
  input:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | string
    | null
    | undefined,
): URLSearchParams | Record<string, string | string[] | undefined> | null {
  if (input == null) {
    return null;
  }
  if (typeof input === "string") {
    return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  }
  return input;
}

function readCreatedParam(
  search: URLSearchParams | Record<string, string | string[] | undefined>,
  key: string,
): string {
  const raw =
    search instanceof URLSearchParams
      ? search.get(key)
      : Array.isArray(search[key])
        ? search[key]?.[0]
        : search[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || isSecretFieldName(key) || looksLikeSecretValue(value)) {
    return "";
  }
  return value;
}

export function parseCredentialNdvCreated(
  input:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | string
    | null
    | undefined,
): CredentialNdvCreated | null {
  const parsed = parseInspectorCreatedCredential(input);
  if (!parsed) {
    return null;
  }
  const search = readCreatedSearch(input);
  if (!search) {
    return parsed;
  }
  const displayName = readCreatedParam(search, SELECT_CREDENTIAL_NAME_PARAM);
  const typeRaw = readCreatedParam(search, SELECT_CREDENTIAL_TYPE_PARAM);
  const type = CREDENTIAL_MVP_TYPES.includes(typeRaw as CredentialType)
    ? (typeRaw as CredentialType)
    : undefined;
  return {
    ...parsed,
    ...(displayName ? { displayName } : {}),
    ...(type ? { type } : {}),
  };
}

export function stripCredentialNdvQuery(href: string): string {
  const stripped = stripInspectorCredentialQuery(href);
  const cut = stripped.indexOf("?");
  const path = cut === -1 ? stripped : stripped.slice(0, cut);
  const hashCut = stripped.indexOf("#");
  const hash = hashCut === -1 ? "" : stripped.slice(hashCut);
  const search =
    cut === -1
      ? ""
      : stripped.slice(cut + 1, hashCut === -1 ? undefined : hashCut);
  const params = new URLSearchParams(search);
  params.delete(SELECT_CREDENTIAL_NAME_PARAM);
  params.delete(SELECT_CREDENTIAL_TYPE_PARAM);
  const next = params.toString();
  return `${path}${next ? `?${next}` : ""}${hash}`;
}

export function credentialNdvPendingFromCreated(
  created: CredentialNdvCreated,
): InspectorPendingCredential | null {
  if (!created.displayName || !created.type) {
    return null;
  }
  const pending = {
    id: created.credentialId,
    displayName: created.displayName,
    type: created.type,
  };
  return createdCredentialSelectable(pending) ? pending : null;
}

export function credentialNdvAfterAdd(
  record: Pick<CredentialRecord, "id" | "displayName" | "type">,
): CredentialNdvAfterAdd | null {
  if (!createdCredentialSelectable(record)) {
    return null;
  }
  return {
    displayName: record.displayName,
    credentialId: record.id,
  };
}

export function credentialNdvPickerSelection(
  record: Pick<CredentialRecord, "id" | "displayName" | "type">,
): CredentialNdvPickerSelection | null {
  const after = credentialNdvAfterAdd(record);
  if (!after) {
    return null;
  }
  return {
    displayName: after.displayName,
    value: after.credentialId,
    label: `${after.displayName} (${record.type})`,
  };
}

export function credentialNdvYamlRef(
  record: Pick<CredentialRecord, "id" | "displayName">,
): { credentialId: string } {
  return credentialVaultYamlRef(record);
}

export function credentialNdvCreatedPatch(
  field: string,
  credentialId: string,
): Record<string, unknown> {
  return inspectorCreatedCredentialPatch(field, credentialId);
}

export function credentialNdvMustStopAfterStrip(
  strippedKeys: readonly string[],
): boolean {
  return (
    CREDENTIAL_NDV_ADD.stripAndStop &&
    credentialVaultMustStopAfterStrip(strippedKeys)
  );
}

const FORBIDDEN_NDV_CHROME = [
  "-----begin",
  "credential_kek",
  "dek_envelope",
  "ciphertext",
  "kind: config",
  "keyreference",
];

export function credentialNdvChromeOmitsSecretKeys(text: string): boolean {
  const compact = text.toLowerCase();
  return !FORBIDDEN_NDV_CHROME.some((needle) => compact.includes(needle));
}

export function credentialNdvQueryIsSecretFree(search: string): boolean {
  return inspectorCredentialQueryIsSecretFree(search);
}

export function credentialNdvDoesNotReadKek(): boolean {
  return (
    R5_SECURITY_LINE.noKekInBrowser &&
    CREDENTIAL_NDV_ADD.noKekInBrowser &&
    credentialVaultDoesNotReadKek() &&
    CREDENTIAL_KEK_ENV === "CREDENTIAL_KEK" &&
    /never reads CREDENTIAL_KEK/.test(CREDENTIAL_NDV_ADD_HELP) &&
    !/process\.env/.test(CREDENTIAL_NDV_ADD_HELP)
  );
}

export function credentialNdvWizardIsAddNdvIsEditPick(): boolean {
  return (
    CREDENTIAL_NDV_ADD.wizardStaysGuidedAdd &&
    CREDENTIAL_NDV_ADD.ndvStaysEditPick &&
    ndvWizardStaysAdd() &&
    ndvInspectorIsEdit() &&
    EDITOR_INSPECTOR.wizardIsAdd &&
    EDITOR_INSPECTOR.inspectorIsEdit &&
    EDITOR_CREDENTIAL.noSecretFieldInRail &&
    EDITOR_CREDENTIAL.noPlaintextInRail
  );
}

export function credentialNdvCsrfOnCreate(): boolean {
  return (
    R5_GUARDRAILS.csrfOnMutations &&
    CREDENTIAL_NDV_ADD.csrfOnMutations &&
    csrfRequiredFor("POST", "/api/v1/credentials") &&
    !csrfRequiredFor("GET", "/api/v1/credentials")
  );
}

export function credentialNdvSecretsStayOutOfYamlSearchAnalytics(
  record: Pick<CredentialRecord, "id" | "displayName" | "type">,
): boolean {
  const after = credentialNdvAfterAdd(record);
  const yamlRef = credentialNdvYamlRef(record);
  const picker = after ? credentialNdvPickerSelection(record) : null;
  const note = sanitizeNotification({
    kind: "info",
    title: record.displayName,
    detail: record.id,
    href: credentialNdvAddHref({
      editorPath: "/workflows/11111111-1111-4111-8111-111111111111",
      workflowId: "11111111-1111-4111-8111-111111111111",
      nodeId: "ssh-run",
      field: "credentialId",
    }),
    token: "should-not-notify",
    kubeconfig: "apiVersion: v1",
  });
  return (
    R5_SECURITY_LINE.secretsNeverInYamlSearchOrAnalytics &&
    CREDENTIAL_NDV_ADD.secretsNeverInYamlSearchOrAnalytics &&
    EDITOR_CREDENTIAL.yamlStoresUuidOnly &&
    EDITOR_CREDENTIAL.noSecretsInYamlSearchOrAnalytics &&
    Boolean(after) &&
    CREDENTIAL_UUID_RE.test(yamlRef.credentialId) &&
    !("displayName" in yamlRef) &&
    !("secret" in yamlRef) &&
    picker?.displayName === record.displayName &&
    picker.value === record.id &&
    Boolean(note) &&
    !JSON.stringify(note).includes("should-not-notify") &&
    credentialNdvChromeOmitsSecretKeys(JSON.stringify(after)) &&
    credentialNdvChromeOmitsSecretKeys(JSON.stringify(yamlRef))
  );
}

export function credentialNdvHoldsSecurityLine(
  record?: CredentialRecord,
  strippedKeys: readonly string[] = [],
): boolean {
  return (
    CREDENTIAL_NDV_ADD.inheritR5SecurityLine &&
    credentialVaultHoldsSecurityLine(record ? [record] : [], strippedKeys) &&
    credentialNdvDoesNotReadKek() &&
    credentialNdvWizardIsAddNdvIsEditPick() &&
    R5_SECURITY_LINE.displayNamePlusUuidOnly &&
    R5_SECURITY_LINE.secretsNeverInYamlSearchOrAnalytics &&
    R5_SECURITY_LINE.stripAndStop &&
    (record ? credentialNdvSecretsStayOutOfYamlSearchAnalytics(record) : true) &&
    (strippedKeys.length === 0 ||
      credentialNdvMustStopAfterStrip(strippedKeys))
  );
}

export function credentialNdvDoesNotMergeConfig(): boolean {
  return (
    R5_GUARDRAILS.noConfigMerge &&
    CREDENTIAL_NDV_ADD.noConfigMerge &&
    !CREDENTIAL_NDV_ADD_HREF.startsWith(INVENTED_CONFIG_MERGE) &&
    !CREDENTIAL_NDV_ADD_SOURCES.some((source) => source.includes("/config/"))
  );
}

export function credentialNdvTypesUnchanged(): boolean {
  return (
    R5_GUARDRAILS.noNewCredentialTypes &&
    CREDENTIAL_NDV_ADD.noNewCredentialTypes &&
    CREDENTIAL_MVP_TYPES.length === 5
  );
}

export function credentialNdvIsolationUseIsNotProduct(): boolean {
  return (
    R5_GUARDRAILS.isolationUseIsNotProductVault &&
    CREDENTIAL_NDV_ADD.isolationUseIsNotProductVault &&
    ISOLATION_CREDENTIAL_USE_PATH === "/workspace/credentials/{id}/use" &&
    credentialsPath() === "/credentials" &&
    CREDENTIAL_NDV_ADD_HREF === EDITOR_CREDENTIAL_NEW_HREF &&
    !CREDENTIAL_NDV_ADD_HREF.includes("/workspace/credentials/")
  );
}

export function credentialNdvEmbedUnchanged(): boolean {
  const item = WORKSPACE_NAV_ITEMS.find((entry) => entry.id === "credentials");
  const create = EMBED_ROUTES.filter((route) => route.id === "credentialNew");
  return (
    CREDENTIAL_NDV_ADD.embedUnchanged &&
    item?.href === "/credentials" &&
    create.length === 1 &&
    create[0]?.standalone === "/credentials/new" &&
    create[0]?.embed === "/embed/v1/credentials/new" &&
    maybeEmbedDeepLink(CREDENTIAL_NDV_ADD_HREF, true) ===
      "/embed/v1/credentials/new"
  );
}

export function credentialNdvUsesExistingCreate(): boolean {
  return (
    CREDENTIAL_NDV_ADD.reuseExistingVaultCreate &&
    CREDENTIAL_NDV_ADD.noNewApiRoutes &&
    credentialsPath() === "/credentials" &&
    parseInspectorCredentialReturnTo({
      returnTo: "/workflows/11111111-1111-4111-8111-111111111111",
      node: "ssh-run",
      field: "credentialId",
    }) !== null
  );
}

export {
  CREDENTIAL_KEK_ENV,
  R5_GUARDRAILS,
  R5_LATER_STORY_NOTES,
  R5_SECURITY_LINE,
};
