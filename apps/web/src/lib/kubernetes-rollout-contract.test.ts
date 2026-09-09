import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionAuditEvent, ExecutionStep } from "./execution-types.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";
import {
  KUBERNETES_OBSERVATION_DEFERRED,
  KUBERNETES_OBSERVATION_WATCH,
  KUBERNETES_ROLLOUT_API_PR,
  KUBERNETES_ROLLOUT_CANCEL_HELP,
  KUBERNETES_ROLLOUT_EPIC,
  KUBERNETES_ROLLOUT_KINDS,
  KUBERNETES_ROLLOUT_KIND_MESSAGE,
  KUBERNETES_ROLLOUT_NAME_MESSAGE,
  KUBERNETES_ROLLOUT_NODE_TYPE,
  KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE,
  KUBERNETES_ROLLOUT_RECOGNITION,
  KUBERNETES_ROLLOUT_ROUTE_MAP_SOURCE,
  KUBERNETES_ROLLOUT_STORY,
  KUBERNETES_ROLLOUT_TIMEOUT_HELP,
  KUBERNETES_ROLLOUT_VERB,
  collectRolloutAuditSnapshots,
  collectRolloutObservations,
  effectiveWaitReady,
  executionHasRolloutObservation,
  isKubernetesRolloutKind,
  isKubernetesRolloutType,
  leftoverSecretKeys,
  observationModeFromCatalog,
  parseRolloutObservation,
  recognitionForKind,
  redactRolloutPayload,
  rolloutKindsFromCatalog,
  rolloutWaitReadyMessage,
} from "./kubernetes-rollout-contract.ts";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";

function step(partial: Partial<ExecutionStep> & Pick<ExecutionStep, "id" | "nodeType">): ExecutionStep {
  return {
    executionId: "exec-1",
    nodeId: partial.nodeId ?? "watch",
    attempt: 1,
    status: "running",
    startedAt: "",
    finishedAt: "",
    createdAt: "",
    input: null,
    output: null,
    error: null,
    fencingToken: null,
    workerId: "",
    leaseId: "",
    ...partial,
  };
}

describe("kubernetes rollout contract adapter", () => {
  it("cites E7.3 / E7 and the pending jonny map", () => {
    assert.equal(KUBERNETES_ROLLOUT_STORY, 72);
    assert.equal(KUBERNETES_ROLLOUT_EPIC, 69);
    assert.equal(KUBERNETES_ROLLOUT_API_PR, 0);
    assert.equal(KUBERNETES_ROLLOUT_ROUTE_MAP_SOURCE, "e73-pending-jonny-map");
    assert.equal(KUBERNETES_ROLLOUT_NODE_TYPE, "kubernetes.rolloutStatus");
    assert.equal(KUBERNETES_ROLLOUT_VERB, "watch");
    assert.deepEqual(
      [...KUBERNETES_ROLLOUT_KINDS],
      ["Deployment", "StatefulSet", "DaemonSet", "Job"],
    );
    assert.equal(KUBERNETES_ROLLOUT_RECOGNITION.Deployment, "availability + observed generation");
    assert.equal(KUBERNETES_ROLLOUT_RECOGNITION.StatefulSet, "ready replicas");
    assert.equal(KUBERNETES_ROLLOUT_RECOGNITION.DaemonSet, "updated/available counts");
    assert.equal(KUBERNETES_ROLLOUT_RECOGNITION.Job, "completion/failure");
    assert.equal(isKubernetesRolloutType("kubernetes.rolloutStatus"), true);
    assert.equal(isKubernetesRolloutType("kubernetes.apply"), false);
    assert.equal(isKubernetesRolloutKind("Deployment"), true);
    assert.equal(isKubernetesRolloutKind("Secret"), false);
    assert.match(KUBERNETES_ROLLOUT_KIND_MESSAGE, /Deployment/);
    assert.match(KUBERNETES_ROLLOUT_NAME_MESSAGE, /name is required/);
  });

  it("treats wait=ready as live observation via contract-fallback until the catalog token changes", () => {
    const deferred: KubernetesEngineCatalog = {
      credentialType: "kubernetes",
      credentialSecretField: "kubeconfig",
      allowedKinds: ["Deployment", "ConfigMap"],
      allowedVerbs: ["get", "list", "apply", "watch"],
      evaluationKeys: [],
      serviceAccount: {
        defaultName: "flowforge-runner",
        roleTemplate: "namespace-scoped-runner",
        clusterRoles: false,
      },
      publishRules: {
        clusterTargetRequired: [],
        kubernetesPolicyRequired: [],
        emptyAllowlistsRejected: true,
        credentialType: "kubernetes",
        denyAllowsMissingAllowlist: true,
      },
      clusterRoles: false,
      nodes: [],
      errors: [],
      apply: {
        fieldManager: "flowforge",
        force: false,
        serverDryRunAlways: true,
        clientDryRunAddsLocalValidationOnly: true,
        waitReady: KUBERNETES_OBSERVATION_DEFERRED,
      },
    };
    const fallback = observationModeFromCatalog(deferred);
    assert.equal(fallback.live, true);
    assert.equal(fallback.source, "contract-fallback");
    assert.equal(fallback.token, KUBERNETES_OBSERVATION_WATCH);
    assert.equal(effectiveWaitReady(deferred), "watch");
    assert.match(rolloutWaitReadyMessage(deferred), /contract-fallback/);
    assert.match(rolloutWaitReadyMessage(deferred), /never deletes or rolls back/);
    assert.deepEqual([...rolloutKindsFromCatalog(deferred)], ["Deployment"]);

    const live: KubernetesEngineCatalog = {
      ...deferred,
      apply: { ...deferred.apply, waitReady: "watch" },
      nodes: [
        {
          type: "kubernetes.rolloutStatus",
          verb: "watch",
          title: "Rollout status",
          description: "",
          permissions: [],
          requiredWith: ["clusterTargetId", "namespace", "kind", "name"],
          allowedWith: [],
          outputs: ["result", "status"],
          sideEffects: false,
          retrySafe: true,
          idempotent: true,
          waitReady: "watch",
        },
      ],
    };
    const catalogMode = observationModeFromCatalog(live);
    assert.equal(catalogMode.live, true);
    assert.equal(catalogMode.source, "catalog");
    assert.equal(catalogMode.token, "watch");
    assert.equal(rolloutWaitReadyMessage(live).includes("contract-fallback"), false);
  });

  it("parses bounded observation progress and timeout/cancel without rollback copy", () => {
    const watching = parseRolloutObservation(
      step({
        id: "s1",
        nodeType: "kubernetes.rolloutStatus",
        status: "running",
        output: {
          kind: "Deployment",
          name: "api",
          namespace: "app",
          clusterTargetId: TARGET_ID,
          observation: "watch",
          wait: "ready",
          timeoutSeconds: 90,
          availableReplicas: 1,
          readyReplicas: 2,
          observedGeneration: 4,
          generation: 4,
          correlationId: "corr-1",
          policyRevision: "rev-2",
        },
      }),
    );
    assert.equal(watching.phase, "watching");
    assert.equal(watching.phaseLabel, "Watching rollout");
    assert.equal(watching.recognition, KUBERNETES_ROLLOUT_RECOGNITION.Deployment);
    assert.equal(watching.readyReplicas, 2);
    assert.equal(watching.observedGeneration, 4);
    assert.match(watching.stopCopy, /never deletes or rolls back/i);

    const timedOut = parseRolloutObservation(
      step({
        id: "s2",
        nodeType: "kubernetes.apply",
        status: "failed",
        input: { wait: "ready" },
        output: {
          observation: "watch",
          timedOut: true,
          kind: "Job",
          name: "migrate",
          namespace: "jobs",
          succeeded: 0,
          failed: 1,
        },
      }),
    );
    assert.equal(timedOut.phase, "timeout");
    assert.equal(timedOut.stopReason, "timeout");
    assert.equal(timedOut.stopCopy, KUBERNETES_ROLLOUT_TIMEOUT_HELP);
    assert.equal(recognitionForKind("Job"), KUBERNETES_ROLLOUT_RECOGNITION.Job);

    const canceled = parseRolloutObservation(
      step({
        id: "s3",
        nodeType: "kubernetes.rolloutStatus",
        status: "canceled",
        output: { kind: "StatefulSet", name: "db", namespace: "app" },
      }),
    );
    assert.equal(canceled.phase, "canceled");
    assert.equal(canceled.stopCopy, KUBERNETES_ROLLOUT_CANCEL_HELP);

    const deferredEngine = parseRolloutObservation(
      step({
        id: "s4",
        nodeType: "kubernetes.apply",
        status: "succeeded",
        output: { wait: "ready", observation: KUBERNETES_OBSERVATION_DEFERRED },
      }),
    );
    assert.equal(deferredEngine.phase, "pending-engine");
    assert.equal(executionHasRolloutObservation([deferredEngine].map((item) =>
      step({ id: item.stepId, nodeType: item.nodeType, output: { wait: "ready" } }),
    )), true);
  });

  it("redacts secrets and fail-closes on kubeconfig", () => {
    const leaked = redactRolloutPayload({
      kind: "Deployment",
      name: "api",
      kubeconfig: "apiVersion: v1\nclusters: []",
      token: "super-secret",
      status: { readyReplicas: 1 },
    });
    assert.equal(leaked.failedClosed, true);
    assert.ok(leaked.strippedKeys.some((key) => /kubeconfig|token/i.test(key)));
    const cleaned = leaked.value as Record<string, unknown>;
    assert.equal(cleaned.kubeconfig, undefined);
    assert.equal(cleaned.token, undefined);

    const safe = redactRolloutPayload({
      kind: "DaemonSet",
      updatedNumber: 3,
      desiredNumber: 3,
    });
    assert.equal(safe.failedClosed, false);
    assert.deepEqual(leftoverSecretKeys({ readyReplicas: 1 }), []);
    assert.ok(leftoverSecretKeys({ kubeconfig: "x" }).length > 0);
  });

  it("extracts redacted audit snapshots for observation events", () => {
    const events: ExecutionAuditEvent[] = [
      {
        id: "a1",
        action: "kubernetes.rolloutStatus.watch",
        outcome: "timeout",
        resourceType: "execution_step",
        resourceId: "s1",
        correlationId: "corr-9",
        occurredAt: "2026-09-09T00:00:00Z",
        actorId: "user-1",
        details: {
          clusterTargetId: TARGET_ID,
          policyRevision: "pol-3",
          resources: [{ kind: "Deployment", name: "api", namespace: "app" }],
          kubeconfig: "should-strip",
        },
        hostContext: null,
      },
    ];
    const snapshots = collectRolloutAuditSnapshots(events);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.actorId, "user-1");
    assert.equal(snapshots[0]?.clusterTargetId, TARGET_ID);
    assert.equal(snapshots[0]?.policyRevision, "pol-3");
    assert.equal(snapshots[0]?.correlationId, "corr-9");
    assert.equal(snapshots[0]?.resources[0]?.kind, "Deployment");

    const observations = collectRolloutObservations({
      steps: [
        step({
          id: "s1",
          nodeId: "watch",
          nodeType: "kubernetes.rolloutStatus",
          status: "failed",
          output: {
            timedOut: true,
            kind: "Deployment",
            name: "api",
            namespace: "app",
            correlationId: "corr-9",
          },
        }),
      ],
      auditEvents: events,
    });
    assert.equal(observations[0]?.actorId, "user-1");
    assert.equal(observations[0]?.failedClosed, true);
    assert.match(KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE, /never deletes or rolls back/i);
  });
});
