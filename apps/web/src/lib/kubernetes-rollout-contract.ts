/**
 * Single retarget adapter for Chloe's E7.3 Kubernetes rollout
 * status UI. Prefer GET /workflows/catalog + GET /kubernetes/catalog
 * (`nodes[]`, `apply.waitReady`) when present. Until jonny's
 * status/contract map lands, fallback entries stay marked
 * `contract-fallback`.
 *
 * Consumes existing execution detail / steps / jobs / audit (E5).
 * Cookie session + CSRF; JSON camelCase; RFC 9457.
 * Do not invent routes. Do not change `apps/api`.
 *
 * Relates to #72 / Part of #69. Keep #72 open — jonny owns
 * observation + audit.
 */

import { isSecretFieldName, stripSecretFields } from "./execution.ts";
import type {
  ExecutionAuditEvent,
  ExecutionStep,
} from "./execution-types.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";

export const KUBERNETES_ROLLOUT_STORY = 72;
export const KUBERNETES_ROLLOUT_EPIC = 69;
/** 0 until jonny's E7.3 status/contract map lands on main. */
export const KUBERNETES_ROLLOUT_API_PR = 0;
export const KUBERNETES_ROLLOUT_ROUTE_MAP_SOURCE =
  "e73-pending-jonny-map" as const;

export const KUBERNETES_ROLLOUT_NODE_TYPE = "kubernetes.rolloutStatus" as const;
export const KUBERNETES_ROLLOUT_VERB = "watch" as const;

export const KUBERNETES_OBSERVATION_DEFERRED = "deferred-e7.3" as const;
/** Fallback token when the catalog still says deferred-e7.3. */
export const KUBERNETES_OBSERVATION_WATCH = "watch" as const;

export const KUBERNETES_ROLLOUT_KINDS = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
] as const;

export type KubernetesRolloutKind = (typeof KUBERNETES_ROLLOUT_KINDS)[number];

/**
 * Engine-doc recognition — retarget when jonny posts the status map.
 */
export const KUBERNETES_ROLLOUT_RECOGNITION = {
  Deployment: "availability + observed generation",
  StatefulSet: "ready replicas",
  DaemonSet: "updated/available counts",
  Job: "completion/failure",
} as const;

export const KUBERNETES_ROLLOUT_PHASES = [
  "watching",
  "ready",
  "failed",
  "timeout",
  "canceled",
  "pending-engine",
] as const;

export type KubernetesRolloutPhase = (typeof KUBERNETES_ROLLOUT_PHASES)[number];

export const KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE =
  "Timeout or cancel stops waiting. It never deletes or rolls back cluster resources.";

export const KUBERNETES_ROLLOUT_CANCEL_HELP =
  "Cancel stops rollout observation only. Waiting ends; applied resources are left as they are — no delete and no rollback.";

export const KUBERNETES_ROLLOUT_TIMEOUT_HELP =
  "Bounded timeoutSeconds elapsed. Waiting stopped. Resources were not deleted or rolled back.";

export const KUBERNETES_ROLLOUT_REDACTION_HELP =
  "Results are redacted diagnostics only. Secrets, kubeconfigs, and unexpected secret field names are stripped and treated as a contract bug.";

export const KUBERNETES_ROLLOUT_KIND_MESSAGE =
  "kind must be Deployment, StatefulSet, DaemonSet, or Job.";

export const KUBERNETES_ROLLOUT_NAME_MESSAGE =
  "name is required for kubernetes.rolloutStatus.";

export type RolloutObservationSource = "catalog" | "contract-fallback";

export type RolloutObservationMode = {
  live: boolean;
  token: string;
  source: RolloutObservationSource;
};

export type KubernetesRolloutResource = {
  kind: string;
  name: string;
  namespace: string;
  uid?: string;
};

export type KubernetesRolloutAuditSnapshot = {
  actorId: string;
  clusterTargetId: string;
  policyRevision: string;
  resources: KubernetesRolloutResource[];
  correlationId: string;
  action: string;
  outcome: string;
  occurredAt: string;
  source: RolloutObservationSource;
};

export type KubernetesRolloutObservation = {
  stepId: string;
  nodeId: string;
  nodeType: string;
  kind: string;
  name: string;
  namespace: string;
  clusterTargetId: string;
  phase: KubernetesRolloutPhase;
  phaseLabel: string;
  recognition: string;
  observation: string;
  wait: string;
  timeoutSeconds: number | null;
  availableReplicas: number | null;
  readyReplicas: number | null;
  updatedNumber: number | null;
  desiredNumber: number | null;
  observedGeneration: number | null;
  generation: number | null;
  succeeded: number | null;
  failed: number | null;
  completions: number | null;
  stopReason: "timeout" | "canceled" | "ready" | "failed" | "";
  stopCopy: string;
  note: string;
  resources: KubernetesRolloutResource[];
  correlationId: string;
  policyRevision: string;
  actorId: string;
  source: RolloutObservationSource;
  strippedKeys: string[];
  failedClosed: boolean;
};

export function isKubernetesRolloutType(type: string): boolean {
  return type === KUBERNETES_ROLLOUT_NODE_TYPE;
}

export function isKubernetesRolloutKind(
  kind: string,
): kind is KubernetesRolloutKind {
  return (KUBERNETES_ROLLOUT_KINDS as readonly string[]).includes(kind);
}

export function recognitionForKind(kind: string): string {
  if (kind === "Deployment") {
    return KUBERNETES_ROLLOUT_RECOGNITION.Deployment;
  }
  if (kind === "StatefulSet") {
    return KUBERNETES_ROLLOUT_RECOGNITION.StatefulSet;
  }
  if (kind === "DaemonSet") {
    return KUBERNETES_ROLLOUT_RECOGNITION.DaemonSet;
  }
  if (kind === "Job") {
    return KUBERNETES_ROLLOUT_RECOGNITION.Job;
  }
  return "bounded observation of an allowlisted workload";
}

export function recognitionSummary(): string {
  return "Deployment: availability + observed generation; StatefulSet: ready replicas; DaemonSet: updated/available counts; Job: completion/failure";
}

/**
 * Catalog `apply.waitReady` / rollout node `waitReady` still say
 * deferred-e7.3 on main. E7.3 UI fallback treats wait=ready as a
 * real observation once this story lands. When jonny's map posts a
 * non-deferred token, drop the fallback marker.
 */
export function observationModeFromCatalog(
  catalog?: KubernetesEngineCatalog | null,
): RolloutObservationMode {
  const node = catalog?.nodes.find((item) =>
    isKubernetesRolloutType(item.type),
  );
  const token = String(
    node?.waitReady || catalog?.apply?.waitReady || "",
  ).trim();
  if (token && token !== KUBERNETES_OBSERVATION_DEFERRED) {
    return { live: true, token, source: "catalog" };
  }
  return {
    live: true,
    token: KUBERNETES_OBSERVATION_WATCH,
    source: "contract-fallback",
  };
}

export function observationIsLive(
  catalog?: KubernetesEngineCatalog | null,
): boolean {
  return observationModeFromCatalog(catalog).live;
}

export function effectiveWaitReady(
  catalog?: KubernetesEngineCatalog | null,
): string {
  return observationModeFromCatalog(catalog).token;
}

export function rolloutWaitReadyMessage(
  catalog?: KubernetesEngineCatalog | null,
): string {
  const mode = observationModeFromCatalog(catalog);
  const base = `wait=ready starts a bounded rollout observation (${recognitionSummary()}). ${KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}`;
  if (mode.source === "contract-fallback") {
    return `${base} Observation map is contract-fallback until jonny's status contract lands.`;
  }
  return base;
}

export function rolloutNodeDescription(
  catalog?: KubernetesEngineCatalog | null,
): string {
  const mode = observationModeFromCatalog(catalog);
  const base =
    "Bounded watch of Deployment, StatefulSet, DaemonSet, or Job progress. Timeout or cancel stops waiting — never delete or rollback.";
  if (mode.source === "contract-fallback") {
    return `${base} contract-fallback until jonny's status/contract map.`;
  }
  return base;
}

export function rolloutKindsFromCatalog(
  catalog?: KubernetesEngineCatalog | null,
): readonly string[] {
  const allowed = catalog?.allowedKinds?.length
    ? catalog.allowedKinds
    : [...KUBERNETES_ROLLOUT_KINDS];
  const filtered = allowed.filter((kind) => isKubernetesRolloutKind(kind));
  return filtered.length > 0 ? filtered : [...KUBERNETES_ROLLOUT_KINDS];
}

export function phaseLabel(phase: KubernetesRolloutPhase): string {
  switch (phase) {
    case "watching":
      return "Watching rollout";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "timeout":
      return "Timed out";
    case "canceled":
      return "Canceled";
    case "pending-engine":
      return "Waiting for engine observation";
    default:
      return phase;
  }
}

export function stopCopyForPhase(phase: KubernetesRolloutPhase): string {
  if (phase === "timeout") {
    return KUBERNETES_ROLLOUT_TIMEOUT_HELP;
  }
  if (phase === "canceled") {
    return KUBERNETES_ROLLOUT_CANCEL_HELP;
  }
  return KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE;
}

/**
 * Redact observation / audit payloads. Unexpected secret keys are
 * stripped (fail closed). Never returns kubeconfig.
 */
export function redactRolloutPayload(value: unknown): {
  value: unknown;
  strippedKeys: string[];
  failedClosed: boolean;
} {
  const strippedKeys: string[] = [];
  const cleaned = stripSecretFields(value, strippedKeys);
  const failedClosed =
    leftoverSecretKeys(cleaned).length > 0 ||
    strippedKeys.some((key) => {
      const leaf = key.split(".").pop() ?? key;
      return isSecretFieldName(leaf);
    });
  if (failedClosed) {
    return {
      value: { redacted: true, reason: "secret-field-stripped" },
      strippedKeys,
      failedClosed: true,
    };
  }
  return { value: cleaned, strippedKeys, failedClosed: false };
}

export function leftoverSecretKeys(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      leftoverSecretKeys(item, `${path}[${index}]`),
    );
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (isSecretFieldName(key)) {
      found.push(next);
    }
    found.push(...leftoverSecretKeys(child, next));
  }
  return found;
}

export function executionHasRolloutObservation(
  steps: readonly Pick<ExecutionStep, "nodeType" | "output" | "input">[],
): boolean {
  return steps.some((step) => isRolloutRelatedStep(step));
}

export function isRolloutRelatedStep(step: {
  nodeType?: string;
  output?: unknown;
  input?: unknown;
}): boolean {
  if (isKubernetesRolloutType(step.nodeType ?? "")) {
    return true;
  }
  if (step.nodeType === "kubernetes.apply") {
    const bag = mergeBags(asRecord(step.output), asRecord(step.input));
    const wait = String(bag.wait ?? "").trim();
    const observation = String(
      bag.observation ?? asRecord(bag.status)?.observation ?? "",
    ).trim();
    return wait === "ready" || Boolean(observation);
  }
  return false;
}

export function collectRolloutObservations(input: {
  steps?: readonly ExecutionStep[] | null;
  auditEvents?: readonly ExecutionAuditEvent[] | null;
  catalog?: KubernetesEngineCatalog | null;
}): KubernetesRolloutObservation[] {
  const mode = observationModeFromCatalog(input.catalog);
  const observations: KubernetesRolloutObservation[] = [];
  for (const step of input.steps ?? []) {
    if (!isRolloutRelatedStep(step)) {
      continue;
    }
    observations.push(
      parseRolloutObservation(step, input.auditEvents ?? [], mode),
    );
  }
  return observations;
}

export function parseRolloutObservation(
  step: ExecutionStep,
  auditEvents: readonly ExecutionAuditEvent[] = [],
  mode: RolloutObservationMode = observationModeFromCatalog(null),
): KubernetesRolloutObservation {
  const redactedOutput = redactRolloutPayload(step.output);
  const redactedInput = redactRolloutPayload(step.input);
  const redactedError = redactRolloutPayload(step.error);
  const bag = mergeBags(
    asRecord(redactedOutput.value),
    asRecord(asRecord(redactedOutput.value)?.result),
    asRecord(asRecord(redactedOutput.value)?.status),
    asRecord(redactedInput.value),
    asRecord(asRecord(redactedInput.value)?.with),
    asRecord(redactedError.value),
  );
  const kind = String(bag.kind ?? firstResource(bag)?.kind ?? "").trim();
  const name = String(bag.name ?? firstResource(bag)?.name ?? "").trim();
  const namespace = String(
    bag.namespace ?? firstResource(bag)?.namespace ?? "",
  ).trim();
  const observation = String(
    bag.observation ?? mode.token,
  ).trim() || mode.token;
  const phase = inferPhase(bag, step.status, observation);
  const snapshot = auditSnapshotForStep(step, auditEvents, bag);
  const strippedKeys = unique([
    ...redactedOutput.strippedKeys,
    ...redactedInput.strippedKeys,
    ...redactedError.strippedKeys,
    ...snapshot.strippedKeys,
  ]);
  const failedClosed =
    redactedOutput.failedClosed ||
    redactedInput.failedClosed ||
    redactedError.failedClosed ||
    snapshot.failedClosed;
  const stopReason = stopReasonFor(phase);
  return {
    stepId: step.id,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    kind,
    name,
    namespace,
    clusterTargetId: String(
      bag.clusterTargetId ?? snapshot.snapshot.clusterTargetId,
    ).trim(),
    phase,
    phaseLabel: phaseLabel(phase),
    recognition: recognitionForKind(kind),
    observation,
    wait: String(bag.wait ?? "ready").trim() || "ready",
    timeoutSeconds: numberOrNull(bag.timeoutSeconds),
    availableReplicas: numberOrNull(
      bag.availableReplicas ?? bag.available,
    ),
    readyReplicas: numberOrNull(bag.readyReplicas ?? bag.ready),
    updatedNumber: numberOrNull(bag.updatedNumber ?? bag.updated),
    desiredNumber: numberOrNull(bag.desiredNumber ?? bag.desired),
    observedGeneration: numberOrNull(bag.observedGeneration),
    generation: numberOrNull(bag.generation),
    succeeded: numberOrNull(bag.succeeded),
    failed: numberOrNull(bag.failed),
    completions: numberOrNull(bag.completions ?? bag.completion),
    stopReason,
    stopCopy: stopCopyForPhase(phase),
    note: String(bag.observationNote ?? bag.note ?? "").trim(),
    resources: resourcesFrom(bag, snapshot.snapshot.resources),
    correlationId:
      String(bag.correlationId ?? snapshot.snapshot.correlationId).trim() ||
      "",
    policyRevision:
      String(bag.policyRevision ?? snapshot.snapshot.policyRevision).trim() ||
      "",
    actorId: snapshot.snapshot.actorId,
    source: mode.source,
    strippedKeys,
    failedClosed,
  };
}

export function collectRolloutAuditSnapshots(
  events: readonly ExecutionAuditEvent[] | null | undefined,
): KubernetesRolloutAuditSnapshot[] {
  return (events ?? [])
    .filter((event) => isRolloutAuditAction(event.action))
    .map((event) => redactAuditSnapshot(event).snapshot);
}

export function auditSnapshotForStep(
  step: ExecutionStep,
  events: readonly ExecutionAuditEvent[],
  bag: Record<string, unknown> = {},
): {
  snapshot: KubernetesRolloutAuditSnapshot;
  strippedKeys: string[];
  failedClosed: boolean;
} {
  const match =
    events.find(
      (event) =>
        isRolloutAuditAction(event.action) &&
        (event.resourceId === step.id ||
          event.resourceId === step.nodeId ||
          event.correlationId === String(bag.correlationId ?? "")),
    ) ?? events.find((event) => isRolloutAuditAction(event.action));
  if (match) {
    return redactAuditSnapshot(match, bag);
  }
  return {
    snapshot: {
      actorId: "",
      clusterTargetId: String(bag.clusterTargetId ?? "").trim(),
      policyRevision: String(bag.policyRevision ?? "").trim(),
      resources: resourcesFrom(bag, []),
      correlationId: String(bag.correlationId ?? "").trim(),
      action: "",
      outcome: "",
      occurredAt: "",
      source: "contract-fallback",
    },
    strippedKeys: [],
    failedClosed: false,
  };
}

export function isRolloutAuditAction(action: string): boolean {
  const folded = action.toLowerCase();
  return (
    folded.includes("rollout") ||
    folded.includes("kubernetes.watch") ||
    folded.includes("kubernetes.rollout") ||
    folded.includes("observation")
  );
}

function redactAuditSnapshot(
  event: ExecutionAuditEvent,
  bag: Record<string, unknown> = {},
): {
  snapshot: KubernetesRolloutAuditSnapshot;
  strippedKeys: string[];
  failedClosed: boolean;
} {
  const rawDetails = asRecord(event.details) ?? {};
  const identities = pickSafeAuditIdentities(rawDetails);
  const redacted = redactRolloutPayload(event.details);
  const details = asRecord(redacted.value) ?? {};
  const resources = resourcesFrom(
    redacted.failedClosed ? identities : details,
    resourcesFrom(bag, identities.resources),
  );
  return {
    snapshot: {
      actorId: String(
        event.actorId || details.actorId || rawDetails.actorId || details.actor || "",
      ).trim(),
      clusterTargetId: String(
        details.clusterTargetId ||
          identities.clusterTargetId ||
          bag.clusterTargetId ||
          "",
      ).trim(),
      policyRevision: String(
        details.policyRevision ||
          identities.policyRevision ||
          details.policyId ||
          bag.policyRevision ||
          "",
      ).trim(),
      resources,
      correlationId: String(
        event.correlationId || details.correlationId || bag.correlationId || "",
      ).trim(),
      action: event.action,
      outcome: event.outcome,
      occurredAt: event.occurredAt,
      source: "contract-fallback",
    },
    strippedKeys: redacted.strippedKeys,
    failedClosed: redacted.failedClosed,
  };
}

/** Allowlisted identity fields only — never secret-bearing keys. */
function pickSafeAuditIdentities(
  details: Record<string, unknown>,
): {
  clusterTargetId: string;
  policyRevision: string;
  resources: KubernetesRolloutResource[];
} {
  return {
    clusterTargetId: String(details.clusterTargetId ?? "").trim(),
    policyRevision: String(details.policyRevision ?? "").trim(),
    resources: resourcesFrom(details, []),
  };
}

function inferPhase(
  bag: Record<string, unknown>,
  stepStatus: string,
  observation: string,
): KubernetesRolloutPhase {
  const explicit = String(bag.phase ?? bag.observationPhase ?? "").trim().toLowerCase();
  if (explicit === "timeout" || explicit === "timedout" || explicit === "timed-out") {
    return "timeout";
  }
  if (explicit === "canceled" || explicit === "cancelled") {
    return "canceled";
  }
  if (explicit === "failed" || explicit === "failure") {
    return "failed";
  }
  if (explicit === "ready" || explicit === "complete" || explicit === "succeeded") {
    return "ready";
  }
  if (explicit === "watching" || explicit === "progressing") {
    return "watching";
  }
  if (bag.timedOut === true || bag.timeout === true) {
    return "timeout";
  }
  if (bag.canceled === true || bag.cancelled === true) {
    return "canceled";
  }
  const status = String(stepStatus ?? "").toLowerCase();
  if (status === "canceled") {
    return "canceled";
  }
  if (status === "failed") {
    return "failed";
  }
  if (observation === KUBERNETES_OBSERVATION_DEFERRED) {
    return "pending-engine";
  }
  if (status === "succeeded") {
    return "ready";
  }
  if (status === "running" || status === "queued" || status === "pinned") {
    return "watching";
  }
  return "watching";
}

function stopReasonFor(
  phase: KubernetesRolloutPhase,
): KubernetesRolloutObservation["stopReason"] {
  if (phase === "timeout" || phase === "canceled" || phase === "ready" || phase === "failed") {
    return phase;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function mergeBags(
  ...bags: Array<Record<string, unknown> | null>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const bag of bags) {
    if (!bag) {
      continue;
    }
    for (const [key, value] of Object.entries(bag)) {
      if (value !== undefined && value !== null && value !== "") {
        out[key] = value;
      }
    }
  }
  return out;
}

function firstResource(
  bag: Record<string, unknown>,
): KubernetesRolloutResource | null {
  const list = resourcesFrom(bag, []);
  return list[0] ?? null;
}

function resourcesFrom(
  bag: Record<string, unknown>,
  extra: KubernetesRolloutResource[],
): KubernetesRolloutResource[] {
  const raw = bag.resources ?? bag.resourceIdentities ?? bag.items;
  const fromBag: KubernetesRolloutResource[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const rec = asRecord(item);
      if (!rec) {
        continue;
      }
      const meta = asRecord(rec.metadata);
      const kind = String(rec.kind ?? "").trim();
      const name = String(rec.name ?? meta?.name ?? "").trim();
      const namespace = String(rec.namespace ?? meta?.namespace ?? "").trim();
      if (!kind && !name) {
        continue;
      }
      const uid = String(rec.uid ?? rec.id ?? "").trim();
      fromBag.push({
        kind,
        name,
        namespace,
        ...(uid ? { uid } : {}),
      });
    }
  }
  const merged = [...fromBag, ...extra];
  const seen = new Set<string>();
  return merged.filter((item) => {
    const key = `${item.kind}/${item.namespace}/${item.name}/${item.uid ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
