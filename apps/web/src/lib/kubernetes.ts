/**
 * E7.1 cluster-target + Kubernetes policy helpers.
 * Authorized selectors fail closed on 403. Unexpected kubeconfig /
 * secret fields are stripped and never shown.
 */

import {
  KUBERNETES_FAIL_CLOSED_HELP,
  KUBERNETES_LEAST_PRIVILEGE_NOTES,
} from "./kubernetes-contract.ts";
import {
  KUBERNETES_ACTION_TYPES,
  KUBERNETES_ALLOWED_KINDS,
  KUBERNETES_ALLOWED_VERBS,
  KUBERNETES_POLICY_KIND,
  type KubernetesPolicyBody,
} from "./kubernetes-types.ts";
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
import type { ProblemDetails } from "./problem.ts";

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

export function writeKubernetesPolicy(
  body: KubernetesPolicyBody,
): Record<string, unknown> {
  const policy: Record<string, unknown> = {
    allowedNamespaces: body.allowedNamespaces,
    allowedKinds: body.allowedKinds,
    allowedVerbs: body.allowedVerbs,
    requireApproval: body.requireApproval,
    operations: body.operations,
  };
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
  if (body.allowedNamespaces.length === 0) {
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
