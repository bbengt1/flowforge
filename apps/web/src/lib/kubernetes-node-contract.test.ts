import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KUBERNETES_DEFAULT_TIMEOUT_SECONDS,
  KUBERNETES_FIELD_MANAGER,
  KUBERNETES_FORCE_APPLY,
  KUBERNETES_FORCE_DENIED_MESSAGE,
  KUBERNETES_FORBIDDEN_WITH_KEYS,
  KUBERNETES_MVP_NODE_TYPES,
  KUBERNETES_NAMESPACE_REQUIRED_MESSAGE,
  KUBERNETES_NODE_API_PR,
  KUBERNETES_NODE_EPIC,
  KUBERNETES_NODE_ROUTE_MAP_SOURCE,
  KUBERNETES_NODE_STORY,
  KUBERNETES_OBSERVATION_DEFERRED,
  KUBERNETES_SECRET_MANIFEST_MESSAGE,
  KUBERNETES_TARGET_FAIL_CLOSED_MESSAGE,
  adaptKubernetesNodeEntries,
  allowedNamespacesFromPinSpec,
  applyRulesFromCatalog,
  catalogListsKubernetesType,
  defaultKubernetesWith,
  hasKubernetesNodeContract,
  kubernetesFallbackNode,
  kubernetesForbiddenWithKeys,
  kubernetesLibraryTypes,
  kubernetesNodeWithFields,
  looksLikePastedKubeconfig,
  looksLikeSecretManifest,
  stripKubernetesForbiddenWith,
  validateKubernetesNodeConfig,
  waitReadyMessage,
} from "./kubernetes-node-contract.ts";
import type { KubernetesEngineCatalog } from "./kubernetes-types.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  nodes: [
    {
      type: "kubernetes.apply",
      phase: "core",
      requiredWith: ["clusterTargetId", "namespace"],
    },
    {
      type: "kubernetes.get",
      phase: "core",
      requiredWith: ["clusterTargetId", "namespace"],
    },
    {
      type: "kubernetes.list",
      phase: "core",
      requiredWith: ["clusterTargetId", "namespace"],
    },
    {
      type: "kubernetes.rolloutStatus",
      phase: "core",
      requiredWith: ["clusterTargetId", "namespace"],
    },
  ],
};

const engineCatalog: KubernetesEngineCatalog = {
  credentialType: "kubernetes",
  credentialSecretField: "kubeconfig",
  allowedKinds: ["ConfigMap", "Deployment"],
  allowedVerbs: ["get", "list", "apply"],
  evaluationKeys: [],
  serviceAccount: {
    defaultName: "flowforge-runner",
    roleTemplate: "namespace-scoped-runner",
    clusterRoles: false,
  },
  publishRules: {
    clusterTargetRequired: ["credentialId", "endpoint"],
    kubernetesPolicyRequired: ["allowedNamespaces|namespaces"],
    emptyAllowlistsRejected: true,
    credentialType: "kubernetes",
    denyAllowsMissingAllowlist: true,
  },
  clusterRoles: false,
  nodes: [
    {
      type: "kubernetes.apply",
      verb: "apply",
      title: "Apply manifests",
      description: "Validate, dry-run, then SSA.",
      permissions: ["workflow.execute", "kubernetes.apply", "clusterTarget.use"],
      requiredWith: ["clusterTargetId", "namespace"],
      allowedWith: [
        { name: "clusterTargetId", kind: "uuid", required: true },
        { name: "namespace", kind: "string", required: true },
        { name: "fieldManager", kind: "enum", enum: ["flowforge"] },
        { name: "manifests", kind: "string" },
      ],
      outputs: ["result", "resources", "status"],
      sideEffects: true,
      retrySafe: false,
      idempotent: true,
      fieldManager: "flowforge",
      force: false,
      serverDryRunAlways: true,
      waitReady: "deferred-e7.3",
    },
  ],
  errors: [
    {
      code: "ownership-conflict",
      status: 409,
      meaning: "SSA field-manager conflict. Force is never applied.",
    },
  ],
  apply: {
    fieldManager: "flowforge",
    force: false,
    serverDryRunAlways: true,
    clientDryRunAddsLocalValidationOnly: true,
    waitReady: "deferred-e7.3",
  },
};

describe("kubernetes node contract adapter", () => {
  it("cites E7.2 / E7 and jonny's #78 map on main", () => {
    assert.equal(KUBERNETES_NODE_STORY, 71);
    assert.equal(KUBERNETES_NODE_EPIC, 69);
    assert.equal(KUBERNETES_NODE_API_PR, 78);
    assert.equal(KUBERNETES_NODE_ROUTE_MAP_SOURCE, "e72-#78");
    assert.equal(KUBERNETES_FIELD_MANAGER, "flowforge");
    assert.equal(KUBERNETES_FORCE_APPLY, false);
    assert.equal(KUBERNETES_DEFAULT_TIMEOUT_SECONDS, 60);
    assert.equal(KUBERNETES_OBSERVATION_DEFERRED, "deferred-e7.3");
    assert.deepEqual(
      [...KUBERNETES_FORBIDDEN_WITH_KEYS],
      ["force", "kubeconfig", "server", "fieldManager"],
    );
  });

  it("falls back to marked contract entries when catalog is thin or missing", () => {
    assert.deepEqual([...kubernetesLibraryTypes(null)], [...KUBERNETES_MVP_NODE_TYPES]);
    assert.ok(kubernetesLibraryTypes(null).includes("kubernetes.rolloutStatus"));
    assert.equal(catalogListsKubernetesType(catalog, "kubernetes.rolloutStatus"), true);
    assert.ok(kubernetesLibraryTypes(catalog).includes("kubernetes.rolloutStatus"));

    const missing = adaptKubernetesNodeEntries(null);
    assert.deepEqual(
      missing.map((item) => item.type),
      [...KUBERNETES_MVP_NODE_TYPES],
    );
    assert.equal(
      missing.every((item) => (item.allowedWith?.length ?? 0) > 0),
      true,
    );

    const merged = adaptKubernetesNodeEntries(catalog);
    const apply = merged.find((item) => item.type === "kubernetes.apply");
    assert.ok(apply);
    assert.equal(hasKubernetesNodeContract(catalog.nodes[0]), false);
    assert.ok((apply.allowedWith ?? []).some((field) => field.name === "manifests"));
    assert.equal(
      (apply.allowedWith ?? []).some((field) => field.name === "force"),
      false,
    );
    assert.ok(merged.some((item) => item.type === "kubernetes.rolloutStatus"));
    assert.match(
      kubernetesFallbackNode("kubernetes.rolloutStatus").description ?? "",
      /bounded watch/i,
    );

    const overlaid = adaptKubernetesNodeEntries(null, engineCatalog);
    const applyFromEngine = overlaid.find((item) => item.type === "kubernetes.apply");
    assert.equal(applyFromEngine?.title, "Apply manifests");
    assert.ok((applyFromEngine?.allowedWith ?? []).some((field) => field.name === "manifests"));
  });

  it("prefers catalog allowedWith when jonny's map lands", () => {
    const rich: WorkflowCatalog = {
      apiVersion: "flowforge/v1",
      nodes: [
        {
          type: "kubernetes.apply",
          phase: "core",
          title: "Server apply",
          requiredWith: ["clusterTargetId"],
          allowedWith: [
            { name: "clusterTargetId", kind: "uuid", required: true },
            { name: "namespace", kind: "string", required: true },
          ],
          policy: { permissions: ["kubernetes.apply"], sideEffects: true },
        },
      ],
    };
    assert.equal(hasKubernetesNodeContract(rich.nodes[0]), true);
    const [apply] = adaptKubernetesNodeEntries(rich);
    assert.equal(apply?.title, "Server apply");
    assert.deepEqual(
      (apply?.allowedWith ?? []).map((field) => field.name),
      ["clusterTargetId", "namespace"],
    );
  });
});

describe("kubernetes node config validation", () => {
  it("requires namespace and a published cluster target", () => {
    const fields = kubernetesNodeWithFields("kubernetes.apply");
    assert.equal(
      fields.some((field) => field.name === "force"),
      false,
    );
    assert.equal(defaultKubernetesWith("kubernetes.apply").dryRun, "server");
    assert.equal(defaultKubernetesWith("kubernetes.apply").timeoutSeconds, 60);
    assert.equal(
      fields.find((field) => field.name === "fieldManager")?.readOnly,
      true,
    );
    assert.equal(
      fields.find((field) => field.name === "fieldManager")?.defaultValue,
      "flowforge",
    );
    assert.match(waitReadyMessage(engineCatalog), /contract-fallback/);
    assert.match(waitReadyMessage(engineCatalog), /never deletes or rolls back/);
    assert.equal(applyRulesFromCatalog(engineCatalog).force, false);
    assert.equal(applyRulesFromCatalog(engineCatalog).fieldManager, "flowforge");

    const errors = validateKubernetesNodeConfig("kubernetes.apply", {
      dryRun: "server",
    });
    assert.ok(errors.includes(KUBERNETES_NAMESPACE_REQUIRED_MESSAGE));
    assert.ok(errors.some((error) => /clusterTargetId/.test(error)));
  });

  it("fails closed when the target selector is unauthorized", () => {
    const errors = validateKubernetesNodeConfig(
      "kubernetes.get",
      {
        clusterTargetId: TARGET_ID,
        namespace: "app",
        kind: "ConfigMap",
        name: "settings",
      },
      { targetSelectorClosed: true },
    );
    assert.ok(errors.includes(KUBERNETES_TARGET_FAIL_CLOSED_MESSAGE));
  });

  it("denies Secret manifests and force / kubeconfig keys", () => {
    const secretErrors = validateKubernetesNodeConfig("kubernetes.apply", {
      clusterTargetId: TARGET_ID,
      namespace: "app",
      manifests: ["apiVersion: v1", "kind: Secret", "metadata:", "  name: leak", "stringData:", "  token: x"].join(
        "\n",
      ),
      force: true,
      kubeconfig: "-----BEGIN FAKE-----",
    });
    assert.ok(secretErrors.includes(KUBERNETES_SECRET_MANIFEST_MESSAGE));
    assert.ok(secretErrors.includes(KUBERNETES_FORCE_DENIED_MESSAGE));
    assert.ok(secretErrors.some((error) => /kubeconfig/i.test(error)));

    const cm = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: ok", "data:", "  a: b"].join("\n");
    assert.equal(looksLikeSecretManifest(cm), false);
    assert.deepEqual(
      validateKubernetesNodeConfig("kubernetes.apply", {
        clusterTargetId: TARGET_ID,
        namespace: "app",
        manifests: cm,
      }),
      [],
    );
  });

  it("constrains namespace to the selected target allowlist", () => {
    const errors = validateKubernetesNodeConfig(
      "kubernetes.list",
      {
        clusterTargetId: TARGET_ID,
        namespace: "prod",
        kind: "Deployment",
      },
      { allowedNamespaces: ["app", "jobs"] },
    );
    assert.ok(errors.some((error) => /allowlist/.test(error)));
    assert.deepEqual(
      allowedNamespacesFromPinSpec({
        allowedNamespaces: ["app"],
        policy: { namespaces: ["jobs"] },
      }),
      ["app", "jobs"],
    );
  });

  it("strips forbidden with keys and rejects pasted kubeconfigs", () => {
    const stripped = stripKubernetesForbiddenWith({
      clusterTargetId: TARGET_ID,
      namespace: "app",
      force: true,
      kubeconfig: "clusters: []",
      fieldManager: "attacker",
      server: "https://example.invalid",
    });
    assert.deepEqual(Object.keys(stripped).sort(), ["clusterTargetId", "namespace"]);
    assert.deepEqual(kubernetesForbiddenWithKeys({ force: true }), ["force"]);
    assert.equal(
      looksLikePastedKubeconfig("apiVersion: v1\nkind: Config\nclusters:\n- name: x\nusers:\n- name: y"),
      true,
    );
  });

  it("accepts wait=ready as bounded observation and rejects a non-flowforge fieldManager", () => {
    const ready = validateKubernetesNodeConfig("kubernetes.apply", {
      clusterTargetId: TARGET_ID,
      namespace: "app",
      manifests: ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: ok"].join("\n"),
      wait: "ready",
      timeoutSeconds: 60,
    });
    assert.deepEqual(ready, []);
    assert.match(waitReadyMessage(), /contract-fallback/);
    const rollout = validateKubernetesNodeConfig("kubernetes.rolloutStatus", {
      clusterTargetId: TARGET_ID,
      namespace: "app",
      kind: "Deployment",
      name: "api",
      wait: "ready",
      timeoutSeconds: 60,
    });
    assert.deepEqual(rollout, []);
    const rolloutKind = validateKubernetesNodeConfig("kubernetes.rolloutStatus", {
      clusterTargetId: TARGET_ID,
      namespace: "app",
      kind: "ConfigMap",
      name: "settings",
    });
    assert.ok(rolloutKind.some((error) => /rollout workload/.test(error)));
    const rolloutName = validateKubernetesNodeConfig("kubernetes.rolloutStatus", {
      clusterTargetId: TARGET_ID,
      namespace: "app",
      kind: "Job",
    });
    assert.ok(rolloutName.some((error) => /name is required/.test(error)));
    const fields = kubernetesNodeWithFields("kubernetes.rolloutStatus");
    assert.equal(fields.some((field) => field.name === "force"), false);
    assert.equal(fields.find((field) => field.name === "kind")?.required, true);
    assert.equal(fields.find((field) => field.name === "name")?.required, true);

    const manager = validateKubernetesNodeConfig("kubernetes.get", {
      clusterTargetId: TARGET_ID,
      namespace: "app",
      kind: "ConfigMap",
      name: "settings",
      fieldManager: "attacker",
    });
    assert.ok(manager.some((error) => /flowforge/.test(error)));

    const kindDenied = validateKubernetesNodeConfig(
      "kubernetes.list",
      {
        clusterTargetId: TARGET_ID,
        namespace: "app",
        kind: "Job",
      },
      { engineCatalog },
    );
    assert.ok(kindDenied.some((error) => /allowlist/.test(error)));

    const overlaid = kubernetesNodeWithFields("kubernetes.apply", engineCatalog);
    assert.equal(overlaid.find((field) => field.name === "fieldManager")?.readOnly, true);
    assert.equal(overlaid.some((field) => field.name === "force"), false);
  });
});
