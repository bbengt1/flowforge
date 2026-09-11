import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionAuditEvent, ExecutionStep } from "./execution-types.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";
import {
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
  KUBERNETES_ROLLOUT_SKIPPED_HELP,
  KUBERNETES_ROLLOUT_STORY,
  KUBERNETES_ROLLOUT_TIMEOUT_HELP,
  KUBERNETES_ROLLOUT_VERB,
  KUBERNETES_WAIT_READY_OBSERVED,
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
  rolloutIdentityFromWith,
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

function engineCatalog(waitReady = KUBERNETES_WAIT_READY_OBSERVED): KubernetesEngineCatalog {
  return {
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
    nodes: [
      {
        type: "kubernetes.rolloutStatus",
        verb: "watch",
        title: "Rollout status",
        description: "",
        permissions: ["workflow.execute", "kubernetes.read", "clusterTarget.use"],
        requiredWith: ["clusterTargetId", "namespace"],
        allowedWith: [],
        outputs: ["result", "status"],
        sideEffects: false,
        retrySafe: true,
        idempotent: true,
        waitReady,
      },
    ],
    errors: [],
    apply: {
      fieldManager: "flowforge",
      force: false,
      serverDryRunAlways: true,
      clientDryRunAddsLocalValidationOnly: true,
      waitReady,
    },
    observation: {
      waitReady,
      states: ["ready", "failed", "timeout", "canceled", "skipped", "progressing"],
      kinds: ["Deployment", "StatefulSet", "DaemonSet", "Job"],
      verb: "watch",
      cancel: "stop-wait",
      timeout: "stop-wait",
      neverDeletesOrRollsBack: true,
    },
  };
}

describe("kubernetes rollout contract adapter", () => {
  it("cites E7.3 / E7 and jonny's #79 map on main", () => {
    assert.equal(KUBERNETES_ROLLOUT_STORY, 72);
    assert.equal(KUBERNETES_ROLLOUT_EPIC, 69);
    assert.equal(KUBERNETES_ROLLOUT_API_PR, 79);
    assert.equal(KUBERNETES_ROLLOUT_ROUTE_MAP_SOURCE, "e73-#79");
    assert.equal(KUBERNETES_ROLLOUT_NODE_TYPE, "kubernetes.rolloutStatus");
    assert.equal(KUBERNETES_ROLLOUT_VERB, "watch");
    assert.equal(KUBERNETES_WAIT_READY_OBSERVED, "observed");
    assert.deepEqual(
      [...KUBERNETES_ROLLOUT_KINDS],
      ["Deployment", "StatefulSet", "DaemonSet", "Job"],
    );
    assert.equal(KUBERNETES_ROLLOUT_RECOGNITION.Deployment, "availability + observed generation");
    assert.equal(isKubernetesRolloutType("kubernetes.rolloutStatus"), true);
    assert.equal(isKubernetesRolloutKind("Secret"), false);
    assert.match(KUBERNETES_ROLLOUT_KIND_MESSAGE, /resource/);
    assert.match(KUBERNETES_ROLLOUT_NAME_MESSAGE, /resource.name/);
    assert.deepEqual(rolloutIdentityFromWith({ resource: { kind: "Job", name: "migrate" } }), {
      kind: "Job",
      name: "migrate",
    });
  });

  it("reads waitReady=observed from GET /kubernetes/catalog observation + apply", () => {
    const live = engineCatalog();
    const mode = observationModeFromCatalog(live);
    assert.equal(mode.live, true);
    assert.equal(mode.source, "catalog");
    assert.equal(mode.token, "observed");
    assert.equal(effectiveWaitReady(live), "observed");
    assert.match(rolloutWaitReadyMessage(live), /waitReady=observed/);
    assert.equal(rolloutWaitReadyMessage(live).includes("deferred-e7.3"), false);
    assert.match(rolloutWaitReadyMessage(live), /never deletes or rolls back/);
    assert.deepEqual([...rolloutKindsFromCatalog(live)], ["Deployment"]);

    const fallback = observationModeFromCatalog(null);
    assert.equal(fallback.token, "");
    assert.equal(fallback.live, false);
    assert.equal(fallback.source, "unavailable");
  });

  it("parses result.observation, status.progress[], and result.audit from #79", () => {
    const watching = parseRolloutObservation(
      step({
        id: "s1",
        nodeType: "kubernetes.rolloutStatus",
        status: "running",
        output: {
          observation: "progressing",
          wait: "ready",
          status: {
            observation: "progressing",
            progress: [
              {
                kind: "Deployment",
                name: "api",
                namespace: "app",
                readyReplicas: 2,
                observedGeneration: 4,
                generation: 4,
                state: "progressing",
                reason: "awaiting-status",
              },
            ],
          },
          audit: {
            actorId: "user-1",
            clusterTargetId: TARGET_ID,
            policyRevision: "rev-2",
            correlationId: "corr-1",
            watch: "progressing",
            observation: "progressing",
            outcome: "success",
          },
        },
      }),
    );
    assert.equal(watching.phase, "progressing");
    assert.equal(watching.phaseLabel, "Progressing");
    assert.equal(watching.recognition, KUBERNETES_ROLLOUT_RECOGNITION.Deployment);
    assert.equal(watching.readyReplicas, 2);
    assert.equal(watching.progress[0]?.state, "progressing");
    assert.equal(watching.actorId, "user-1");

    const timedOut = parseRolloutObservation(
      step({
        id: "s2",
        nodeType: "kubernetes.apply",
        status: "failed",
        input: { wait: "ready" },
        output: {
          observation: "timeout",
          status: {
            progress: [{ kind: "Job", name: "migrate", namespace: "jobs", failed: 1, state: "timeout" }],
          },
        },
      }),
    );
    assert.equal(timedOut.phase, "timeout");
    assert.equal(timedOut.stopCopy, KUBERNETES_ROLLOUT_TIMEOUT_HELP);

    const canceled = parseRolloutObservation(
      step({
        id: "s3",
        nodeType: "kubernetes.rolloutStatus",
        status: "canceled",
        output: { observation: "canceled", kind: "StatefulSet", name: "db" },
      }),
    );
    assert.equal(canceled.phase, "canceled");
    assert.equal(canceled.stopCopy, KUBERNETES_ROLLOUT_CANCEL_HELP);

    const skipped = parseRolloutObservation(
      step({
        id: "s4",
        nodeType: "kubernetes.apply",
        status: "succeeded",
        output: { wait: "ready", observation: "skipped" },
      }),
    );
    assert.equal(skipped.phase, "skipped");
    assert.equal(skipped.stopCopy, KUBERNETES_ROLLOUT_SKIPPED_HELP);
    assert.equal(
      executionHasRolloutObservation([
        step({ id: "s4", nodeType: "kubernetes.apply", output: { wait: "ready" } }),
      ]),
      true,
    );
    assert.equal(recognitionForKind("Job"), KUBERNETES_ROLLOUT_RECOGNITION.Job);
  });

  it("redacts secrets and fail-closes on kubeconfig", () => {
    const leaked = redactRolloutPayload({
      kind: "Deployment",
      name: "api",
      kubeconfig: "apiVersion: v1\nclusters: []",
      token: "super-secret",
      status: { progress: [{ readyReplicas: 1 }] },
    });
    assert.equal(leaked.failedClosed, true);
    const cleaned = leaked.value as Record<string, unknown>;
    assert.equal(cleaned.kubeconfig, undefined);
    assert.equal(cleaned.token, undefined);
    assert.deepEqual(leftoverSecretKeys({ readyReplicas: 1 }), []);
  });

  it("extracts redacted result.audit snapshots", () => {
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

    const observations = collectRolloutObservations({
      steps: [
        step({
          id: "s1",
          nodeType: "kubernetes.rolloutStatus",
          status: "failed",
          output: {
            observation: "timeout",
            audit: {
              actorId: "user-1",
              clusterTargetId: TARGET_ID,
              policyRevision: "pol-3",
              correlationId: "corr-9",
              watch: "timeout",
              outcome: "failure",
              errorCode: "timeout",
            },
          },
        }),
      ],
      auditEvents: events,
    });
    assert.equal(observations[0]?.actorId, "user-1");
    assert.equal(observations[0]?.phase, "timeout");
    assert.match(KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE, /never deletes or rolls back/i);
  });
});
