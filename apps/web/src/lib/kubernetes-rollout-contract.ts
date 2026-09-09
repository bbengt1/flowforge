/**
 * Single retarget adapter for Chloe's E7.3 Kubernetes rollout
 * status UI. Wired to jonny's **#79** map on `main`:
 * GET /workflows/catalog + GET /kubernetes/catalog
 * (`nodes[]`, `apply.waitReady`, `observation`).
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
/** Jonny's E7.3 observation map on main. */
export const KUBERNETES_ROLLOUT_API_PR = 79;
export const KUBERNETES_ROLLOUT_ROUTE_MAP_SOURCE = "e73-#79" as const;

export const KUBERNETES_ROLLOUT_NODE_TYPE = "kubernetes.rolloutStatus" as const;
export const KUBERNETES_ROLLOUT_VERB = "watch" as const;

/** Catalog signal that wait=ready performs a bounded watch (#79). */
export const KUBERNETES_WAIT_READY_OBSERVED = "observed" as const;

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
  "ready",
  "failed",
  "timeout",
  "canceled",
  "skipped",
  "progressing",
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
  "kind must be Deployment, StatefulSet, DaemonSet, or Job (or supplied via resource).";

export const KUBERNETES_ROLLOUT_NAME_MESSAGE =
  "name is required for kubernetes.rolloutStatus unless resource.name is set.";

export const KUBERNETES_ROLLOUT_SKIPPED_HELP =
  "Kind is not observable. ConfigMap, Service, CronJob, Ingress, and NetworkPolicy with wait=ready return observation=skipped and do not require watch.";

export const KUBERNETES_ROLLOUT_IDENTITY_HELP =
  "Identify the workload with kind+name, or resource {kind,name}.";

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

export type KubernetesRolloutProgress = {
  kind: string;
  name: string;
  namespace: string;
  generation: number | null;
  observedGeneration: number | null;
  readyReplicas: number | null;
  updatedReplicas: number | null;
  availableReplicas: number | null;
  desiredNumberScheduled: number | null;
  updatedNumberScheduled: number | null;
  numberAvailable: number | null;
  completions: number | null;
  succeeded: number | null;
  failed: number | null;
  state: string;
  reason: string;
};

export type KubernetesRolloutAuditSnapshot = {
  actorId: string;
  operation: string;
  clusterTargetId: string;
  namespace: string;
  policyRevision: string;
  policyDigest: string;
  manifestDigest: string;
  resources: KubernetesRolloutResource[];
  serverDryRun: boolean;
  applied: boolean;
  watch: string;
  observation: string;
  correlationId: string;
  action: string;
  outcome: string;
  errorCode: string;
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
  stopReason: "timeout" | "canceled" | "ready" | "failed" | "skipped" | "";
  stopCopy: string;
  note: string;
  progress: KubernetesRolloutProgress[];
  resources: KubernetesRolloutResource[];
  correlationId: string;
  policyRevision: string;
  policyDigest: string;
  manifestDigest: string;
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

export function rolloutIdentityFromWith(withValue: Record<string, unknown>): {
  kind: string;
  name: string;
} {
  const resource =
    withValue.resource &&
    typeof withValue.resource === "object" &&
    !Array.isArray(withValue.resource)
      ? (withValue.resource as Record<string, unknown>)
      : {};
  return {
    kind: String(withValue.kind ?? resource.kind ?? "").trim(),
    name: String(withValue.name ?? resource.name ?? "").trim(),
  };
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
 * #79 catalog: apply.waitReady and observation.waitReady are
 * `observed`. Prefer those tokens when present.
 */
export function observationModeFromCatalog(
  catalog?: KubernetesEngineCatalog | null,
): RolloutObservationMode {
  const node = catalog?.nodes.find((item) =>
    isKubernetesRolloutType(item.type),
  );
  const token = String(
    catalog?.observation?.waitReady ||
      node?.waitReady ||
      catalog?.apply?.waitReady ||
      "",
  ).trim();
  if (token === KUBERNETES_WAIT_READY_OBSERVED) {
    return { live: true, token, source: "catalog" };
  }
  if (token) {
    return { live: true, token, source: "catalog" };
  }
  return {
    live: true,
    token: KUBERNETES_WAIT_READY_OBSERVED,
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
  const token = effectiveWaitReady(catalog);
  return `wait=ready performs a bounded rollout observation (${recognitionSummary()}). Catalog waitReady=${token}. Non-observable kinds return observation=skipped. ${KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}`;
}

export function rolloutNodeDescription(
  _catalog?: KubernetesEngineCatalog | null,
): string {
  return "Bounded watch of Deployment, StatefulSet, DaemonSet, or Job. Verb is watch and needs kubernetes.read. Identify the workload with kind+name or resource {kind,name}. Timeout or cancel stops waiting — never delete or rollback.";
}

export function rolloutKindsFromCatalog(
  catalog?: KubernetesEngineCatalog | null,
): readonly string[] {
  const fromObservation = catalog?.observation?.kinds?.length
    ? catalog.observation.kinds
    : [...KUBERNETES_ROLLOUT_KINDS];
  const allowed = catalog?.allowedKinds?.length
    ? catalog.allowedKinds
    : fromObservation;
  const filtered = fromObservation.filter(
    (kind) =>
      isKubernetesRolloutKind(kind) &&
      (allowed.length === 0 || allowed.includes(kind)),
  );
  return filtered.length > 0 ? filtered : [...KUBERNETES_ROLLOUT_KINDS];
}

export function phaseLabel(phase: KubernetesRolloutPhase): string {
  switch (phase) {
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "timeout":
      return "Timed out";
    case "canceled":
      return "Canceled";
    case "skipped":
      return "Skipped (not observable)";
    case "progressing":
      return "Progressing";
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
  if (phase === "skipped") {
    return KUBERNETES_ROLLOUT_SKIPPED_HELP;
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
  const output = asRecord(redactedOutput.value);
  const result = asRecord(output?.result) ?? output;
  const status = asRecord(result?.status) ?? asRecord(output?.status);
  const input = asRecord(redactedInput.value);
  const resource = asRecord(input?.resource) ?? asRecord(result?.resource);
  const bag = mergeBags(
    output,
    result,
    status,
    input,
    asRecord(input?.with),
    resource,
    asRecord(redactedError.value),
  );
  const progress = parseProgressList(status?.progress ?? result?.progress ?? bag.progress);
  const firstProgress = progress[0];
  const kind = String(
    bag.kind ?? firstProgress?.kind ?? firstResource(bag)?.kind ?? "",
  ).trim();
  const name = String(
    bag.name ?? firstProgress?.name ?? firstResource(bag)?.name ?? "",
  ).trim();
  const namespace = String(
    bag.namespace ?? firstProgress?.namespace ?? firstResource(bag)?.namespace ?? "",
  ).trim();
  const observation = String(
    result?.observation ?? bag.observation ?? "",
  ).trim();
  const phase = inferPhase(bag, step.status, observation);
  const resultAudit = snapshotFromResultAudit(
    asRecord(result?.audit) ?? asRecord(output?.audit),
    bag,
  );
  const snapshot = resultAudit ?? auditSnapshotForStep(step, auditEvents, bag);
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
      firstProgress?.availableReplicas ?? bag.availableReplicas ?? bag.available,
    ),
    readyReplicas: numberOrNull(
      firstProgress?.readyReplicas ?? bag.readyReplicas ?? bag.ready,
    ),
    updatedNumber: numberOrNull(
      firstProgress?.updatedNumberScheduled ??
        firstProgress?.updatedReplicas ??
        bag.updatedNumber ??
        bag.updated,
    ),
    desiredNumber: numberOrNull(
      firstProgress?.desiredNumberScheduled ?? bag.desiredNumber ?? bag.desired,
    ),
    observedGeneration: numberOrNull(
      firstProgress?.observedGeneration ?? bag.observedGeneration,
    ),
    generation: numberOrNull(firstProgress?.generation ?? bag.generation),
    succeeded: numberOrNull(firstProgress?.succeeded ?? bag.succeeded),
    failed: numberOrNull(firstProgress?.failed ?? bag.failed),
    completions: numberOrNull(
      firstProgress?.completions ?? bag.completions ?? bag.completion,
    ),
    stopReason,
    stopCopy: stopCopyForPhase(phase),
    note: String(
      firstProgress?.reason ?? bag.observationNote ?? bag.note ?? "",
    ).trim(),
    progress,
    resources: resourcesFrom(bag, snapshot.snapshot.resources),
    correlationId:
      String(bag.correlationId ?? snapshot.snapshot.correlationId).trim() ||
      "",
    policyRevision:
      String(bag.policyRevision ?? snapshot.snapshot.policyRevision).trim() ||
      "",
    policyDigest: snapshot.snapshot.policyDigest,
    manifestDigest: snapshot.snapshot.manifestDigest,
    actorId: snapshot.snapshot.actorId,
    source: mode.source,
    strippedKeys,
    failedClosed,
  };
}

export function collectRolloutAuditSnapshots(
  events: readonly ExecutionAuditEvent[] | null | undefined,
  steps?: readonly ExecutionStep[] | null,
): KubernetesRolloutAuditSnapshot[] {
  const fromResults: KubernetesRolloutAuditSnapshot[] = [];
  for (const step of steps ?? []) {
    const output = asRecord(step.output);
    const result = asRecord(output?.result) ?? output;
    const audit = asRecord(result?.audit) ?? asRecord(output?.audit);
    const parsed = snapshotFromResultAudit(audit, {});
    if (parsed) {
      fromResults.push(parsed.snapshot);
    }
  }
  const fromEvents = (events ?? [])
    .filter((event) => isRolloutAuditAction(event.action))
    .map((event) => redactAuditSnapshot(event).snapshot);
  return [...fromResults, ...fromEvents];
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
  return emptyAuditSnapshot(bag);
}

function emptyAuditSnapshot(
  bag: Record<string, unknown>,
): {
  snapshot: KubernetesRolloutAuditSnapshot;
  strippedKeys: string[];
  failedClosed: boolean;
} {
  return {
    snapshot: {
      actorId: "",
      operation: "",
      clusterTargetId: String(bag.clusterTargetId ?? "").trim(),
      namespace: String(bag.namespace ?? "").trim(),
      policyRevision: String(bag.policyRevision ?? "").trim(),
      policyDigest: String(bag.policyDigest ?? "").trim(),
      manifestDigest: String(bag.manifestDigest ?? "").trim(),
      resources: resourcesFrom(bag, []),
      serverDryRun: bag.serverDryRun === true,
      applied: bag.applied === true,
      watch: String(bag.watch ?? bag.observation ?? "").trim(),
      observation: String(bag.observation ?? "").trim(),
      correlationId: String(bag.correlationId ?? "").trim(),
      action: "",
      outcome: "",
      errorCode: "",
      occurredAt: "",
      source: "catalog",
    },
    strippedKeys: [],
    failedClosed: false,
  };
}

function snapshotFromResultAudit(
  audit: Record<string, unknown> | null,
  bag: Record<string, unknown>,
): {
  snapshot: KubernetesRolloutAuditSnapshot;
  strippedKeys: string[];
  failedClosed: boolean;
} | null {
  if (!audit) {
    return null;
  }
  const redacted = redactRolloutPayload(audit);
  const details = asRecord(redacted.value) ?? {};
  return {
    snapshot: {
      actorId: String(details.actorId ?? "").trim(),
      operation: String(details.operation ?? "").trim(),
      clusterTargetId: String(
        details.clusterTargetId ?? bag.clusterTargetId ?? "",
      ).trim(),
      namespace: String(details.namespace ?? bag.namespace ?? "").trim(),
      policyRevision: String(
        details.policyRevision ?? bag.policyRevision ?? "",
      ).trim(),
      policyDigest: String(details.policyDigest ?? "").trim(),
      manifestDigest: String(details.manifestDigest ?? "").trim(),
      resources: resourcesFrom(details, resourcesFrom(bag, [])),
      serverDryRun: details.serverDryRun === true,
      applied: details.applied === true,
      watch: String(details.watch ?? details.observation ?? "").trim(),
      observation: String(details.observation ?? "").trim(),
      correlationId: String(
        details.correlationId ?? bag.correlationId ?? "",
      ).trim(),
      action: String(details.operation ?? "kubernetes.watch").trim(),
      outcome: String(details.outcome ?? "").trim(),
      errorCode: String(details.errorCode ?? "").trim(),
      occurredAt: "",
      source: "catalog",
    },
    strippedKeys: redacted.strippedKeys,
    failedClosed: redacted.failedClosed,
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
      operation: String(details.operation ?? "").trim(),
      clusterTargetId: String(
        details.clusterTargetId ||
          identities.clusterTargetId ||
          bag.clusterTargetId ||
          "",
      ).trim(),
      namespace: String(details.namespace ?? bag.namespace ?? "").trim(),
      policyRevision: String(
        details.policyRevision ||
          identities.policyRevision ||
          details.policyId ||
          bag.policyRevision ||
          "",
      ).trim(),
      policyDigest: String(details.policyDigest ?? "").trim(),
      manifestDigest: String(details.manifestDigest ?? "").trim(),
      resources,
      serverDryRun: details.serverDryRun === true,
      applied: details.applied === true,
      watch: String(details.watch ?? details.observation ?? "").trim(),
      observation: String(details.observation ?? "").trim(),
      correlationId: String(
        event.correlationId || details.correlationId || bag.correlationId || "",
      ).trim(),
      action: event.action,
      outcome: event.outcome || String(details.outcome ?? "").trim(),
      errorCode: String(details.errorCode ?? "").trim(),
      occurredAt: event.occurredAt,
      source: "catalog",
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
  const token = String(
    observation || bag.observation || bag.phase || bag.observationPhase || "",
  )
    .trim()
    .toLowerCase();
  if ((KUBERNETES_ROLLOUT_PHASES as readonly string[]).includes(token)) {
    return token as KubernetesRolloutPhase;
  }
  if (token === "timedout" || token === "timed-out" || bag.timedOut === true) {
    return "timeout";
  }
  if (token === "cancelled" || bag.canceled === true || bag.cancelled === true) {
    return "canceled";
  }
  if (token === "failure" || token === "rollout-failed") {
    return "failed";
  }
  if (token === "complete" || token === "succeeded") {
    return "ready";
  }
  if (token === "watching") {
    return "progressing";
  }
  const status = String(stepStatus ?? "").toLowerCase();
  if (status === "canceled") {
    return "canceled";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "succeeded") {
    return "ready";
  }
  if (status === "running" || status === "queued" || status === "pinned") {
    return "progressing";
  }
  return "progressing";
}

function stopReasonFor(
  phase: KubernetesRolloutPhase,
): KubernetesRolloutObservation["stopReason"] {
  if (
    phase === "timeout" ||
    phase === "canceled" ||
    phase === "ready" ||
    phase === "failed" ||
    phase === "skipped"
  ) {
    return phase;
  }
  return "";
}

function parseProgressList(raw: unknown): KubernetesRolloutProgress[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: KubernetesRolloutProgress[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    items.push({
      kind: String(rec.kind ?? "").trim(),
      name: String(rec.name ?? "").trim(),
      namespace: String(rec.namespace ?? "").trim(),
      generation: numberOrNull(rec.generation),
      observedGeneration: numberOrNull(rec.observedGeneration),
      readyReplicas: numberOrNull(rec.readyReplicas),
      updatedReplicas: numberOrNull(rec.updatedReplicas),
      availableReplicas: numberOrNull(rec.availableReplicas),
      desiredNumberScheduled: numberOrNull(rec.desiredNumberScheduled),
      updatedNumberScheduled: numberOrNull(rec.updatedNumberScheduled),
      numberAvailable: numberOrNull(rec.numberAvailable),
      completions: numberOrNull(rec.completions),
      succeeded: numberOrNull(rec.succeeded),
      failed: numberOrNull(rec.failed),
      state: String(rec.state ?? "").trim(),
      reason: String(rec.reason ?? "").trim(),
    });
  }
  return items;
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
