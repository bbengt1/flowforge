/**
 * R3.1: NDV type-specific `with` / parameter editors.
 *
 * Relates to #246 / Part of #229. Keep #246 open.
 *
 * Chloe UI only. Selected-node NDV presents typed parameter editors
 * (beyond a bare JSON blob) for cataloged core / Kubernetes / SSH /
 * script / HTTP nodes. Wizard remains guided add; NDV is edit.
 * Display-name credentials only. No SecretField. No expression
 * language. Invalid YAML still never guesses a graph.
 *
 * Deep field-path mapping is R3.2 / #247. Validation/policy is R3.3 /
 * #248. Catalog fallback removal is R3.4 / #249.
 */

import { isHttpConfigurableType } from "./core-http-notification-contract.ts";
import type { HttpNotificationCatalog } from "./core-http-notification-contract.ts";
import {
  EDITOR_INSPECTOR,
  inspectorShowsCoreWith,
  inspectorWithFields,
  isInspectorSecretSurfaceName,
} from "./editor-inspector.ts";
import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import { ndvInspectorIsEdit, ndvWizardStaysAdd } from "./editor-ndv.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";
import { isKubernetesConfigurableType } from "./kubernetes-node-contract.ts";
import {
  isDedicatedScriptIoWithField,
} from "./script-io-contract.ts";
import {
  isScriptConfigurableType,
  type ScriptNodeCatalog,
} from "./script-contract.ts";
import {
  isSshConfigurableType,
  type SshNodeCatalog,
} from "./ssh-node-contract.ts";
import { projectCanvasGraph } from "./workflow-graph.ts";
import { canShowSummary } from "./workflow.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";
import {
  wizardConfigFields,
  type WizardConfigField,
  type WizardFieldControl,
} from "./workflow-action-wizard.ts";
import { isCoreNeutralNodeType } from "./workflow-core-nodes.ts";
import type {
  WorkflowFieldError,
  WorkflowSummary,
} from "./workflow-types.ts";

export const R31_STORY = 246;
export const R31_EPIC = 229;
export const R31_KEEP_STORY_OPEN = true;

export const NDV_PARAMETER_FAMILIES = [
  "core",
  "kubernetes",
  "ssh",
  "script",
  "http",
] as const;

export type NdvCatalogedParameterFamily = (typeof NDV_PARAMETER_FAMILIES)[number];
export type NdvParameterFamily = NdvCatalogedParameterFamily | "unknown";

export const NDV_PARAMETER_CONTROLS = [
  "text",
  "textarea",
  "number",
  "enum",
  "boolean",
  "object-lines",
  "retry-policy",
  "resource-identity",
] as const;

export type NdvParameterControl = (typeof NDV_PARAMETER_CONTROLS)[number];

export const EDITOR_NDV_PARAMETERS = {
  wizardIsAdd: true,
  inspectorIsEdit: true,
  typeSpecificEditors: true,
  beyondBareJson: true,
  catalogedFamilies: NDV_PARAMETER_FAMILIES,
  displayNameCredentialsOnly: true,
  noSecretField: true,
  noExpressionLanguage: true,
  invalidYamlNeverGuessesGraph: true,
  noNewCredentialTypes: true,
  noAppsApiChanges: true,
  fieldPathMappingIsR32: true,
  validationPolicyIsR33: true,
  catalogFallbackRemovalIsR34: true,
  embedPathUnchanged: true,
  keep246Open: true,
} as const;

export const NDV_PARAMETER_RAIL_SOURCES = [
  "src/components/workflows/NodeInspector.tsx",
  "src/components/workflows/NdvParameterEditors.tsx",
  "src/components/workflows/EditorInspector.tsx",
] as const;

const SECRET_SURFACE_IN_SOURCE =
  /SecretField\b|type=["']password["']|rotateCredential|forgetSecretDraft/;
const EXPRESSION_LANGUAGE_IN_SOURCE =
  /\{\{|expression language|ExpressionEditor/i;
const BARE_JSON_PRIMARY =
  /control === ["']json["']|JSON\.stringify\(value\)/;

export type NdvParameterEditor = {
  name: string;
  label: string;
  required: boolean;
  advanced?: boolean;
  readOnly?: boolean;
  description: string;
  control: NdvParameterControl;
  enumValues?: string[];
  defaultValue?: unknown;
};

export type NdvParameterCatalogs = {
  engineCatalog?: KubernetesEngineCatalog | null;
  sshCatalog?: SshNodeCatalog | null;
  scriptCatalog?: ScriptNodeCatalog | null;
  httpCatalog?: HttpNotificationCatalog | null;
};

export function ndvParameterFamily(type: string): NdvParameterFamily {
  if (isCoreNeutralNodeType(type)) {
    return "core";
  }
  if (isKubernetesConfigurableType(type)) {
    return "kubernetes";
  }
  if (isSshConfigurableType(type)) {
    return "ssh";
  }
  if (isScriptConfigurableType(type)) {
    return "script";
  }
  if (isHttpConfigurableType(type)) {
    return "http";
  }
  return "unknown";
}

export function ndvHasTypeSpecificParameterEditors(type: string): boolean {
  return ndvParameterFamily(type) !== "unknown";
}

export function ndvParametersOwnedByCoreForm(type: string): boolean {
  return inspectorShowsCoreWith(type);
}

export function ndvParametersOwnedByScriptPanel(type: string): boolean {
  return isScriptConfigurableType(type);
}

export function ndvParameterFields(
  entry: ActionLibraryEntry | undefined,
  type: string,
  catalogs: NdvParameterCatalogs = {},
): WizardConfigField[] {
  const family = ndvParameterFamily(type);
  if (family === "unknown" || family === "core" || family === "script") {
    return [];
  }
  return inspectorWithFields(
    wizardConfigFields(
      entry,
      type,
      catalogs.engineCatalog,
      catalogs.sshCatalog,
      catalogs.scriptCatalog,
      catalogs.httpCatalog,
    ),
    type,
  ).filter((field) => !isDedicatedScriptIoWithField(field.name));
}

export function ndvParameterControl(
  field: Pick<
    WizardConfigField,
    "name" | "kind" | "control" | "enumValues" | "readOnly"
  >,
  family: NdvParameterFamily = "unknown",
): NdvParameterControl {
  if (field.name === "retryPolicy") {
    return "retry-policy";
  }
  if (field.name === "resource" && family === "kubernetes") {
    return "resource-identity";
  }
  if (field.control === "boolean" || field.kind === "boolean") {
    return "boolean";
  }
  if (field.control === "enum" || (field.enumValues && field.enumValues.length > 0)) {
    return "enum";
  }
  if (field.control === "number" || field.kind === "integer") {
    return "number";
  }
  if (field.control === "textarea") {
    return "textarea";
  }
  if (
    field.control === "object-lines" ||
    field.control === "json" ||
    field.kind === "object"
  ) {
    return "object-lines";
  }
  return "text";
}

export function ndvParameterEditors(
  fields: readonly WizardConfigField[],
  family: NdvParameterFamily,
): NdvParameterEditor[] {
  return fields
    .filter((field) => !isInspectorSecretSurfaceName(field.name))
    .map((field) => ({
      name: field.name,
      label: field.label || field.name,
      required: field.required,
      advanced: field.advanced,
      readOnly: field.readOnly,
      description: field.description,
      control: ndvParameterControl(field, family),
      enumValues: field.enumValues,
      defaultValue: field.defaultValue,
    }));
}

export function ndvPrimaryEditorIsBareJson(
  editors: readonly NdvParameterEditor[],
): boolean {
  return editors.some((editor) => editor.control === ("json" as NdvParameterControl));
}

export function ndvWizardRemainsAdd(): boolean {
  return (
    EDITOR_NDV_PARAMETERS.wizardIsAdd &&
    EDITOR_INSPECTOR.wizardIsAdd &&
    ndvWizardStaysAdd()
  );
}

export function ndvParametersAreEdit(): boolean {
  return (
    EDITOR_NDV_PARAMETERS.inspectorIsEdit &&
    EDITOR_INSPECTOR.inspectorIsEdit &&
    ndvInspectorIsEdit()
  );
}

export function ndvParametersEmbedUnchanged(): boolean {
  return (
    EDITOR_NDV_PARAMETERS.embedPathUnchanged && editorEmbedRouteUnchanged()
  );
}

export function formatNdvObjectLines(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => `${key}=${nested == null ? "" : String(nested)}`)
    .join("\n");
}

export function parseNdvObjectLines(text: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const cut = line.indexOf("=");
    if (cut <= 0) {
      continue;
    }
    const key = line.slice(0, cut).trim();
    if (!key || isInspectorSecretSurfaceName(key)) {
      continue;
    }
    next[key] = line.slice(cut + 1).trim();
  }
  return next;
}

export function parseNdvRetryPolicy(value: unknown): { maxAttempts: number } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as { maxAttempts?: unknown }).maxAttempts;
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return { maxAttempts: parsed };
    }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { maxAttempts: value };
  }
  return { maxAttempts: 0 };
}

export function parseNdvResourceIdentity(value: unknown): {
  kind: string;
  name: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "", name: "" };
  }
  const rec = value as { kind?: unknown; name?: unknown };
  return {
    kind: typeof rec.kind === "string" ? rec.kind : "",
    name: typeof rec.name === "string" ? rec.name : "",
  };
}

export function stringifyNdvScalar(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "object") {
    return "";
  }
  return String(value);
}

export function ndvParameterPatchValue(
  editor: Pick<NdvParameterEditor, "control" | "name">,
  raw: unknown,
): unknown {
  if (editor.control === "retry-policy") {
    return parseNdvRetryPolicy(raw);
  }
  if (editor.control === "resource-identity") {
    return parseNdvResourceIdentity(raw);
  }
  if (editor.control === "object-lines") {
    if (typeof raw === "string") {
      return parseNdvObjectLines(raw);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return parseNdvObjectLines(formatNdvObjectLines(raw));
    }
    return {};
  }
  if (editor.control === "number") {
    return typeof raw === "number" ? raw : Number(raw);
  }
  if (editor.control === "boolean") {
    return raw === true;
  }
  return raw;
}

/** Parameter edits never invent a canvas graph from invalid YAML. */
export function ndvParametersNeverGuessGraph(input: {
  errors: WorkflowFieldError[];
  summary: WorkflowSummary | null;
  yaml: string;
}): boolean {
  if (!canShowSummary(input.errors, input.summary)) {
    return (
      projectCanvasGraph({
        errors: input.errors,
        summary: input.summary,
        yaml: input.yaml,
      }) === null
    );
  }
  return true;
}

export function ndvParameterSourceForbidsSecretSurface(source: string): boolean {
  return !SECRET_SURFACE_IN_SOURCE.test(source);
}

export function ndvParameterSourceForbidsExpressionLanguage(
  source: string,
): boolean {
  return !EXPRESSION_LANGUAGE_IN_SOURCE.test(source);
}

export function ndvParameterSourceForbidsBareJsonPrimary(
  source: string,
): boolean {
  return !BARE_JSON_PRIMARY.test(source);
}

export function ndvParameterControlIsTyped(
  control: WizardFieldControl | NdvParameterControl,
): boolean {
  return control !== "json";
}
