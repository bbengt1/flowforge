/**
 * Single retarget adapter for Chloe's E7.2 Kubernetes read/apply
 * node config (library + wizard). Wired to jonny's **#78** map on
 * `main`: GET /workflows/catalog + GET /kubernetes/catalog
 * (`nodes[]`, `errors[]`, `apply`).
 *
 * Prefer catalog `allowedWith` / `nodes[]` when present. Empty or
 * unauthorized catalogs fail closed (R3.4 / #249) — no invented
 * node types, ports, or config fields. Consume existing
 * cluster-target list + POST …/select. Do not invent routes.
 * Do not change `apps/api`.
 *
 * Relates to #71 / Part of #69. Keep #71 open — jonny owns the engine.
 * Relates to #249 / Part of #229. Keep #249 open.
 */

import {
  ENGINE_CATALOG_UNAVAILABLE_HELP,
} from "./catalog-fail-closed.ts";

import {
  KUBERNETES_ROLLOUT_KINDS,
  KUBERNETES_ROLLOUT_NODE_TYPE,
  KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE,
  KUBERNETES_WAIT_READY_OBSERVED,
  isKubernetesRolloutKind,
  isKubernetesRolloutType,
  rolloutIdentityFromWith,
  rolloutKindsFromCatalog,
  rolloutNodeDescription,
  rolloutWaitReadyMessage,
} from "./kubernetes-rollout-contract.ts";
import { KUBERNETES_ALLOWED_KINDS } from "./kubernetes-types.ts";
import type {
  KubernetesEngineApplyRules,
  KubernetesEngineCatalog,
  KubernetesEngineErrorShape,
  KubernetesEngineNodeContract,
} from "./kubernetes-types.ts";
import { CATALOG_PHASE_CORE } from "./workflow-types.ts";
import type {
  CatalogNode,
  CatalogWithField,
  WorkflowCatalog,
} from "./workflow-types.ts";
import { isCatalogImplementationEnabled } from "./workflow.ts";

export const KUBERNETES_NODE_STORY = 71;
export const KUBERNETES_NODE_EPIC = 69;
/** Jonny's E7.2 engine map on main. */
export const KUBERNETES_NODE_API_PR = 78;
export const KUBERNETES_NODE_ROUTE_MAP_SOURCE = "e72-#78" as const;

export const KUBERNETES_FIELD_MANAGER = "flowforge" as const;
export const KUBERNETES_FORCE_APPLY = false;
export const KUBERNETES_DEFAULT_TIMEOUT_SECONDS = 60;
export const KUBERNETES_OBSERVATION_DEFERRED = KUBERNETES_WAIT_READY_OBSERVED;

export const KUBERNETES_MVP_NODE_TYPES = [
  "kubernetes.apply",
  "kubernetes.get",
  "kubernetes.list",
  "kubernetes.rolloutStatus",
] as const;

export type KubernetesMvpNodeType = (typeof KUBERNETES_MVP_NODE_TYPES)[number];

export const KUBERNETES_ROLLOUT_STUB_TYPE = KUBERNETES_ROLLOUT_NODE_TYPE;

export const KUBERNETES_DRY_RUN_MODES = ["client", "server"] as const;
export type KubernetesDryRunMode = (typeof KUBERNETES_DRY_RUN_MODES)[number];

export const KUBERNETES_WAIT_MODES = ["none", "ready"] as const;
export type KubernetesWaitMode = (typeof KUBERNETES_WAIT_MODES)[number];

export const KUBERNETES_MIN_TIMEOUT_SECONDS = 1;
export const KUBERNETES_MAX_TIMEOUT_SECONDS = 3600;

/** Never user-controlled. Stripped from wizard `with` before YAML insert. */
export const KUBERNETES_FORBIDDEN_WITH_KEYS = [
  "force",
  "kubeconfig",
  "server",
  "fieldManager",
] as const;

export const KUBERNETES_DENIED_MANIFEST_KINDS = [
  "Secret",
  "Namespace",
  "Node",
  "PersistentVolume",
  "CustomResourceDefinition",
  "ClusterRole",
  "ClusterRoleBinding",
  "Role",
  "RoleBinding",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
  "ValidatingAdmissionPolicy",
  "MutatingAdmissionPolicy",
] as const;

export const KUBERNETES_NODE_POLICY_NOTES = [
  "Secret manifests are denied (data, stringData, and binaryData).",
  "MVP kinds: ConfigMap, Service, Deployment, StatefulSet, DaemonSet, Job, CronJob, Ingress, NetworkPolicy.",
  "Cluster-scoped resources, namespaces, CRDs, RBAC, and admission webhooks are out of MVP.",
  "Privileged workloads, hostPath, host network/PID/IPC, and mutable tags including :latest are denied.",
  "Force apply, deletion, rollback, and pasted kubeconfigs are not available.",
  "FieldManager is fixed to flowforge with Force=false. Ownership conflicts are returned, never stolen.",
  "Apply always runs a strict server-side dry-run before persist. Client dry-run never replaces it.",
  "wait=ready starts a bounded rollout observation. Timeout or cancel stops waiting — never delete or rollback.",
  "The UI never receives or stores kubeconfigs or plaintext credentials.",
] as const;

export const KUBERNETES_SECRET_MANIFEST_MESSAGE =
  "Secret manifests are denied. data, stringData, and binaryData on Secret documents cannot be stored in workflow YAML.";

export const KUBERNETES_FORCE_DENIED_MESSAGE =
  "Force apply is not available. FieldManager is flowforge and Force=false; ownership conflicts are returned, never stolen.";

export const KUBERNETES_TARGET_FAIL_CLOSED_MESSAGE =
  "Cluster target selector failed closed. Only published workspace kubernetes targets are listed; unauthorized or cross-workspace targets are not shown.";

export const KUBERNETES_NAMESPACE_REQUIRED_MESSAGE =
  "namespace is required and must be an allowed namespace on the selected cluster target.";

export const KUBERNETES_KUBECONFIG_DENIED_MESSAGE =
  "Kubeconfigs and plaintext credentials cannot be pasted into node configuration.";

export const KUBERNETES_ROLLOUT_STUB_MESSAGE = rolloutNodeDescription();

export const KUBERNETES_WAIT_READY_MESSAGE = rolloutWaitReadyMessage();

export const DEFAULT_KUBERNETES_APPLY_RULES: KubernetesEngineApplyRules = {
  fieldManager: KUBERNETES_FIELD_MANAGER,
  force: false,
  serverDryRunAlways: true,
  clientDryRunAddsLocalValidationOnly: true,
  waitReady: KUBERNETES_WAIT_READY_OBSERVED,
};

const NAMESPACE_DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type KubernetesNodeWithField = CatalogWithField & {
  label: string;
  advanced?: boolean;
  readOnly?: boolean;
  controlHint: "text" | "textarea" | "enum" | "uuid" | "number";
  defaultValue?: unknown;
};

export type KubernetesNodeConfigContext = {
  allowedNamespaces?: readonly string[];
  targetSelectorClosed?: boolean;
  engineCatalog?: KubernetesEngineCatalog | null;
  allowedKinds?: readonly string[];
};

export function isKubernetesMvpNodeType(
  type: string,
): type is KubernetesMvpNodeType {
  return (KUBERNETES_MVP_NODE_TYPES as readonly string[]).includes(type);
}

export function isKubernetesRolloutStubType(type: string): boolean {
  return isKubernetesRolloutType(type);
}

export function isKubernetesConfigurableType(type: string): boolean {
  return isKubernetesMvpNodeType(type) || isKubernetesRolloutType(type);
}

export function catalogListsKubernetesType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): boolean {
  return (catalog?.nodes ?? []).some(
    (item) => item.type === type && isCatalogImplementationEnabled(item),
  );
}

/**
 * Placeable Kubernetes types from live catalogs only. Empty / missing
 * catalogs fail closed — MVP types are not invented.
 */
export function kubernetesLibraryTypes(
  catalog?: WorkflowCatalog | null,
  engineCatalog?: KubernetesEngineCatalog | null,
): readonly string[] {
  const types = new Set<string>();
  for (const node of catalog?.nodes ?? []) {
    if (
      isKubernetesConfigurableType(node.type) &&
      isCatalogImplementationEnabled(node)
    ) {
      types.add(node.type);
    }
  }
  for (const node of engineCatalog?.nodes ?? []) {
    if (isKubernetesConfigurableType(node.type)) {
      types.add(node.type);
    }
  }
  return [...types];
}

export function hasKubernetesNodeContract(
  node: CatalogNode | undefined,
): boolean {
  return Boolean(
    node &&
      ((node.allowedWith && node.allowedWith.length > 0) ||
        node.policy ||
        node.bounds ||
        node.redaction),
  );
}

export function defaultKubernetesWith(
  type: string,
): Record<string, unknown> {
  switch (type) {
    case "kubernetes.apply":
    case "kubernetes.get":
    case "kubernetes.list":
      return {
        dryRun: "server",
        wait: "none",
        timeoutSeconds: KUBERNETES_DEFAULT_TIMEOUT_SECONDS,
      };
    case "kubernetes.rolloutStatus":
      return { wait: "ready", timeoutSeconds: KUBERNETES_DEFAULT_TIMEOUT_SECONDS };
    default:
      return {};
  }
}

export function applyRulesFromCatalog(
  catalog?: KubernetesEngineCatalog | null,
): KubernetesEngineApplyRules {
  return catalog?.apply ?? DEFAULT_KUBERNETES_APPLY_RULES;
}

export function engineNodeContract(
  type: string,
  catalog?: KubernetesEngineCatalog | null,
): KubernetesEngineNodeContract | undefined {
  return catalog?.nodes.find((item) => item.type === type);
}

export function engineErrorShapes(
  catalog?: KubernetesEngineCatalog | null,
): KubernetesEngineErrorShape[] {
  return catalog?.errors ?? [];
}

export function waitReadyMessage(
  catalog?: KubernetesEngineCatalog | null,
): string {
  return rolloutWaitReadyMessage(catalog);
}

export function kubernetesNodeWithFields(
  type: string,
  engineCatalog?: KubernetesEngineCatalog | null,
): KubernetesNodeWithField[] {
  const engineNode = engineNodeContract(type, engineCatalog);
  if (!engineNode?.allowedWith.length) {
    return [];
  }
  return overlayKubernetesFields(
    engineNode.allowedWith,
    type,
    engineCatalog?.allowedKinds ?? [],
    waitReadyMessage(engineCatalog),
  );
}

function kubernetesFieldChrome(
  name: string,
  type: string,
): Partial<KubernetesNodeWithField> {
  switch (name) {
    case "clusterTargetId":
      return { label: "Cluster target", controlHint: "uuid" };
    case "namespace":
      return { label: "Namespace", controlHint: "text" };
    case "dryRun":
      return {
        label: "Local dry-run",
        controlHint: "enum",
        advanced: true,
        defaultValue: "server",
        enum: [...KUBERNETES_DRY_RUN_MODES],
      };
    case "wait":
      return {
        label: "Wait",
        controlHint: "enum",
        advanced: !isKubernetesRolloutType(type),
        defaultValue: isKubernetesRolloutType(type) ? "ready" : "none",
        enum: [...KUBERNETES_WAIT_MODES],
      };
    case "timeoutSeconds":
      return {
        label: "Timeout (seconds)",
        controlHint: "number",
        defaultValue: KUBERNETES_DEFAULT_TIMEOUT_SECONDS,
        advanced: !isKubernetesRolloutType(type),
      };
    case "fieldManager":
      return {
        label: "Field manager",
        controlHint: "text",
        defaultValue: KUBERNETES_FIELD_MANAGER,
        advanced: true,
        readOnly: true,
        enum: [KUBERNETES_FIELD_MANAGER],
      };
    case "policyId":
      return { label: "Policy", controlHint: "uuid", advanced: true };
    case "manifests":
      return { label: "Manifests", controlHint: "textarea" };
    case "kind":
      return { label: "Kind", controlHint: "enum" };
    case "name":
      return { label: "Name", controlHint: "text" };
    case "resource":
      return { label: "Resource", controlHint: "text", advanced: true };
    default:
      return {};
  }
}

export function overlayKubernetesFields(
  fields: CatalogWithField[],
  type: string,
  allowedKinds: readonly string[] = [],
  waitNote = KUBERNETES_WAIT_READY_MESSAGE,
): KubernetesNodeWithField[] {
  return fields
    .filter((field) => field.name !== "force")
    .map((field) => {
      const chrome = kubernetesFieldChrome(field.name, type);
      const kindEnum =
        field.name === "kind" && allowedKinds.length
          ? isKubernetesRolloutType(type)
            ? allowedKinds.filter((kind) => isKubernetesRolloutKind(kind))
            : [...allowedKinds]
          : undefined;
      const controlHint =
        field.name === "manifests"
          ? "textarea"
          : chrome.controlHint ??
            (field.kind === "uuid"
              ? "uuid"
              : field.kind === "integer"
                ? "number"
                : field.enum?.length
                  ? "enum"
                  : "text");
      return {
        name: field.name,
        kind: field.kind,
        required: field.required === true,
        enum: field.enum?.length ? field.enum : kindEnum ?? chrome.enum,
        description:
          field.name === "wait"
            ? waitNote
            : field.description || chrome.description || "",
        label: chrome.label || field.name,
        advanced: chrome.advanced,
        readOnly: field.name === "fieldManager" || chrome.readOnly,
        controlHint,
        defaultValue:
          field.name === "fieldManager"
            ? KUBERNETES_FIELD_MANAGER
            : chrome.defaultValue,
      };
    });
}

export function kubernetesForbiddenWithKeys(
  value: Record<string, unknown>,
): string[] {
  return KUBERNETES_FORBIDDEN_WITH_KEYS.filter((key) => key in value);
}

export function stripKubernetesForbiddenWith(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((KUBERNETES_FORBIDDEN_WITH_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = raw;
  }
  return out;
}

export function looksLikeSecretManifest(src: string): boolean {
  for (const doc of src.split(/\n---/)) {
    let kindSecret = false;
    let hasSecretData = false;
    for (const line of doc.split("\n")) {
      const trim = line.trim();
      if (trim === "kind: Secret" || trim.startsWith("kind: Secret")) {
        kindSecret = true;
      }
      if (
        trim.startsWith("stringData:") ||
        trim.startsWith("data:") ||
        trim.startsWith("binaryData:")
      ) {
        hasSecretData = true;
      }
    }
    if (kindSecret || (hasSecretData && doc.includes("Secret"))) {
      return true;
    }
  }
  return false;
}

export function looksLikePastedKubeconfig(src: string): boolean {
  const folded = src.toLowerCase();
  if (folded.includes("kubeconfig")) {
    return true;
  }
  const hasConfigKind = /(?:^|\n)\s*kind:\s*Config(?:\s|$)/.test(src);
  const hasClusters = /(?:^|\n)\s*clusters:\s*$/m.test(src);
  const hasUsers = /(?:^|\n)\s*users:\s*$/m.test(src);
  return hasConfigKind && (hasClusters || hasUsers);
}

export function validateKubernetesNodeConfig(
  type: string,
  withValue: Record<string, unknown>,
  context: KubernetesNodeConfigContext = {},
): string[] {
  if (!isKubernetesConfigurableType(type)) {
    return [];
  }
  const errors: string[] = [];
  if (context.targetSelectorClosed) {
    errors.push(KUBERNETES_TARGET_FAIL_CLOSED_MESSAGE);
  }
  if (kubernetesForbiddenWithKeys(withValue).includes("force")) {
    errors.push(KUBERNETES_FORCE_DENIED_MESSAGE);
  }
  if (kubernetesForbiddenWithKeys(withValue).includes("kubeconfig")) {
    errors.push(KUBERNETES_KUBECONFIG_DENIED_MESSAGE);
  }

  const namespace =
    typeof withValue.namespace === "string" ? withValue.namespace.trim() : "";
  if (!namespace) {
    errors.push(KUBERNETES_NAMESPACE_REQUIRED_MESSAGE);
  } else if (!NAMESPACE_DNS.test(namespace) || namespace.length > 63) {
    errors.push("namespace must be a DNS label.");
  } else if (
    context.allowedNamespaces &&
    context.allowedNamespaces.length > 0 &&
    !context.allowedNamespaces.includes(namespace)
  ) {
    errors.push(
      `namespace must be in the selected target allowlist (${context.allowedNamespaces.join(", ")}).`,
    );
  }

  const clusterTargetId =
    typeof withValue.clusterTargetId === "string"
      ? withValue.clusterTargetId.trim()
      : "";
  if (!clusterTargetId) {
    errors.push("clusterTargetId is required. Choose a published kubernetes cluster target.");
  }

  if (type === "kubernetes.apply") {
    const manifests =
      typeof withValue.manifests === "string" ? withValue.manifests : "";
    if (!manifests.trim()) {
      errors.push("manifests are required for kubernetes.apply.");
    } else {
      errors.push(...validateApplyManifests(manifests));
    }
  }

  const allowedKinds =
    context.allowedKinds?.length
      ? context.allowedKinds
      : context.engineCatalog?.allowedKinds?.length
        ? context.engineCatalog.allowedKinds
        : KUBERNETES_ALLOWED_KINDS;

  if (type === "kubernetes.get" || type === "kubernetes.list") {
    const kind = typeof withValue.kind === "string" ? withValue.kind.trim() : "";
    if (!kind) {
      errors.push("kind is required.");
    } else if (![...allowedKinds].includes(kind)) {
      errors.push(
        `kind ${kind} is not in the MVP allowlist (${[...allowedKinds].join(", ")}).`,
      );
    }
  }
  if (type === "kubernetes.get") {
    const name = typeof withValue.name === "string" ? withValue.name.trim() : "";
    if (!name) {
      errors.push("name is required for kubernetes.get.");
    } else if (!NAMESPACE_DNS.test(name)) {
      errors.push("name must be a DNS label.");
    }
  }
  if (isKubernetesRolloutType(type)) {
    const identity = rolloutIdentityFromWith(withValue);
    const rolloutKinds = rolloutKindsFromCatalog(context.engineCatalog);
    const allowedRollout = rolloutKinds.filter((item) =>
      [...allowedKinds].includes(item),
    );
    const check = allowedRollout.length
      ? allowedRollout
      : rolloutKinds.length
        ? rolloutKinds
        : [...KUBERNETES_ROLLOUT_KINDS];
    if (!identity.kind) {
      errors.push("kind is required (or resource.kind).");
    } else if (![...check].includes(identity.kind)) {
      errors.push(
        `kind ${identity.kind} is not a rollout workload (${[...check].join(", ")}).`,
      );
    }
    if (!identity.name) {
      errors.push("name is required for kubernetes.rolloutStatus unless resource.name is set.");
    } else if (!NAMESPACE_DNS.test(identity.name)) {
      errors.push("name must be a DNS label.");
    }
  }

  if (withValue.fieldManager !== undefined && withValue.fieldManager !== "") {
    if (String(withValue.fieldManager) !== KUBERNETES_FIELD_MANAGER) {
      errors.push(
        "fieldManager is service-owned and must be flowforge. Force is never user-controlled.",
      );
    }
  }
  if (withValue.policyId !== undefined && withValue.policyId !== "") {
    const policyId = String(withValue.policyId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        policyId,
      )
    ) {
      errors.push("policyId must be a workspace UUID.");
    }
  }
  if (withValue.dryRun !== undefined) {
    const dryRun = String(withValue.dryRun);
    if (!(KUBERNETES_DRY_RUN_MODES as readonly string[]).includes(dryRun)) {
      errors.push("dryRun must be client or server.");
    }
  }
  if (withValue.wait !== undefined) {
    const wait = String(withValue.wait);
    if (!(KUBERNETES_WAIT_MODES as readonly string[]).includes(wait)) {
      errors.push("wait must be none or ready.");
    }
  }
  if (withValue.timeoutSeconds !== undefined) {
    const timeout = Number(withValue.timeoutSeconds);
    if (
      !Number.isFinite(timeout) ||
      timeout < KUBERNETES_MIN_TIMEOUT_SECONDS ||
      timeout > KUBERNETES_MAX_TIMEOUT_SECONDS
    ) {
      errors.push(
        `timeoutSeconds must be between ${KUBERNETES_MIN_TIMEOUT_SECONDS} and ${KUBERNETES_MAX_TIMEOUT_SECONDS}.`,
      );
    }
  }

  return unique(errors);
}

export function allowedNamespacesFromPinSpec(
  spec: { allowedNamespaces?: unknown; policy?: unknown } | null | undefined,
): string[] {
  if (!spec) {
    return [];
  }
  const fromSpec = stringList(spec.allowedNamespaces);
  const policy =
    spec.policy && typeof spec.policy === "object" && !Array.isArray(spec.policy)
      ? (spec.policy as Record<string, unknown>)
      : {};
  return unique([
    ...fromSpec,
    ...stringList(policy.allowedNamespaces ?? policy.namespaces),
  ]);
}

export function kubernetesFallbackNode(type: string): CatalogNode {
  return {
    type,
    phase: CATALOG_PHASE_CORE,
    title: type,
    description: ENGINE_CATALOG_UNAVAILABLE_HELP,
    inputs: [],
    outputs: [],
    requiredWith: [],
    allowedWith: [],
  };
}

export function adaptKubernetesNodeEntries(
  catalog: WorkflowCatalog | null | undefined,
  engineCatalog?: KubernetesEngineCatalog | null,
): CatalogNode[] {
  return kubernetesLibraryTypes(catalog, engineCatalog).flatMap((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const engine = engineNodeContract(type, engineCatalog);
    if (!listed && !engine) {
      return [];
    }
    const engineAllowed = engine?.allowedWith.length
      ? engine.allowedWith
      : undefined;
    return [
      {
        type,
        phase: listed?.phase ?? CATALOG_PHASE_CORE,
        title: listed?.title || engine?.title || type,
        description: listed?.description || engine?.description || "",
        inputs: listed?.inputs ?? [],
        outputs: listed?.outputs ?? [],
        requiredWith: listed?.requiredWith?.length
          ? listed.requiredWith
          : engine?.requiredWith ?? [],
        allowedWith: listed?.allowedWith?.length
          ? listed.allowedWith
          : engineAllowed ?? [],
        policy: listed?.policy ?? null,
        bounds: listed?.bounds ?? null,
        redaction: listed?.redaction ?? null,
      },
    ];
  });
}

function validateApplyManifests(src: string): string[] {
  const errors: string[] = [];
  if (looksLikePastedKubeconfig(src)) {
    errors.push(KUBERNETES_KUBECONFIG_DENIED_MESSAGE);
  }
  if (looksLikeSecretManifest(src)) {
    errors.push(KUBERNETES_SECRET_MANIFEST_MESSAGE);
  }
  if (/(?:^|\n)\s*hostPath\s*:/.test(src)) {
    errors.push("hostPath volumes are denied.");
  }
  if (/(?:^|\n)\s*privileged\s*:\s*true\b/.test(src)) {
    errors.push("Privileged workloads are denied.");
  }
  if (
    /(?:^|\n)\s*hostNetwork\s*:\s*true\b/.test(src) ||
    /(?:^|\n)\s*hostPID\s*:\s*true\b/.test(src) ||
    /(?:^|\n)\s*hostIPC\s*:\s*true\b/.test(src)
  ) {
    errors.push("Host network, PID, and IPC namespaces are denied.");
  }
  if (/:[A-Za-z0-9._-]*latest\b/.test(src) || /image:\s*\S+:latest\b/.test(src)) {
    errors.push("Mutable image tags including :latest are denied. Pin images by digest.");
  }
  for (const doc of src.split(/\n---/)) {
    const kind = manifestKind(doc);
    if (!kind) {
      continue;
    }
    if ((KUBERNETES_DENIED_MANIFEST_KINDS as readonly string[]).includes(kind)) {
      if (kind === "Secret") {
        continue;
      }
      errors.push(
        `${kind} is denied in MVP (no cluster-scoped resources, namespaces, CRDs, RBAC, or admission webhooks).`,
      );
      continue;
    }
    if (!(KUBERNETES_ALLOWED_KINDS as readonly string[]).includes(kind)) {
      errors.push(
        `${kind} is not in the MVP kind allowlist (${KUBERNETES_ALLOWED_KINDS.join(", ")}).`,
      );
    }
  }
  return unique(errors);
}

function manifestKind(doc: string): string | null {
  for (const line of doc.split("\n")) {
    const match = line.trim().match(/^kind:\s*([A-Za-z][A-Za-z0-9]*)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
