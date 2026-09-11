/**
 * E6.3 action wizard: recommend enabled types, authorize target /
 * credential selectors, configure safe defaults, map ports, preview
 * policy + redacted YAML, then insert a canonical graph node.
 *
 * HTTP / notification `allowedWith` comes from GET /workflows/catalog
 * + GET /http/catalog / ops-config `httpNotificationEngine` (`e104-#118`).
 * The wizard never invents free-form URL, header, recipient, or
 * credential fields and does not offer an integration-gate toggle.
 */

import {
  canDispatchFromEvaluation,
  policyDecisionLabel,
} from "./approval.ts";
import {
  allowedNamespacesFromPinSpec,
  defaultKubernetesWith,
  isKubernetesConfigurableType,
  overlayKubernetesFields,
  stripKubernetesForbiddenWith,
  validateKubernetesNodeConfig,
  waitReadyMessage,
  type KubernetesNodeWithField,
} from "./kubernetes-node-contract.ts";
import { isKubernetesRolloutType, rolloutKindsFromCatalog } from "./kubernetes-rollout-contract.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";
import {
  defaultSshWith,
  isExposedSshWithField,
  isSshConfigurableType,
  overlaySshFields,
  stripSshForbiddenWith,
  validateSshNodeConfig,
  type SshNodeCatalog,
  type SshNodeConfigContext,
  type SshNodeWithField,
} from "./ssh-node-contract.ts";
import {
  defaultScriptWith,
  isExposedScriptWithField,
  isScriptConfigurableType,
  overlayScriptFields,
  stripScriptForbiddenWith,
  validateScriptNodeConfig,
  type ScriptNodeCatalog,
  type ScriptNodeConfigContext,
  type ScriptNodeWithField,
} from "./script-contract.ts";
import {
  defaultHttpNotificationWith,
  isExposedHttpNotificationField,
  isHttpConfigurableType,
  overlayHttpNotificationFields,
  stripHttpNotificationForbiddenWith,
  validateHttpNotificationConfig,
  type HttpNotificationCatalog,
  type HttpNotificationConfigContext,
  type HttpNotificationWithField,
} from "./core-http-notification-contract.ts";
import type { PolicyEvaluation } from "./approval-types.ts";
import { parseScriptEvaluateRetry } from "./script-io-contract.ts";
import { parseSshEvaluateRetry } from "./ssh-retry-contract.ts";
import type { CredentialRecord, CredentialType } from "./credential-types.ts";
import { isSecretFieldName } from "./credential.ts";
import { authorizedSelectorOptions, pinFromSummary } from "./ops-config.ts";
import type { OpsConfigKind, OpsConfigPin, OpsConfigSummary } from "./ops-config-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  ACTION_FAMILY_ORDER,
  actionFamilyForType,
  filterActionLibrary,
  rejectDisabledActionType,
  type ActionFamily,
  type ActionLibraryEntry,
} from "./workflow-action-library.ts";
import {
  isCoreNeutralNodeType,
  type CoreNeutralNodeType,
} from "./workflow-core-nodes.ts";
import { portsCompatible } from "./workflow-graph.ts";
import type {
  CatalogPort,
  CatalogWithField,
  WorkflowCatalog,
} from "./workflow-types.ts";
import {
  defaultCoreWith,
  insertCatalogNode,
  insertYamlEdge,
  isForbiddenYamlKey,
  looksLikeSecretValue,
  serializeNodeBlock,
  updateYamlNode,
  type YamlWorkflowNode,
} from "./workflow-yaml-nodes.ts";

export const ACTION_WIZARD_STEPS = [
  "type",
  "target",
  "configure",
  "connect",
  "review",
] as const;

export type ActionWizardStep = (typeof ACTION_WIZARD_STEPS)[number];

export type WizardFeedback = "idle" | "pending" | "success" | "error";

export type WizardPortMapping = {
  from: string;
  toPort: string;
};

export type ActionWizardDraft = {
  type: string;
  name: string;
  with: Record<string, unknown>;
  credentialId: string;
  credentialDisplayName: string;
  mappings: WizardPortMapping[];
};

export type WizardFieldControl =
  | "text"
  | "textarea"
  | "number"
  | "enum"
  | "uuid"
  | "boolean"
  | "object-lines"
  | "json";

export type WizardConfigField = {
  name: string;
  kind: string;
  required: boolean;
  control: WizardFieldControl;
  enumValues?: string[];
  description: string;
  defaultValue: unknown;
  selectorKind?: OpsConfigKind;
  inferred: boolean;
  label?: string;
  advanced?: boolean;
  readOnly?: boolean;
};

export type WizardValidationContext = {
  allowedNamespaces?: readonly string[];
  targetSelectorClosed?: boolean;
  engineCatalog?: KubernetesEngineCatalog | null;
  sshCatalog?: SshNodeCatalog | null;
  sshTargetSelectorClosed?: boolean;
  commandProfileSelectorClosed?: boolean;
  parameterConstraints?: SshNodeConfigContext["parameterConstraints"];
  profileRetrySafe?: boolean;
  verificationDeclared?: boolean;
  scriptCatalog?: ScriptNodeCatalog | null;
  runtimeProfileSelectorClosed?: boolean;
  runtimeProfileLanguage?: ScriptNodeConfigContext["profileLanguage"];
  httpCatalog?: HttpNotificationCatalog | null;
  connectionSelectorClosed?: boolean;
  recipientSelectorClosed?: boolean;
  templateSelectorClosed?: boolean;
  schemaSelectorClosed?: boolean;
  connectionType?: HttpNotificationConfigContext["connectionType"];
  endpointPolicy?: HttpNotificationConfigContext["endpointPolicy"];
};

export type WizardRecommendation = {
  type: string;
  score: number;
  reasons: string[];
};

export type AuthorizedCredentialOption = {
  id: string;
  displayName: string;
  type: CredentialType;
  status: string;
};

export type AuthorizedSelectorResult<T> = {
  options: T[];
  closed: boolean;
  reason: string | null;
};

export type WizardPolicyPreview = {
  permissions: string[];
  retryHint: string;
  sideEffects: boolean;
  approvalHint: string;
  catalogSource: "catalog" | "inferred";
  evaluationDecision?: string;
  evaluationApprovalRequired: boolean;
  dispatchAllowed: boolean;
};

export type WizardValidation = {
  ok: boolean;
  errors: string[];
};

export type WizardInsertResult = {
  yaml: string;
  node: { id: string; type: string; name: string };
  errors: string[];
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_TO_WITH: Record<string, string> = {
  cluster_target: "clusterTargetId",
  ssh_target: "sshTargetId",
  command_profile: "commandProfileId",
  runtime_profile: "runtimeProfileId",
  connection: "connectionId",
  recipient_list: "recipientListId",
  message_template: "templateId",
  response_schema: "responseSchemaRef",
};

export function emptyActionWizardDraft(
  type = "",
  name = "",
): ActionWizardDraft {
  return {
    type,
    name,
    with: type ? defaultWithForType(type) : {},
    credentialId: "",
    credentialDisplayName: "",
    mappings: [],
  };
}

export function isActionWizardStep(value: string): value is ActionWizardStep {
  return (ACTION_WIZARD_STEPS as readonly string[]).includes(value);
}

export function nextWizardStep(step: ActionWizardStep): ActionWizardStep {
  const index = ACTION_WIZARD_STEPS.indexOf(step);
  return ACTION_WIZARD_STEPS[Math.min(index + 1, ACTION_WIZARD_STEPS.length - 1)] ?? "review";
}

export function prevWizardStep(step: ActionWizardStep): ActionWizardStep {
  const index = ACTION_WIZARD_STEPS.indexOf(step);
  return ACTION_WIZARD_STEPS[Math.max(index - 1, 0)] ?? "type";
}

export function credentialTypesForAction(type: string): CredentialType[] {
  const family = actionFamilyForType(type);
  if (family === "kubernetes") {
    return ["kubernetes"];
  }
  if (family === "ssh") {
    return ["ssh_private_key"];
  }
  if (family === "http") {
    return ["token", "provider"];
  }
  if (family === "notification") {
    return ["webhook_secret", "token", "provider"];
  }
  return [];
}

export function opsConfigKindsForAction(type: string): OpsConfigKind[] {
  const family = actionFamilyForType(type);
  if (family === "kubernetes") {
    return ["cluster_target"];
  }
  if (family === "ssh") {
    return ["ssh_target", "command_profile"];
  }
  if (family === "script") {
    return ["runtime_profile"];
  }
  if (family === "http") {
    return ["connection", "response_schema"];
  }
  if (family === "notification") {
    if (type === "notification.email") {
      return ["connection", "recipient_list", "message_template"];
    }
    return ["connection"];
  }
  return [];
}

export function withFieldForKind(kind: OpsConfigKind): string | null {
  return KIND_TO_WITH[kind] ?? null;
}

export function defaultWithForType(type: string): Record<string, unknown> {
  if (isCoreNeutralNodeType(type)) {
    return defaultCoreWith(type);
  }
  if (isKubernetesConfigurableType(type)) {
    return defaultKubernetesWith(type);
  }
  if (isSshConfigurableType(type)) {
    return defaultSshWith(type);
  }
  if (isScriptConfigurableType(type)) {
    return defaultScriptWith(type);
  }
  if (isHttpConfigurableType(type)) {
    return defaultHttpNotificationWith(type);
  }
  switch (type) {
    case "flow.approval":
      return { expiresIn: "PT30M" };
    default:
      return {};
  }
}

/**
 * Prefer catalog `allowedWith`. K8s / SSH / script / HTTP fail closed
 * when live catalogs omit fields — no invented toggles or config
 * fields (R3.4 / #249). Core types may still infer from YAML schema.
 */
export function wizardConfigFields(
  entry: ActionLibraryEntry | undefined,
  type = entry?.type ?? "",
  engineCatalog?: KubernetesEngineCatalog | null,
  sshCatalog?: SshNodeCatalog | null,
  scriptCatalog?: ScriptNodeCatalog | null,
  httpCatalog?: HttpNotificationCatalog | null,
): WizardConfigField[] {
  if (isHttpConfigurableType(type)) {
    const engineFields = httpCatalog?.nodes.find((item) => item.type === type)
      ?.allowedWith;
    const catalogOwnsFields =
      (engineFields && engineFields.length > 0) ||
      (entry?.source === "catalog" && (entry.allowedWith?.length ?? 0) > 0);
    if (catalogOwnsFields) {
      return overlayHttpNotificationFields(
        engineFields?.length ? engineFields : (entry?.allowedWith ?? []),
        type,
      )
        .filter((field) => isExposedHttpNotificationField(field.name))
        .map((field) => fromHttpNotificationWithField(field, false));
    }
    return [];
  }
  if (isScriptConfigurableType(type)) {
    const engineFields = scriptCatalog?.nodes.find((item) => item.type === type)
      ?.allowedWith;
    const catalogOwnsFields =
      (engineFields && engineFields.length > 0) ||
      (entry?.source === "catalog" && (entry.allowedWith?.length ?? 0) > 0);
    if (catalogOwnsFields) {
      return overlayScriptFields(
        engineFields?.length ? engineFields : (entry?.allowedWith ?? []),
        type,
      )
        .filter((field) => isExposedScriptWithField(field.name))
        .map((field) => fromScriptWithField(field, false));
    }
    return [];
  }
  if (isSshConfigurableType(type)) {
    const engineFields = sshCatalog?.nodes.find((item) => item.type === type)
      ?.allowedWith;
    const catalogOwnsFields =
      (engineFields && engineFields.length > 0) ||
      (entry?.source === "catalog" && (entry.allowedWith?.length ?? 0) > 0);
    if (catalogOwnsFields) {
      return overlaySshFields(
        engineFields?.length ? engineFields : (entry?.allowedWith ?? []),
        type,
      )
        .filter((field) => isExposedSshWithField(field.name))
        .map((field) => fromSshWithField(field, false));
    }
    return [];
  }
  if (isKubernetesConfigurableType(type)) {
    const engineFields = engineCatalog?.nodes.find((item) => item.type === type)
      ?.allowedWith;
    const catalogOwnsFields =
      (engineFields && engineFields.length > 0) ||
      (entry?.source === "catalog" && (entry.allowedWith?.length ?? 0) > 0);
    if (catalogOwnsFields) {
      return overlayKubernetesFields(
        engineFields?.length ? engineFields : (entry?.allowedWith ?? []),
        type,
        isKubernetesRolloutType(type)
          ? rolloutKindsFromCatalog(engineCatalog)
          : engineCatalog?.allowedKinds,
        waitReadyMessage(engineCatalog),
      )
        .filter((field) => isExposedKubernetesField(field.name))
        .map((field) => fromKubernetesWithField(field, false));
    }
    return [];
  }
  const catalogFields = (entry?.allowedWith ?? []).map((field) =>
    fromCatalogWithField(field),
  );
  if (catalogFields.length > 0) {
    return catalogFields;
  }
  return inferredFieldsForType(type, entry?.requiredWith ?? []);
}

export function wizardNeedsTargetStep(type: string): boolean {
  return (
    opsConfigKindsForAction(type).length > 0 ||
    credentialTypesForAction(type).length > 0
  );
}

export function authorizedCredentialOptions(input: {
  items?: CredentialRecord[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
  allowedTypes?: readonly CredentialType[];
}): AuthorizedSelectorResult<AuthorizedCredentialOption> {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: credentialFailClosedReason(input.problem, input.statusCode),
    };
  }
  const allowed = new Set(input.allowedTypes ?? []);
  const options: AuthorizedCredentialOption[] = [];
  for (const item of input.items ?? []) {
    if (!item?.id || !item.displayName) {
      continue;
    }
    if (item.status && item.status !== "active") {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(item.type)) {
      continue;
    }
    options.push({
      id: item.id,
      displayName: item.displayName,
      type: item.type,
      status: item.status,
    });
  }
  if (options.length === 0) {
    return {
      options: [],
      closed: true,
      reason:
        allowed.size > 0
          ? "No authorized credentials of the required type for this workspace."
          : "No server-authorized credentials for this workspace.",
    };
  }
  return { options, closed: false, reason: null };
}

export function publishedPinsFromList(input: {
  items?: OpsConfigSummary[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): AuthorizedSelectorResult<OpsConfigPin> {
  const pins = (input.items ?? [])
    .map(pinFromSummary)
    .filter((item): item is OpsConfigPin => item !== null);
  return authorizedSelectorOptions({
    items: pins,
    problem: input.problem,
    statusCode: input.statusCode,
  });
}

export function recommendActions(input: {
  entries: ActionLibraryEntry[];
  query?: string;
  upstream?: { type: string; port: CatalogPort } | null;
  permissions?: readonly string[] | null;
  enabledTargetKinds?: readonly OpsConfigKind[];
}): { recommended: WizardRecommendation[]; visible: ActionLibraryEntry[] } {
  const visible = filterActionLibrary(
    input.entries.filter((entry) => entry.placeable && entry.enabled),
    input.query ?? "",
  );
  const recommended = visible
    .map((entry) => scoreRecommendation(entry, input))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.type.localeCompare(right.type);
    })
    .slice(0, 6);
  return { recommended, visible };
}

export function groupEntriesByFamily(
  entries: ActionLibraryEntry[],
): { family: ActionFamily; label: string; items: ActionLibraryEntry[] }[] {
  return ACTION_FAMILY_ORDER.map((family) => ({
    family,
    label: familyLabel(family),
    items: entries.filter((entry) => entry.family === family),
  })).filter((group) => group.items.length > 0);
}

export function compatibleUpstreamOutputs(
  nodes: YamlWorkflowNode[],
  catalog: WorkflowCatalog | null | undefined,
  palette: ActionLibraryEntry[],
  inputPort: CatalogPort | undefined,
): { from: string; nodeName: string; port: CatalogPort }[] {
  if (!inputPort) {
    return [];
  }
  const out: { from: string; nodeName: string; port: CatalogPort }[] = [];
  for (const node of nodes) {
    const entry = palette.find((item) => item.type === node.type);
    const outputs =
      entry?.outputs ??
      catalog?.nodes.find((item) => item.type === node.type)?.outputs ??
      [];
    for (const port of outputs) {
      if (portsCompatible(port, inputPort)) {
        out.push({
          from: `${node.id}.${port.name}`,
          nodeName: node.name || node.id,
          port,
        });
      }
    }
  }
  return out;
}

export function redactWizardValue(value: unknown): unknown {
  return redactLeaves(value);
}

export function redactedYamlPreview(draft: ActionWizardDraft, nodeId = "preview"): string {
  const withValue = redactWizardValue(draft.with) as Record<string, unknown>;
  return serializeNodeBlock(
    {
      id: nodeId,
      type: draft.type || "unknown",
      name: draft.name.trim() || draft.type || "Action",
      with: withValue ?? {},
    },
    4,
  );
}

export function wizardPolicyPreview(input: {
  entry?: ActionLibraryEntry;
  evaluation?: PolicyEvaluation | null;
}): WizardPolicyPreview {
  const policy = input.entry?.policy ?? null;
  const inferred = !input.entry?.policy;
  const retrySafe = policy?.retrySafe === true;
  const attempts = policy?.defaultMaxAttempts ?? 1;
  const evaluation = input.evaluation ?? null;
  const sshEval = parseSshEvaluateRetry(evaluation);
  const scriptEval = parseScriptEvaluateRetry(evaluation);
  const evalRetry = sshEval[0] ?? scriptEval[0];
  const approvalRequired =
    evaluation?.decision === "approval-required" ||
    (evaluation?.requirements.length ?? 0) > 0;
  const catalogRetryHint = retrySafe
    ? `Retry-safe · default max attempts ${attempts}.`
    : "Not retry-safe. Default automatic retries are zero; an uncertain remote outcome is indeterminate.";
  const evaluateRetryHint = evalRetry
    ? ` Evaluate retryAllowed=${String(evalRetry.retryAllowed)} retrySafe=${String(evalRetry.retrySafe)} verificationDeclared=${String(evalRetry.verificationDeclared)} retryMaxAttempts=${evalRetry.retryMaxAttempts}.`
    : "";
  return {
    permissions: policy?.permissions ?? ["workflow.execute"],
    retryHint: `${catalogRetryHint}${evaluateRetryHint}`,
    sideEffects: policy?.sideEffects === true,
    approvalHint: approvalRequired
      ? "Server evaluation requires a current approval before dispatch."
      : policy?.sideEffects
        ? "Side-effecting action. Publish-time policy may require approval."
        : "No catalog-level approval flag. Server evaluate remains authoritative.",
    catalogSource: inferred ? "inferred" : "catalog",
    evaluationDecision: evaluation ? policyDecisionLabel(evaluation.decision) : undefined,
    evaluationApprovalRequired: approvalRequired,
    dispatchAllowed: canDispatchFromEvaluation(evaluation),
  };
}

export function validateWizardDraft(
  draft: ActionWizardDraft,
  catalog: WorkflowCatalog | null | undefined,
  entry?: ActionLibraryEntry,
  context: WizardValidationContext = {},
): WizardValidation {
  const errors: string[] = [];
  if (!draft.type.trim()) {
    errors.push("Choose an action type.");
    return { ok: false, errors };
  }
  const rejected = rejectDisabledActionType(draft.type, catalog);
  if (!rejected.ok) {
    errors.push(rejected.reason);
  }
  if (isForbiddenYamlKey(draft.name) || looksLikeSecretValue(draft.name)) {
    errors.push("Action name must not contain secret material.");
  }
  const fields = wizardConfigFields(
    entry,
    draft.type,
    context.engineCatalog,
    context.sshCatalog,
    context.scriptCatalog,
    context.httpCatalog,
  );
  for (const field of fields) {
    const value = draft.with[field.name];
    if (
      field.required &&
      isEmptyWithValue(value) &&
      !isKubernetesConfigurableType(draft.type) &&
      !isSshConfigurableType(draft.type) &&
      !isScriptConfigurableType(draft.type) &&
      !isHttpConfigurableType(draft.type)
    ) {
      errors.push(`${field.name} is required.`);
    }
    if (field.control === "uuid" && typeof value === "string" && value && !UUID.test(value)) {
      errors.push(`${field.name} must be a workspace UUID.`);
    }
    if (isForbiddenYamlKey(field.name)) {
      errors.push(`${field.name} is not allowed in YAML.`);
    }
    if (
      typeof value === "string" &&
      field.name !== "manifests" &&
      looksLikeSecretValue(value)
    ) {
      errors.push(`${field.name} looks like secret material and cannot be stored in YAML.`);
    }
  }
  if (isKubernetesConfigurableType(draft.type)) {
    errors.push(
      ...validateKubernetesNodeConfig(draft.type, draft.with, {
        allowedNamespaces: context.allowedNamespaces,
        targetSelectorClosed: context.targetSelectorClosed,
        engineCatalog: context.engineCatalog,
      }),
    );
  }
  if (isSshConfigurableType(draft.type)) {
    errors.push(
      ...validateSshNodeConfig(draft.type, draft.with, {
        targetSelectorClosed: context.sshTargetSelectorClosed,
        profileSelectorClosed: context.commandProfileSelectorClosed,
        parameterConstraints: context.parameterConstraints,
        profileRetrySafe: context.profileRetrySafe,
        verificationDeclared: context.verificationDeclared,
        sshCatalog: context.sshCatalog,
      }),
    );
  }
  if (isScriptConfigurableType(draft.type)) {
    errors.push(
      ...validateScriptNodeConfig(draft.type, draft.with, {
        profileSelectorClosed: context.runtimeProfileSelectorClosed,
        profileLanguage: context.runtimeProfileLanguage,
        scriptCatalog: context.scriptCatalog,
      }),
    );
  }
  if (isHttpConfigurableType(draft.type)) {
    errors.push(
      ...validateHttpNotificationConfig(draft.type, draft.with, {
        connectionSelectorClosed: context.connectionSelectorClosed,
        recipientSelectorClosed: context.recipientSelectorClosed,
        templateSelectorClosed: context.templateSelectorClosed,
        schemaSelectorClosed: context.schemaSelectorClosed,
        connectionType: context.connectionType,
        endpointPolicy: context.endpointPolicy,
        httpCatalog: context.httpCatalog,
        workflowCatalog: catalog,
      }),
    );
  }
  if (draft.credentialId && !UUID.test(draft.credentialId)) {
    errors.push("Credential reference must be a workspace UUID.");
  }
  for (const mapping of draft.mappings) {
    if (!mapping.from || !mapping.toPort) {
      errors.push("Each data mapping needs an upstream output and an input port.");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function applyWizardToYaml(
  yaml: string,
  draft: ActionWizardDraft,
  catalog: WorkflowCatalog | null | undefined,
  entry?: ActionLibraryEntry,
  context: WizardValidationContext = {},
): WizardInsertResult {
  const validation = validateWizardDraft(draft, catalog, entry, context);
  if (!validation.ok) {
    return { yaml, node: { id: "", type: draft.type, name: draft.name }, errors: validation.errors };
  }
  const inserted = insertCatalogNode(yaml, draft.type, {
    name: draft.name.trim() || entry?.name || draft.type,
  });
  const withValue = sanitizeWizardWith(
    {
      ...defaultWithForType(draft.type),
      ...draft.with,
    },
    draft.type,
  );
  const updated =
    updateYamlNode(inserted.yaml, {
      id: inserted.node.id,
      type: draft.type,
      name: draft.name.trim() || inserted.node.name,
      with: withValue,
    }) ?? inserted.yaml;
  let next = updated;
  const edgeErrors: string[] = [];
  for (const mapping of draft.mappings) {
    const from = mapping.from.trim();
    const to = `${inserted.node.id}.${mapping.toPort.trim()}`;
    if (!from || !mapping.toPort.trim()) {
      continue;
    }
    if (from.split(".")[0] === inserted.node.id) {
      edgeErrors.push("An action cannot map its own output onto itself.");
      continue;
    }
    next = insertYamlEdge(next, from, to);
  }
  return {
    yaml: next,
    node: {
      id: inserted.node.id,
      type: draft.type,
      name: draft.name.trim() || inserted.node.name,
    },
    errors: edgeErrors,
  };
}

export function sanitizeWizardWith(
  value: Record<string, unknown>,
  type = "",
): Record<string, unknown> {
  const source = isKubernetesConfigurableType(type)
    ? stripKubernetesForbiddenWith(value)
    : isSshConfigurableType(type)
      ? stripSshForbiddenWith(value)
      : isScriptConfigurableType(type)
        ? stripScriptForbiddenWith(value)
        : isHttpConfigurableType(type)
          ? stripHttpNotificationForbiddenWith(value)
          : value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!key.trim() || isForbiddenYamlKey(key) || isSecretFieldName(key)) {
      continue;
    }
    if (isEmptyWithValue(raw)) {
      continue;
    }
    if (typeof raw === "string" && looksLikeSecretValue(raw)) {
      continue;
    }
    if (
      key === "parameters" &&
      isSshConfigurableType(type) &&
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw)
    ) {
      const nested: Record<string, unknown> = {};
      for (const [param, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!param.trim() || isForbiddenYamlKey(param) || isSecretFieldName(param)) {
          continue;
        }
        if (typeof value === "string" && looksLikeSecretValue(value)) {
          continue;
        }
        nested[param] = value;
      }
      if (Object.keys(nested).length === 0) {
        continue;
      }
      out[key] = nested;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function applyTargetPin(
  draft: ActionWizardDraft,
  kind: OpsConfigKind,
  pin: OpsConfigPin | null,
): ActionWizardDraft {
  const field = withFieldForKind(kind);
  if (!field) {
    return draft;
  }
  const nextWith = { ...draft.with };
  if (!pin) {
    delete nextWith[field];
    return { ...draft, with: nextWith };
  }
  nextWith[field] = pin.resourceId;
  return { ...draft, with: nextWith };
}

export function applyCredentialRef(
  draft: ActionWizardDraft,
  credential: AuthorizedCredentialOption | null,
): ActionWizardDraft {
  return {
    ...draft,
    credentialId: credential?.id ?? "",
    credentialDisplayName: credential?.displayName ?? "",
  };
}

export function secretFreeDraftSnapshot(draft: ActionWizardDraft): ActionWizardDraft {
  return {
    type: draft.type,
    name: draft.name,
    with: sanitizeWizardWith(draft.with, draft.type),
    credentialId: draft.credentialId,
    credentialDisplayName: draft.credentialDisplayName,
    mappings: draft.mappings.map((item) => ({
      from: item.from,
      toPort: item.toPort,
    })),
  };
}

export function feedbackLabel(feedback: WizardFeedback): string {
  switch (feedback) {
    case "pending":
      return "Adding action…";
    case "success":
      return "Action added to the canvas and YAML.";
    case "error":
      return "Action was not added. See validation and try again.";
    default:
      return "";
  }
}

export function namespacesForWizardTarget(
  pin: { spec?: { allowedNamespaces?: unknown; policy?: unknown } } | null | undefined,
): string[] {
  return allowedNamespacesFromPinSpec(pin?.spec);
}

function isExposedKubernetesField(name: string): boolean {
  return name !== "force" && name !== "kubeconfig" && name !== "server";
}

function fromSshWithField(
  field: SshNodeWithField,
  inferred: boolean,
): WizardConfigField {
  return {
    name: field.name,
    kind: field.kind,
    required: field.required === true,
    control: field.controlHint,
    enumValues: field.enum,
    description: field.description ?? "",
    defaultValue: field.defaultValue ?? "",
    selectorKind: selectorKindForField(field.name),
    inferred,
    label: field.label,
    advanced: field.advanced,
    readOnly: field.readOnly,
  };
}

function fromHttpNotificationWithField(
  field: HttpNotificationWithField,
  inferred: boolean,
): WizardConfigField {
  return {
    name: field.name,
    kind: field.kind,
    required: field.required === true,
    control: field.controlHint,
    enumValues: field.enum,
    description: field.description ?? "",
    defaultValue: field.defaultValue ?? "",
    selectorKind: selectorKindForField(field.name),
    inferred,
    label: field.label,
    advanced: field.advanced,
    readOnly: field.readOnly,
  };
}

function fromScriptWithField(
  field: ScriptNodeWithField,
  inferred: boolean,
): WizardConfigField {
  return {
    name: field.name,
    kind: field.kind,
    required: field.required === true,
    control: field.controlHint,
    enumValues: field.enum,
    description: field.description ?? "",
    defaultValue: field.defaultValue ?? "",
    selectorKind: selectorKindForField(field.name),
    inferred,
    label: field.label,
    advanced: field.advanced,
    readOnly: field.readOnly,
  };
}

function fromKubernetesWithField(
  field: KubernetesNodeWithField,
  inferred: boolean,
): WizardConfigField {
  return {
    name: field.name,
    kind: field.kind,
    required: field.required === true,
    control: field.controlHint,
    enumValues: field.enum,
    description: field.description ?? "",
    defaultValue: field.defaultValue ?? "",
    selectorKind: selectorKindForField(field.name),
    inferred,
    label: field.label,
    advanced: field.advanced,
    readOnly: field.readOnly,
  };
}

function fromCatalogWithField(field: CatalogWithField): WizardConfigField {
  return {
    name: field.name,
    kind: field.kind,
    required: field.required === true,
    control: controlForKind(field.kind, field.enum),
    enumValues: field.enum,
    description: field.description ?? "",
    defaultValue: field.enum?.[0] ?? "",
    selectorKind: selectorKindForField(field.name),
    inferred: false,
  };
}

function inferredFieldsForType(type: string, requiredWith: string[]): WizardConfigField[] {
  const required = new Set(requiredWith);
  const field = (
    name: string,
    kind: string,
    control: WizardFieldControl,
    options: Partial<WizardConfigField> = {},
  ): WizardConfigField => ({
    name,
    kind,
    required: required.has(name) || options.required === true,
    control,
    enumValues: options.enumValues,
    description: options.description ?? "",
    defaultValue: options.defaultValue ?? defaultWithForType(type)[name] ?? "",
    selectorKind: options.selectorKind ?? selectorKindForField(name),
    inferred: true,
  });

  if (type.startsWith("kubernetes.")) {
    const fields = [
      field("clusterTargetId", "uuid", "uuid", {
        required: true,
        selectorKind: "cluster_target",
        description: "Published cluster target UUID.",
      }),
      field("namespace", "string", "text", {
        required: true,
        description: "Allowed namespace on the selected target.",
      }),
      field("dryRun", "string", "enum", {
        enumValues: ["server", "client"],
        defaultValue: "server",
        description: "Server-side dry-run is required before apply.",
      }),
      field("wait", "string", "enum", {
        enumValues: ["none", "ready"],
        defaultValue: type === "kubernetes.rolloutStatus" ? "ready" : "none",
      }),
      field("timeoutSeconds", "integer", "number", {
        defaultValue: 60,
        description: "Bounded timeout (1–3600). Default 60.",
      }),
      {
        ...field("fieldManager", "enum", "text", {
          enumValues: ["flowforge"],
          defaultValue: "flowforge",
          description: "Service-owned. Fixed to flowforge. Force is false.",
        }),
        readOnly: true,
        advanced: true,
      },
      field("policyId", "uuid", "uuid", {
        description: "Optional published kubernetes policy UUID.",
      }),
    ];
    if (type === "kubernetes.apply") {
      fields.push(
        field("manifests", "string", "textarea", {
          description: "Approved manifest. No Secret data or cluster-scoped objects.",
        }),
      );
    } else {
      fields.push(field("kind", "string", "text", { required: true }));
    }
    if (type === "kubernetes.get" || type === "kubernetes.rolloutStatus") {
      fields.push(field("name", "string", "text", { required: true }));
    }
    return fields;
  }
  if (type === "ssh.run") {
    return [
      field("sshTargetId", "uuid", "uuid", {
        required: true,
        selectorKind: "ssh_target",
      }),
      field("commandProfileId", "uuid", "uuid", {
        required: true,
        selectorKind: "command_profile",
      }),
      field("timeoutSeconds", "integer", "number", { defaultValue: 60 }),
      field("parameters", "object", "object-lines", {
        description: "Typed profile parameters as key=value lines. No raw shell.",
      }),
    ];
  }
  if (type === "script.python" || type === "script.go") {
    return [
      field("runtimeProfileId", "uuid", "uuid", {
        required: true,
        selectorKind: "runtime_profile",
      }),
      field("source", "string", "textarea", { required: true }),
      field("entrypoint", "string", "text", {
        required: true,
        defaultValue: type === "script.go" ? "main.go" : "main.py",
      }),
      field("timeoutSeconds", "integer", "number", { defaultValue: 30 }),
      field("memoryMiB", "integer", "number", { defaultValue: 128 }),
    ];
  }
  if (type === "http.request" || type === "notification.email" || type === "notification.webhook") {
    return [];
  }
  if (type === "flow.approval") {
    return [
      field("approverRole", "string", "text", { required: true }),
      field("expiresIn", "string", "text", { defaultValue: "PT30M" }),
    ];
  }
  if (isCoreNeutralNodeType(type)) {
    return inferredCoreFields(type, required);
  }
  return requiredWith.map((name) =>
    field(name, "string", name.toLowerCase().includes("id") ? "uuid" : "text", {
      required: true,
    }),
  );
}

function inferredCoreFields(
  type: CoreNeutralNodeType,
  required: Set<string>,
): WizardConfigField[] {
  const field = (
    name: string,
    kind: string,
    control: WizardFieldControl,
    options: Partial<WizardConfigField> = {},
  ): WizardConfigField => ({
    name,
    kind,
    required: required.has(name) || options.required === true,
    control,
    enumValues: options.enumValues,
    description: options.description ?? "",
    defaultValue: options.defaultValue ?? defaultCoreWith(type)[name] ?? "",
    inferred: true,
  });
  switch (type) {
    case "flow.condition":
      return [
        field("op", "string", "enum", {
          required: true,
          enumValues: ["eq", "ne", "gt", "lt", "gte", "lte", "exists", "contains"],
          defaultValue: "eq",
        }),
        field("path", "string", "text"),
        field("compare", "string", "text"),
      ];
    case "flow.delay":
      return [field("duration", "string", "text", { required: true, defaultValue: "PT5M" })];
    case "data.set":
      return [field("classification", "string", "enum", { enumValues: ["public", "internal"] })];
    case "flow.stop":
      return [
        field("status", "string", "enum", {
          enumValues: ["success", "failure", "canceled"],
          defaultValue: "success",
        }),
        field("message", "string", "text"),
      ];
    case "flow.fail":
      return [
        field("code", "string", "text", { required: true, defaultValue: "operator-failed" }),
        field("message", "string", "text"),
      ];
    default:
      return [];
  }
}

function controlForKind(kind: string, enumValues?: string[]): WizardFieldControl {
  if (enumValues?.length) {
    return "enum";
  }
  const folded = kind.toLowerCase();
  if (folded === "uuid") {
    return "uuid";
  }
  if (folded === "integer" || folded === "number") {
    return "number";
  }
  if (folded === "boolean") {
    return "boolean";
  }
  if (folded === "object" || folded === "map") {
    return "object-lines";
  }
  if (folded === "text" || folded.includes("yaml") || folded.includes("source")) {
    return "textarea";
  }
  return "text";
}

function selectorKindForField(name: string): OpsConfigKind | undefined {
  for (const [kind, field] of Object.entries(KIND_TO_WITH)) {
    if (field === name) {
      return kind as OpsConfigKind;
    }
  }
  return undefined;
}

function scoreRecommendation(
  entry: ActionLibraryEntry,
  input: {
    upstream?: { type: string; port: CatalogPort } | null;
    permissions?: readonly string[] | null;
    enabledTargetKinds?: readonly OpsConfigKind[];
  },
): WizardRecommendation {
  let score = 1;
  const reasons: string[] = ["Enabled catalog implementation"];
  if (input.upstream?.port) {
    const compatible = (entry.inputs ?? []).some((port) =>
      portsCompatible(input.upstream?.port, port),
    );
    if (compatible) {
      score += 5;
      reasons.push(`Accepts upstream ${input.upstream.port.name} (${input.upstream.port.kind})`);
    }
  }
  const needed = opsConfigKindsForAction(entry.type);
  const enabled = new Set(input.enabledTargetKinds ?? []);
  if (needed.length > 0 && needed.every((kind) => enabled.has(kind))) {
    score += 3;
    reasons.push("Published targets/profiles are available");
  } else if (needed.length > 0 && needed.some((kind) => enabled.has(kind))) {
    score += 1;
    reasons.push("Some matching published resources are available");
  }
  const perms = input.permissions ?? null;
  if (perms) {
    const wants = entry.policy?.permissions ?? [];
    if (wants.length > 0 && wants.every((perm) => perms.includes(perm) || perm === "workflow.execute")) {
      score += 2;
      reasons.push("Workspace permissions match catalog policy");
    }
  }
  if (entry.phase === "core") {
    score += 1;
  }
  return { type: entry.type, score, reasons };
}

function familyLabel(family: ActionFamily): string {
  switch (family) {
    case "kubernetes":
      return "Kubernetes";
    case "ssh":
      return "SSH";
    case "script":
      return "Scripts";
    case "http":
      return "HTTP";
    case "notification":
      return "Notifications";
    case "control":
      return "Control flow";
    case "data":
      return "Data";
    case "lifecycle":
      return "Lifecycle";
    default:
      return "Other";
  }
}

function credentialFailClosedReason(
  problem?: ProblemDetails | null,
  statusCode?: number,
): string {
  if (problem?.status === 403 || statusCode === 403) {
    return "Forbidden. Cross-workspace or unauthorized credentials are not listed.";
  }
  if (problem?.status === 404 || statusCode === 404) {
    return "Not found. Foreign workspace credentials fail closed.";
  }
  if (problem?.status === 401 || statusCode === 401) {
    return "Unauthenticated. Establish a workspace session before selecting credentials.";
  }
  return problem?.title || "Credential selector failed closed.";
}

function isEmptyWithValue(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}

function redactLeaves(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactLeaves);
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && looksLikeSecretValue(value)) {
      return "[redacted]";
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretFieldName(key) || isForbiddenYamlKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactLeaves(child);
  }
  return out;
}
