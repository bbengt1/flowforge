/**
 * E7.1 cluster-target + Kubernetes policy helpers.
 * Authorized selectors fail closed on 403. Unexpected kubeconfig /
 * secret fields are stripped and never shown.
 */

import {
  HOST_SUPPLIED_IDENTITY_DETAIL,
  KUBERNETES_FAIL_CLOSED_HELP,
  KUBERNETES_LEAST_PRIVILEGE_NOTES,
  KUBERNETES_PROBLEM_CODES,
} from "./kubernetes-contract.ts";
import {
  KUBERNETES_ACTION_TYPES,
  KUBERNETES_ALLOWED_KINDS,
  KUBERNETES_ALLOWED_VERBS,
  KUBERNETES_CREDENTIAL_TYPE,
  KUBERNETES_POLICY_KIND,
  type KubernetesEngineApplyRules,
  type KubernetesEngineCatalog,
  type KubernetesEngineErrorShape,
  type KubernetesEngineNodeContract,
  type KubernetesEvaluationKey,
  type KubernetesPolicyBody,
} from "./kubernetes-types.ts";
import type { ProblemDetails } from "./problem.ts";
import {
  authorizedSelectorOptions,
  failClosedReason,
  isSecretKey,
  pinFromSummary,
  sanitizeSpec,
  stripSecrets,
} from "./ops-config.ts";
import type {
  OpsConfigKind,
  OpsConfigPin,
  OpsConfigSpec,
  OpsConfigSummary,
} from "./ops-config-types.ts";

export type AuthorizedKubernetesResult<T> = {
  options: T[];
  closed: boolean;
  reason: string | null;
  strippedKeys: string[];
};

export function isKubernetesActionType(type: string): boolean {
  return (KUBERNETES_ACTION_TYPES as readonly string[]).includes(type);
}

export function isKubernetesPolicySpec(spec: OpsConfigSpec | undefined): boolean {
  return (spec?.kind ?? KUBERNETES_POLICY_KIND) === KUBERNETES_POLICY_KIND;
}

export function leastPrivilegeNotes(): readonly string[] {
  return KUBERNETES_LEAST_PRIVILEGE_NOTES;
}

export function sanitizeKubernetesSpec(raw: unknown): OpsConfigSpec {
  const stripped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const cleaned = stripSecrets(raw as Record<string, unknown>, stripped);
  return sanitizeSpec(cleaned);
}

export function kubernetesSecretKeysIn(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...kubernetesSecretKeysIn(item, `${path}[${index}]`));
    });
    return found;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (isSecretKey(key)) {
      found.push(next);
      continue;
    }
    found.push(...kubernetesSecretKeysIn(item, next));
  }
  return found;
}

export function parseKubernetesPolicy(
  spec: OpsConfigSpec | Record<string, unknown> | undefined,
): KubernetesPolicyBody {
  const policy = asRecord(spec?.policy ?? spec);
  const namespaces = stringList(
    policy.allowedNamespaces ?? policy.namespaces,
  );
  const kinds = stringList(policy.allowedKinds ?? policy.kinds);
  const verbs = stringList(policy.allowedVerbs ?? policy.verbs);
  const operations = stringList(policy.operations);
  return {
    allowedNamespaces: namespaces,
    allowedKinds: kinds.filter((kind) =>
      (KUBERNETES_ALLOWED_KINDS as readonly string[]).includes(kind),
    ),
    allowedVerbs: verbs.filter((verb) =>
      (KUBERNETES_ALLOWED_VERBS as readonly string[]).includes(verb),
    ),
    requireApproval: policy.requireApproval === true,
    operations,
    approverRole:
      typeof policy.approverRole === "string" ? policy.approverRole : undefined,
    expiresIn: typeof policy.expiresIn === "string" ? policy.expiresIn : undefined,
    deny: policy.deny === true,
  };
}

/** Omit empty allowlists so POST /policies does not 400 (fail-closed). */
export function writeKubernetesPolicy(
  body: KubernetesPolicyBody,
): Record<string, unknown> {
  const policy: Record<string, unknown> = {};
  if (body.allowedNamespaces.length > 0) {
    policy.allowedNamespaces = [...body.allowedNamespaces];
  }
  if (body.allowedKinds.length > 0) {
    policy.allowedKinds = [...body.allowedKinds];
  }
  if (body.allowedVerbs.length > 0) {
    policy.allowedVerbs = [...body.allowedVerbs];
  }
  if (body.requireApproval) {
    policy.requireApproval = true;
  }
  if (body.operations.length > 0) {
    policy.operations = [...body.operations];
  }
  if (body.approverRole?.trim()) {
    policy.approverRole = body.approverRole.trim();
  }
  if (body.expiresIn?.trim()) {
    policy.expiresIn = body.expiresIn.trim();
  }
  if (body.deny) {
    policy.deny = true;
  }
  return policy;
}

export function kubernetesPolicyPublishGap(
  policy: KubernetesPolicyBody,
): string | null {
  if (policy.deny) {
    return null;
  }
  if (policy.allowedNamespaces.length === 0) {
    return "Publish requires a non-empty allowedNamespaces list unless deny=true.";
  }
  return null;
}

export function clusterTargetPublishGap(spec: OpsConfigSpec): string | null {
  const cred = String(spec.credentialId ?? "").trim();
  if (!cred) {
    return "Publish requires spec.credentialId (workspace kubernetes vault).";
  }
  const endpoint = spec.endpoint;
  const apiServer =
    endpoint && typeof endpoint === "object"
      ? String(endpoint.apiServer ?? "").trim()
      : "";
  const tlsName =
    endpoint && typeof endpoint === "object"
      ? String(endpoint.tlsServerName ?? "").trim()
      : "";
  if (!apiServer && !tlsName) {
    return "Publish requires endpoint.apiServer or endpoint.tlsServerName.";
  }
  return null;
}

export function hostSuppliedIdentityKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const rec = value as Record<string, unknown>;
  const hits: string[] = [];
  if (rec.id !== undefined) {
    hits.push("id");
  }
  if (rec.workspaceId !== undefined) {
    hits.push("workspaceId");
  }
  return hits;
}

export function hostSuppliedIdentityProblem(
  keys: string[],
  instance = "",
  requestId = "client",
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:invalid-request",
    title: "Host-supplied identity is not allowed",
    status: 400,
    detail: `${HOST_SUPPLIED_IDENTITY_DETAIL} Found: ${keys.join(", ")}.`,
    instance,
    code: KUBERNETES_PROBLEM_CODES.invalidRequest,
    request_id: requestId,
  };
}

export function parseKubernetesEngineCatalog(
  raw: unknown,
): KubernetesEngineCatalog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const kinds = stringList(rec.allowedKinds);
  const verbs = stringList(rec.allowedVerbs);
  const keysRaw = rec.evaluationKeys;
  const evaluationKeys: KubernetesEvaluationKey[] = [];
  if (Array.isArray(keysRaw)) {
    for (const item of keysRaw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const canonical = String(row.canonical ?? "").trim();
      if (!canonical) {
        continue;
      }
      evaluationKeys.push({
        canonical,
        aliases: stringList(row.aliases),
        failClosedWhenPresent: row.failClosedWhenPresent === true,
        requiredForPublish: row.requiredForPublish === true,
      });
    }
  }
  const saRaw = rec.serviceAccount;
  const sa =
    saRaw && typeof saRaw === "object" && !Array.isArray(saRaw)
      ? (saRaw as Record<string, unknown>)
      : {};
  const rulesRaw = rec.publishRules;
  const rules =
    rulesRaw && typeof rulesRaw === "object" && !Array.isArray(rulesRaw)
      ? (rulesRaw as Record<string, unknown>)
      : {};
  return {
    credentialType: String(rec.credentialType ?? KUBERNETES_CREDENTIAL_TYPE),
    credentialSecretField:
      String(rec.credentialSecretField ?? "kubeconfig").trim() || "kubeconfig",
    allowedKinds: kinds.length > 0 ? kinds : [...KUBERNETES_ALLOWED_KINDS],
    allowedVerbs: verbs.length > 0 ? verbs : [...KUBERNETES_ALLOWED_VERBS],
    evaluationKeys,
    serviceAccount: {
      defaultName: String(sa.defaultName ?? "").trim(),
      roleTemplate: String(sa.roleTemplate ?? "").trim(),
      roleTemplatePath: String(sa.roleTemplatePath ?? "").trim() || undefined,
      roleBindingTemplatePath:
        String(sa.roleBindingTemplatePath ?? "").trim() || undefined,
      serviceAccountPath: String(sa.serviceAccountPath ?? "").trim() || undefined,
      clusterRoles: sa.clusterRoles === true,
      notes: String(sa.notes ?? "").trim() || undefined,
    },
    publishRules: {
      clusterTargetRequired: stringList(rules.clusterTargetRequired),
      kubernetesPolicyRequired: stringList(rules.kubernetesPolicyRequired),
      emptyAllowlistsRejected: rules.emptyAllowlistsRejected !== false,
      credentialType: String(
        rules.credentialType ?? KUBERNETES_CREDENTIAL_TYPE,
      ),
      denyAllowsMissingAllowlist: rules.denyAllowsMissingAllowlist === true,
    },
    clusterRoles: rec.clusterRoles === true,
    nodes: parseEngineNodes(rec.nodes),
    errors: parseEngineErrors(rec.errors),
    apply: parseEngineApply(rec.apply),
  };
}

function parseEngineNodes(raw: unknown): KubernetesEngineNodeContract[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const nodes: KubernetesEngineNodeContract[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const type = String(row.type ?? "").trim();
    if (!type) {
      continue;
    }
    const allowedWith: KubernetesEngineNodeContract["allowedWith"] = [];
    if (Array.isArray(row.allowedWith)) {
      for (const field of row.allowedWith) {
        if (!field || typeof field !== "object" || Array.isArray(field)) {
          continue;
        }
        const spec = field as Record<string, unknown>;
        const name = String(spec.name ?? "").trim();
        if (!name) {
          continue;
        }
        allowedWith.push({
          name,
          kind: String(spec.kind ?? "string"),
          required: spec.required === true,
          enum: stringList(spec.enum),
          description: String(spec.description ?? "").trim() || undefined,
        });
      }
    }
    nodes.push({
      type,
      verb: String(row.verb ?? "").trim(),
      title: String(row.title ?? type),
      description: String(row.description ?? ""),
      permissions: stringList(row.permissions),
      requiredWith: stringList(row.requiredWith),
      allowedWith,
      outputs: stringList(row.outputs),
      sideEffects: row.sideEffects === true,
      retrySafe: row.retrySafe === true,
      idempotent: row.idempotent === true,
      fieldManager: String(row.fieldManager ?? "").trim() || undefined,
      force: typeof row.force === "boolean" ? row.force : undefined,
      serverDryRunAlways: row.serverDryRunAlways === true ? true : undefined,
      waitReady: String(row.waitReady ?? "").trim() || undefined,
    });
  }
  return nodes;
}

function parseEngineErrors(raw: unknown): KubernetesEngineErrorShape[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const errors: KubernetesEngineErrorShape[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const code = String(row.code ?? "").trim();
    if (!code) {
      continue;
    }
    errors.push({
      code,
      status: Number(row.status) || 0,
      meaning: String(row.meaning ?? "").trim(),
    });
  }
  return errors;
}

function parseEngineApply(raw: unknown): KubernetesEngineApplyRules {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    fieldManager: String(rec.fieldManager ?? "flowforge").trim() || "flowforge",
    force: rec.force === true,
    serverDryRunAlways: rec.serverDryRunAlways !== false,
    clientDryRunAddsLocalValidationOnly:
      rec.clientDryRunAddsLocalValidationOnly !== false,
    waitReady: String(rec.waitReady ?? "deferred-e7.3").trim() || "deferred-e7.3",
  };
}

export function applyKubernetesPolicyToSpec(
  spec: OpsConfigSpec,
  body: KubernetesPolicyBody,
): OpsConfigSpec {
  return sanitizeKubernetesSpec({
    ...spec,
    kind: KUBERNETES_POLICY_KIND,
    policy: writeKubernetesPolicy(body),
  });
}

/**
 * Published cluster targets only. 403 / empty fail closed.
 * When the API reports credentialId, require a workspace vault bind.
 * Specs are secret-stripped — kubeconfig never reaches the selector.
 */
export function authorizedClusterTargets(input: {
  items?: OpsConfigSummary[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): AuthorizedKubernetesResult<OpsConfigPin> {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: failClosedReason(input.problem, input.statusCode),
      strippedKeys: [],
    };
  }
  const reportsCredential = (input.items ?? []).some(
    (item) => item.credentialId !== undefined,
  );
  const strippedKeys: string[] = [];
  const pins: OpsConfigPin[] = [];
  for (const item of input.items ?? []) {
    if (item.kind && item.kind !== "cluster_target") {
      continue;
    }
    if (item.status === "disabled") {
      continue;
    }
    if (reportsCredential && !item.credentialId) {
      continue;
    }
    const pin = pinFromSummary(item);
    if (!pin) {
      continue;
    }
    if (pin.spec) {
      const keys = kubernetesSecretKeysIn(pin.spec);
      strippedKeys.push(...keys);
      pin.spec = sanitizeKubernetesSpec(pin.spec);
    }
    pins.push(pin);
  }
  const selected = authorizedSelectorOptions({
    items: pins,
    statusCode: 200,
  });
  if (selected.closed) {
    return {
      options: [],
      closed: true,
      reason: selected.reason ?? KUBERNETES_FAIL_CLOSED_HELP,
      strippedKeys,
    };
  }
  return {
    options: selected.options,
    closed: false,
    reason: null,
    strippedKeys,
  };
}

export function authorizedKubernetesPolicies(input: {
  items?: OpsConfigSummary[] | null;
  pins?: OpsConfigPin[] | null;
  problem?: ProblemDetails | null;
  statusCode?: number;
}): AuthorizedKubernetesResult<OpsConfigPin> {
  if (input.problem || (input.statusCode && input.statusCode >= 400)) {
    return {
      options: [],
      closed: true,
      reason: failClosedReason(input.problem, input.statusCode),
      strippedKeys: [],
    };
  }
  const strippedKeys: string[] = [];
  const fromPins = (input.pins ?? []).filter((pin) => {
    if (pin.kind !== "policy") {
      return false;
    }
    if (pin.spec && !isKubernetesPolicySpec(pin.spec)) {
      return false;
    }
    if (pin.spec) {
      strippedKeys.push(...kubernetesSecretKeysIn(pin.spec));
    }
    return true;
  });
  const fromList = (input.items ?? [])
    .filter((item) => item.kind === "policy" && item.status !== "disabled")
    .map(pinFromSummary)
    .filter((pin): pin is OpsConfigPin => pin !== null);
  const merged = fromPins.length > 0 ? fromPins : fromList;
  const selected = authorizedSelectorOptions({
    items: merged.map((pin) =>
      pin.spec
        ? { ...pin, spec: sanitizeKubernetesSpec(pin.spec) }
        : pin,
    ),
    statusCode: 200,
  });
  if (selected.closed) {
    return {
      options: [],
      closed: true,
      reason: selected.reason ?? KUBERNETES_FAIL_CLOSED_HELP,
      strippedKeys,
    };
  }
  return {
    options: selected.options,
    closed: false,
    reason: null,
    strippedKeys,
  };
}

export function clusterTargetSelectorLabel(pin: OpsConfigPin): string {
  const name = (pin.name ?? "cluster target").trim() || "cluster target";
  const version =
    typeof pin.versionNumber === "number" ? `v${pin.versionNumber}` : "unpinned";
  return `${name} @ ${version}`;
}

export function kubernetesPolicyGaps(body: KubernetesPolicyBody): string[] {
  const gaps: string[] = [];
  const publishGap = kubernetesPolicyPublishGap(body);
  if (publishGap) {
    gaps.push(publishGap);
  } else if (body.allowedNamespaces.length === 0) {
    gaps.push("No namespaces allowlisted — evaluation fails closed.");
  }
  if (body.allowedKinds.length === 0) {
    gaps.push("No resource kinds allowlisted — evaluation fails closed.");
  }
  if (body.allowedVerbs.length === 0) {
    gaps.push("No verbs allowlisted — evaluation fails closed.");
  }
  if (body.requireApproval && body.operations.length === 0) {
    gaps.push("Approval is required but no operations are listed.");
  }
  return gaps;
}

export function kubernetesOpsKind(
  kind: OpsConfigKind | string | undefined,
): kind is "cluster_target" | "policy" {
  return kind === "cluster_target" || kind === "policy";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
