/**
 * UX.7: pick or add a vault credential from the node inspector
 * without leaving the editor.
 *
 * Relates to #202 / Part of #195. Keep #202 open until merge.
 *
 * Chloe UI only. Reuses CredentialWizard, CredentialRefSelect, and
 * vault clients. Secret entry stays in the existing masked wizard
 * (modal or `/credentials/new` return-to-editor). The inspector rail
 * never gains a SecretField / plaintext / rotate surface. YAML, search,
 * and analytics stay display-name + UUID only.
 */

import { isSecretFieldName, stripSecretFields } from "./credential.ts";
import type { CredentialRecord, CredentialType } from "./credential-types.ts";
import { EMBED_ROUTES } from "./embed-contract.ts";
import { maybeEmbedDeepLink } from "./embed-tenancy-contract.ts";
import {
  INSPECTOR_RAIL_SOURCES,
  inspectorCredentialRefValue,
  inspectorSourceForbidsSecretSurface,
  isInspectorCredentialRefField,
  isInspectorSecretSurfaceName,
  sanitizeInspectorWithPatch,
} from "./editor-inspector.ts";
import {
  editorWorkflowIdFromPath,
  isWorkflowEditorPath,
} from "./editor-chrome.ts";
import { isValidNodeId, looksLikeSecretValue } from "./workflow-yaml-nodes.ts";

export const UX7_STORY = 202;
export const UX7_EPIC = 195;
export const UX7_KEEP_STORY_OPEN = true;

export const EDITOR_CREDENTIAL_VAULT_HREF = "/credentials";
export const EDITOR_CREDENTIAL_NEW_HREF = "/credentials/new";

export const RETURN_TO_PARAM = "returnTo";
export const RETURN_NODE_PARAM = "node";
export const RETURN_FIELD_PARAM = "field";
export const SELECT_CREDENTIAL_PARAM = "selectCredential";

export const EDITOR_CREDENTIAL = {
  pickFromGetCredentials: true,
  addOpensMaskedWizard: true,
  wizardIsModalOrReturnToEditor: true,
  createRotateSubmitOnceAndClear: true,
  unexpectedSecretKeysStripped: true,
  afterCreateSelectsDisplayName: true,
  yamlStoresUuidOnly: true,
  vaultHomeRemainsCredentials: true,
  noSecretsInYamlSearchOrAnalytics: true,
  displayNamePlusUuidOnly: true,
  noSecretFieldInRail: true,
  noPlaintextInRail: true,
  noRotateUiInRail: true,
  noAppsApiChanges: true,
} as const;

export const INSPECTOR_CREDENTIAL_RAIL_SOURCES = [
  ...INSPECTOR_RAIL_SOURCES,
  "src/components/config/CredentialRefSelect.tsx",
] as const;

export const INSPECTOR_CREDENTIAL_WIZARD_SOURCES = [
  "src/components/credentials/CredentialWizard.tsx",
  "src/components/credentials/CredentialWizardDialog.tsx",
  "src/components/credentials/SecretField.tsx",
] as const;

export type InspectorCredentialReturnTo = {
  editorPath: string;
  workflowId: string;
  nodeId: string;
  field: string;
};

export type InspectorCreatedCredential = {
  credentialId: string;
  nodeId: string;
  field: string;
};

export type InspectorAddCredentialRequest = {
  nodeId: string;
  field: string;
  allowedTypes?: readonly CredentialType[];
};

export type InspectorPendingCredential = Pick<
  CredentialRecord,
  "id" | "displayName" | "type"
>;

export function vaultHomeHref(embed = false): string {
  return maybeEmbedDeepLink(EDITOR_CREDENTIAL_VAULT_HREF, embed);
}

export function inspectorAddCredentialHref(
  input: InspectorCredentialReturnTo,
  embed = false,
): string {
  const params = new URLSearchParams();
  params.set(RETURN_TO_PARAM, input.editorPath);
  params.set(RETURN_NODE_PARAM, input.nodeId);
  params.set(RETURN_FIELD_PARAM, input.field);
  const href = `${EDITOR_CREDENTIAL_NEW_HREF}?${params.toString()}`;
  return maybeEmbedDeepLink(href, embed);
}

export function inspectorEditorReturnHref(
  input: InspectorCredentialReturnTo & { credentialId: string },
  embed = false,
): string {
  const params = new URLSearchParams();
  params.set(SELECT_CREDENTIAL_PARAM, input.credentialId);
  params.set(RETURN_NODE_PARAM, input.nodeId);
  params.set(RETURN_FIELD_PARAM, input.field);
  const href = `${input.editorPath}?${params.toString()}`;
  return maybeEmbedDeepLink(href, embed);
}

export function editorPathForWorkflow(
  workflowId: string,
  embed = false,
): string | null {
  const id = workflowId.trim();
  if (!id || looksLikeSecretValue(id)) {
    return null;
  }
  const path = `/workflows/${id}`;
  if (!isWorkflowEditorPath(path)) {
    return null;
  }
  return maybeEmbedDeepLink(path, embed);
}

export function parseInspectorCredentialReturnTo(
  input:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
): InspectorCredentialReturnTo | null {
  const editorPath = readSafeParam(input, RETURN_TO_PARAM);
  const nodeId = readSafeParam(input, RETURN_NODE_PARAM);
  const field = readSafeParam(input, RETURN_FIELD_PARAM);
  if (!editorPath || !nodeId || !field) {
    return null;
  }
  if (!isWorkflowEditorPath(editorPath) || !isValidNodeId(nodeId)) {
    return null;
  }
  if (!isInspectorCredentialRefField(field)) {
    return null;
  }
  const workflowId = editorWorkflowIdFromPath(editorPath);
  if (!workflowId) {
    return null;
  }
  return { editorPath, workflowId, nodeId, field };
}

export function parseInspectorCreatedCredential(
  input:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | string
    | null
    | undefined,
): InspectorCreatedCredential | null {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;
  const credentialId = inspectorCredentialRefValue(
    readSafeParam(search, SELECT_CREDENTIAL_PARAM),
  );
  const nodeId = readSafeParam(search, RETURN_NODE_PARAM);
  const field = readSafeParam(search, RETURN_FIELD_PARAM);
  if (!credentialId || !nodeId || !field) {
    return null;
  }
  if (!isValidNodeId(nodeId) || !isInspectorCredentialRefField(field)) {
    return null;
  }
  return { credentialId, nodeId, field };
}

export function createdCredentialSelectable(
  record: Pick<CredentialRecord, "id" | "displayName" | "type"> &
    Partial<Pick<CredentialRecord, "status">>,
  allowedTypes?: readonly CredentialType[],
): boolean {
  if (!record.id || !record.displayName.trim()) {
    return false;
  }
  if (inspectorCredentialRefValue(record.id) === null) {
    return false;
  }
  if (record.status && record.status !== "active") {
    return false;
  }
  if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(record.type)) {
    return false;
  }
  return true;
}

export function inspectorCreatedCredentialPatch(
  field: string,
  credentialId: string,
): Record<string, unknown> {
  return sanitizeInspectorWithPatch({ [field]: credentialId });
}

export function stripInspectorCredentialQuery(
  href: string,
): string {
  const cut = href.indexOf("?");
  const path = cut === -1 ? href : href.slice(0, cut);
  const hashCut = href.indexOf("#");
  const hash = hashCut === -1 ? "" : href.slice(hashCut);
  const search = cut === -1 ? "" : href.slice(cut + 1, hashCut === -1 ? undefined : hashCut);
  const params = new URLSearchParams(search);
  params.delete(SELECT_CREDENTIAL_PARAM);
  params.delete(RETURN_NODE_PARAM);
  params.delete(RETURN_FIELD_PARAM);
  const next = params.toString();
  return `${path}${next ? `?${next}` : ""}${hash}`;
}

export function inspectorCredentialQueryIsSecretFree(search: string): boolean {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  for (const [key, value] of params.entries()) {
    if (isSecretFieldName(key) || isInspectorSecretSurfaceName(key)) {
      return false;
    }
    if (looksLikeSecretValue(value)) {
      return false;
    }
  }
  return stripSecretFields(Object.fromEntries(params.entries())).strippedKeys
    .length === 0;
}

export function inspectorRailForbidsSecretSurface(source: string): boolean {
  return inspectorSourceForbidsSecretSurface(source) && !source.includes("SecretField");
}

export function credentialEmbedRoutesUnchanged(): boolean {
  const vault = EMBED_ROUTES.find((route) => route.id === "credentials");
  const create = EMBED_ROUTES.find((route) => route.id === "credentialNew");
  return (
    vault?.standalone === EDITOR_CREDENTIAL_VAULT_HREF &&
    vault.embed === "/embed/v1/credentials" &&
    create?.standalone === EDITOR_CREDENTIAL_NEW_HREF &&
    create.embed === "/embed/v1/credentials/new"
  );
}

function readSafeParam(
  input:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
  key: string,
): string {
  if (!input) {
    return "";
  }
  const raw =
    input instanceof URLSearchParams
      ? input.get(key)
      : Array.isArray(input[key])
        ? input[key]?.[0]
        : input[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || isSecretFieldName(key) || looksLikeSecretValue(value)) {
    return "";
  }
  return value;
}
