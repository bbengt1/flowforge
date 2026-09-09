/**
 * Single retarget adapter for Chloe's E7.2 Kubernetes read/apply
 * node config (library + wizard). Wired to jonny's **#78** map on
 * `main`: GET /workflows/catalog + GET /kubernetes/catalog
 * (`nodes[]`, `errors[]`, `apply`).
 *
 * Prefer catalog `allowedWith` / `nodes[]` when present. Fallback
 * entries stay marked `contract-fallback` (E3.3/E6.3 pattern).
 * Consume existing cluster-target list + POST …/select.
 * Do not invent routes. Do not change `apps/api`.
 *
 * Relates to #71 / Part of #69. Do not close #71.
 */

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
  CatalogNodeBounds,
  CatalogNodePolicy,
  CatalogPort,
  CatalogRedaction,
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
export const KUBERNETES_OBSERVATION_DEFERRED = "deferred-e7.3" as const;

export const KUBERNETES_MVP_NODE_TYPES = [
  "kubernetes.apply",
  "kubernetes.get",
  "kubernetes.list",
] as const;

export type KubernetesMvpNodeType = (typeof KUBERNETES_MVP_NODE_TYPES)[number];

export const KUBERNETES_ROLLOUT_STUB_TYPE = "kubernetes.rolloutStatus" as const;

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
  "wait=ready is accepted; observation is deferred-e7.3 (no rollout watch in this story).",
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

export const KUBERNETES_ROLLOUT_STUB_MESSAGE =
  "Rollout observation is E7.3. Configure the cluster target and namespace only — full rollout UX is not in this story.";

export const KUBERNETES_WAIT_READY_MESSAGE =
  "wait=ready is accepted. Rollout observation is deferred-e7.3 — this is not a rollout watch.";

export const DEFAULT_KUBERNETES_APPLY_RULES: KubernetesEngineApplyRules = {
  fieldManager: KUBERNETES_FIELD_MANAGER,
  force: false,
  serverDryRunAlways: true,
  clientDryRunAddsLocalValidationOnly: true,
  waitReady: KUBERNETES_OBSERVATION_DEFERRED,
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
  return type === KUBERNETES_ROLLOUT_STUB_TYPE;
}

export function isKubernetesConfigurableType(type: string): boolean {
  return isKubernetesMvpNodeType(type) || isKubernetesRolloutStubType(type);
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
 * MVP nodes always have a fallback. rolloutStatus is a stub only when
 * GET /workflows/catalog already lists it (live catalog on main does).
 */
export function kubernetesLibraryTypes(
  catalog: WorkflowCatalog | null | undefined,
): readonly string[] {
  const types: string[] = [...KUBERNETES_MVP_NODE_TYPES];
  if (catalogListsKubernetesType(catalog, KUBERNETES_ROLLOUT_STUB_TYPE)) {
    types.push(KUBERNETES_ROLLOUT_STUB_TYPE);
  }
  return types;
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
  const observation =
    applyRulesFromCatalog(catalog).waitReady || KUBERNETES_OBSERVATION_DEFERRED;
  return `wait=ready is accepted. Rollout observation is ${observation} — this is not a rollout watch.`;
}

export function kubernetesNodeWithFields(
  type: string,
  engineCatalog?: KubernetesEngineCatalog | null,
): KubernetesNodeWithField[] {
  const engineNode = engineNodeContract(type, engineCatalog);
  const kinds =
    engineCatalog?.allowedKinds?.length
      ? engineCatalog.allowedKinds
      : [...KUBERNETES_ALLOWED_KINDS];
  const waitNote = waitReadyMessage(engineCatalog);
  const common: KubernetesNodeWithField[] = [
    {
      name: "clusterTargetId",
      kind: "uuid",
      required: true,
      label: "Cluster target",
      controlHint: "uuid",
      description:
        "Published workspace cluster target (display name + id). Never a kubeconfig.",
    },
    {
      name: "namespace",
      kind: "string",
      required: true,
      label: "Namespace",
      controlHint: "text",
      description:
        "DNS-1123 namespace. Must be on the target and policy allowlists. Empty allowlists fail closed.",
    },
    {
      name: "dryRun",
      kind: "enum",
      enum: [...KUBERNETES_DRY_RUN_MODES],
      label: "Local dry-run",
      controlHint: "enum",
      defaultValue: "server",
      advanced: true,
      description:
        "client adds local validation only. Apply always performs a strict server-side dry-run before persist.",
    },
    {
      name: "wait",
      kind: "enum",
      enum: [...KUBERNETES_WAIT_MODES],
      label: "Wait",
      controlHint: "enum",
      defaultValue: "none",
      advanced: true,
      description: waitNote,
    },
    {
      name: "timeoutSeconds",
      kind: "integer",
      label: "Timeout (seconds)",
      controlHint: "number",
      defaultValue: KUBERNETES_DEFAULT_TIMEOUT_SECONDS,
      advanced: true,
      description: `Bounded timeout (${KUBERNETES_MIN_TIMEOUT_SECONDS}–${KUBERNETES_MAX_TIMEOUT_SECONDS}). Default ${KUBERNETES_DEFAULT_TIMEOUT_SECONDS}.`,
    },
    {
      name: "fieldManager",
      kind: "enum",
      enum: [KUBERNETES_FIELD_MANAGER],
      label: "Field manager",
      controlHint: "text",
      defaultValue: KUBERNETES_FIELD_MANAGER,
      advanced: true,
      readOnly: true,
      description:
        "Service-owned. Fixed to flowforge. Force is false and is not user-controlled.",
    },
    {
      name: "policyId",
      kind: "uuid",
      label: "Policy",
      controlHint: "uuid",
      advanced: true,
      description: "Optional published kubernetes policy UUID.",
    },
  ];

  if (engineNode?.allowedWith.length) {
    return overlayKubernetesFields(engineNode.allowedWith, type, kinds, waitNote);
  }

  if (type === "kubernetes.apply") {
    return [
      ...common,
      {
        name: "manifests",
        kind: "string",
        label: "Manifests",
        controlHint: "textarea",
        description:
          "Multi-document YAML. Secret data is denied. Images must be allowlisted and digest-pinned.",
      },
    ];
  }

  if (type === "kubernetes.get") {
    return [
      ...common,
      {
        name: "kind",
        kind: "enum",
        required: true,
        enum: [...kinds],
        label: "Kind",
        controlHint: "enum",
        description: "Allowlisted kind only.",
      },
      {
        name: "name",
        kind: "string",
        required: true,
        label: "Name",
        controlHint: "text",
        description: "Resource name.",
      },
    ];
  }

  if (type === "kubernetes.list") {
    return [
      ...common,
      {
        name: "kind",
        kind: "enum",
        required: true,
        enum: [...kinds],
        label: "Kind",
        controlHint: "enum",
        description: "Allowlisted kind only.",
      },
    ];
  }

  if (type === KUBERNETES_ROLLOUT_STUB_TYPE) {
    return common.map((field) =>
      field.name === "wait"
        ? { ...field, defaultValue: "ready", description: KUBERNETES_ROLLOUT_STUB_MESSAGE }
        : field,
    );
  }

  return common;
}

export function overlayKubernetesFields(
  fields: CatalogWithField[],
  type: string,
  allowedKinds: readonly string[] = KUBERNETES_ALLOWED_KINDS,
  waitNote = KUBERNETES_WAIT_READY_MESSAGE,
): KubernetesNodeWithField[] {
  const fallback = new Map(
    kubernetesNodeWithFields(type).map((field) => [field.name, field]),
  );
  return fields
    .filter((field) => field.name !== "force")
    .map((field) => {
      const base = fallback.get(field.name);
      const controlHint =
        field.name === "manifests"
          ? "textarea"
          : base?.controlHint ??
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
        enum:
          field.enum?.length
            ? field.enum
            : field.name === "kind"
              ? [...allowedKinds]
              : base?.enum,
        description:
          field.name === "wait"
            ? waitNote
            : field.description || base?.description || "",
        label: base?.label || field.name,
        advanced: base?.advanced,
        readOnly: field.name === "fieldManager" || base?.readOnly,
        controlHint,
        defaultValue:
          field.name === "fieldManager"
            ? KUBERNETES_FIELD_MANAGER
            : base?.defaultValue,
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
  return KUBERNETES_CONTRACT_FALLBACK[type] ?? thinFallback(type);
}

export function adaptKubernetesNodeEntries(
  catalog: WorkflowCatalog | null | undefined,
  engineCatalog?: KubernetesEngineCatalog | null,
): CatalogNode[] {
  return kubernetesLibraryTypes(catalog).map((type) => {
    const listed = (catalog?.nodes ?? []).find((item) => item.type === type);
    const fallback = kubernetesFallbackNode(type);
    const engine = engineNodeContract(type, engineCatalog);
    const engineAllowed = engine?.allowedWith.length
      ? engine.allowedWith
      : undefined;
    if (!listed) {
      if (!engine) {
        return fallback;
      }
      return {
        ...fallback,
        title: engine.title || fallback.title,
        description: engine.description || fallback.description,
        requiredWith: engine.requiredWith.length
          ? engine.requiredWith
          : fallback.requiredWith,
        allowedWith: engineAllowed ?? fallback.allowedWith,
      };
    }
    return {
      ...fallback,
      ...listed,
      title: listed.title || engine?.title || fallback.title,
      description: listed.description || engine?.description || fallback.description,
      inputs: listed.inputs?.length ? listed.inputs : fallback.inputs,
      outputs: listed.outputs?.length ? listed.outputs : fallback.outputs,
      requiredWith: listed.requiredWith?.length
        ? listed.requiredWith
        : engine?.requiredWith.length
          ? engine.requiredWith
          : fallback.requiredWith,
      allowedWith: listed.allowedWith?.length
        ? listed.allowedWith
        : engineAllowed ?? fallback.allowedWith,
      policy: listed.policy ?? fallback.policy,
      bounds: listed.bounds ?? fallback.bounds,
      redaction: listed.redaction ?? fallback.redaction,
    };
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

function inherit(
  name: string,
  kind: string,
  required: boolean,
  description: string,
): CatalogPort {
  return {
    name,
    kind,
    required,
    classification: "internal",
    maxBytes: 16 * 1024,
    description,
  };
}

function applyPolicy(): CatalogNodePolicy {
  return {
    permissions: ["workflow.execute", "kubernetes.apply", "clusterTarget.use"],
    retrySafe: false,
    sideEffects: true,
    idempotent: true,
    cancellation: "stop-wait",
    verification: "observe-generation",
    defaultMaxAttempts: 1,
  };
}

function readPolicy(): CatalogNodePolicy {
  return {
    permissions: ["workflow.execute", "kubernetes.read", "clusterTarget.use"],
    retrySafe: true,
    sideEffects: false,
    idempotent: true,
    cancellation: "path-local",
    verification: "none",
    defaultMaxAttempts: 1,
  };
}

function defaultBounds(maxDurationSeconds: number): CatalogNodeBounds {
  return {
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    maxWithBytes: 64 * 1024,
    maxAggregationItems: 32,
    maxDurationSeconds,
  };
}

function redaction(auditFields: string[]): CatalogRedaction {
  return {
    auditFields,
    redactInputs: true,
    redactOutputs: true,
    strategy: "drop-secrets",
  };
}

function fieldsToAllowed(type: string): CatalogWithField[] {
  return kubernetesNodeWithFields(type).map((field) => ({
    name: field.name,
    kind: field.kind,
    required: field.required,
    enum: field.enum,
    description: field.description,
  }));
}

function thinFallback(type: string): CatalogNode {
  return {
    type,
    phase: CATALOG_PHASE_CORE,
    title: type,
    description: "",
    inputs: [],
    outputs: [],
    requiredWith: ["clusterTargetId", "namespace"],
    allowedWith: fieldsToAllowed(type),
  };
}

const resultPort = inherit("result", "object", false, "Redacted result object.");

const KUBERNETES_CONTRACT_FALLBACK: Record<string, CatalogNode> = {
  "kubernetes.apply": {
    type: "kubernetes.apply",
    phase: CATALOG_PHASE_CORE,
    title: "Apply manifests",
    description:
      "Validate YAML and policy, always server-side dry-run, then server-side apply with FieldManager=flowforge and Force=false.",
    inputs: [
      inherit("manifests", "string", false, "Optional upstream multi-doc YAML."),
      inherit("parameters", "object", false, "Optional typed parameters."),
    ],
    outputs: [
      resultPort,
      inherit("resources", "object", false, "Applied resource identities."),
      inherit("status", "object", false, "Redacted apply/dry-run status."),
    ],
    requiredWith: ["clusterTargetId", "namespace"],
    allowedWith: fieldsToAllowed("kubernetes.apply"),
    policy: applyPolicy(),
    bounds: defaultBounds(KUBERNETES_MAX_TIMEOUT_SECONDS),
    redaction: redaction([
      "clusterTargetId",
      "namespace",
      "manifestDigest",
      "fieldManager",
      "force",
      "dryRun",
      "applied",
    ]),
  },
  "kubernetes.get": {
    type: "kubernetes.get",
    phase: CATALOG_PHASE_CORE,
    title: "Get resource",
    description: "Read one allowlisted resource in an allowlisted namespace.",
    inputs: [inherit("parameters", "object", false, "Optional typed parameters.")],
    outputs: [
      resultPort,
      inherit("items", "object", false, "Redacted resource object."),
    ],
    requiredWith: ["clusterTargetId", "namespace", "kind", "name"],
    allowedWith: fieldsToAllowed("kubernetes.get"),
    policy: readPolicy(),
    bounds: defaultBounds(KUBERNETES_MAX_TIMEOUT_SECONDS),
    redaction: redaction(["clusterTargetId", "namespace", "kind", "name"]),
  },
  "kubernetes.list": {
    type: "kubernetes.list",
    phase: CATALOG_PHASE_CORE,
    title: "List resources",
    description: "List allowlisted resources in an allowlisted namespace.",
    inputs: [inherit("parameters", "object", false, "Optional typed parameters.")],
    outputs: [
      resultPort,
      inherit("items", "object", false, "Redacted resource list."),
    ],
    requiredWith: ["clusterTargetId", "namespace", "kind"],
    allowedWith: fieldsToAllowed("kubernetes.list"),
    policy: readPolicy(),
    bounds: defaultBounds(KUBERNETES_MAX_TIMEOUT_SECONDS),
    redaction: redaction(["clusterTargetId", "namespace", "kind", "count"]),
  },
  "kubernetes.rolloutStatus": {
    type: "kubernetes.rolloutStatus",
    phase: CATALOG_PHASE_CORE,
    title: "Rollout status",
    description: KUBERNETES_ROLLOUT_STUB_MESSAGE,
    inputs: [
      inherit("resource", "object", true, "Resource identity. Full rollout UX is E7.3."),
    ],
    outputs: [
      resultPort,
      inherit("status", "object", false, "Redacted observation status."),
    ],
    requiredWith: ["clusterTargetId", "namespace"],
    allowedWith: fieldsToAllowed("kubernetes.rolloutStatus"),
    policy: {
      permissions: ["workflow.execute", "kubernetes.read", "clusterTarget.use"],
      retrySafe: true,
      sideEffects: false,
      idempotent: true,
      cancellation: "path-local",
      verification: "none",
      defaultMaxAttempts: 1,
    },
    bounds: defaultBounds(KUBERNETES_MAX_TIMEOUT_SECONDS),
    redaction: redaction(["clusterTargetId", "namespace"]),
  },
};

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
