import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyKubernetesPolicyToSpec,
  authorizedClusterTargets,
  authorizedKubernetesPolicies,
  clusterTargetPublishGap,
  clusterTargetSelectorLabel,
  hostSuppliedIdentityKeys,
  hostSuppliedIdentityProblem,
  isKubernetesActionType,
  kubernetesPolicyGaps,
  kubernetesPolicyPublishGap,
  kubernetesSecretKeysIn,
  parseKubernetesEngineCatalog,
  parseKubernetesPolicy,
  sanitizeKubernetesSpec,
  writeKubernetesPolicy,
} from "./kubernetes.ts";
import type { OpsConfigPin, OpsConfigSummary } from "./ops-config-types.ts";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";

function target(overrides: Partial<OpsConfigSummary> = {}): OpsConfigSummary {
  return {
    id: RESOURCE_ID,
    kind: "cluster_target",
    name: "prod-cluster",
    status: "published",
    draftRevision: 1,
    latestVersionId: VERSION_ID,
    latestVersionNumber: 2,
    latestVersionDigest: "sha256:abcd",
    credentialId: CREDENTIAL_ID,
    ...overrides,
  };
}

function pin(overrides: Partial<OpsConfigPin> = {}): OpsConfigPin {
  return {
    kind: "policy",
    resourceId: RESOURCE_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    digest: "sha256:aa",
    name: "prod-k8s-policy",
    spec: { kind: "kubernetes", policy: { allowedNamespaces: ["app"] } },
    ...overrides,
  };
}

describe("kubernetes policy parse / write", () => {
  it("reads allowlist aliases and writes canonical E4.3 keys", () => {
    const parsed = parseKubernetesPolicy({
      kind: "kubernetes",
      policy: {
        namespaces: ["app", "jobs"],
        kinds: ["Deployment", "Secret", "ConfigMap"],
        verbs: ["get", "apply", "delete"],
        requireApproval: true,
        operations: ["kubernetes.apply"],
        approverRole: "approver",
        expiresIn: "PT1H",
      },
    });
    assert.deepEqual(parsed.allowedNamespaces, ["app", "jobs"]);
    assert.deepEqual(parsed.allowedKinds, ["Deployment", "ConfigMap"]);
    assert.deepEqual(parsed.allowedVerbs, ["get", "apply"]);
    assert.equal(parsed.requireApproval, true);
    const spec = applyKubernetesPolicyToSpec({}, parsed);
    assert.equal(spec.kind, "kubernetes");
    const policy = spec.policy as Record<string, unknown>;
    assert.deepEqual(policy.allowedNamespaces, ["app", "jobs"]);
    assert.deepEqual(policy.allowedKinds, ["Deployment", "ConfigMap"]);
    assert.equal(policy.requireApproval, true);
    assert.equal(policy.approverRole, "approver");
    assert.equal("kubeconfig" in policy, false);
  });

  it("reports least-privilege gaps when allowlists are empty", () => {
    const gaps = kubernetesPolicyGaps({
      allowedNamespaces: [],
      allowedKinds: [],
      allowedVerbs: [],
      requireApproval: true,
      operations: [],
    });
    assert.ok(gaps.some((gap) => /namespaces/i.test(gap)));
    assert.ok(gaps.some((gap) => /kinds/i.test(gap)));
    assert.ok(gaps.some((gap) => /verbs/i.test(gap)));
    assert.ok(gaps.some((gap) => /operations/i.test(gap)));
    assert.ok(gaps.some((gap) => /Publish requires/i.test(gap)));
  });

  it("omits empty allowlists on write and requires namespaces unless deny", () => {
    const empty = writeKubernetesPolicy({
      allowedNamespaces: [],
      allowedKinds: [],
      allowedVerbs: [],
      requireApproval: false,
      operations: [],
    });
    assert.equal("allowedNamespaces" in empty, false);
    assert.equal("allowedKinds" in empty, false);
    assert.equal("allowedVerbs" in empty, false);
    assert.equal("operations" in empty, false);
    assert.match(
      kubernetesPolicyPublishGap({
        allowedNamespaces: [],
        allowedKinds: [],
        allowedVerbs: [],
        requireApproval: false,
        operations: [],
      }) ?? "",
      /allowedNamespaces/,
    );
    assert.equal(
      kubernetesPolicyPublishGap({
        allowedNamespaces: [],
        allowedKinds: [],
        allowedVerbs: [],
        requireApproval: false,
        operations: [],
        deny: true,
      }),
      null,
    );
    assert.match(
      clusterTargetPublishGap({ endpoint: { apiServer: "https://k8s.example" } }) ??
        "",
      /credentialId/,
    );
    assert.equal(
      clusterTargetPublishGap({
        credentialId: CREDENTIAL_ID,
        endpoint: { apiServer: "https://k8s.example" },
      }),
      null,
    );
  });

  it("treats host-supplied id/workspaceId as 400 invalid-request UX", () => {
    const keys = hostSuppliedIdentityKeys({
      id: RESOURCE_ID,
      workspaceId: VERSION_ID,
      credentialId: CREDENTIAL_ID,
    });
    assert.deepEqual(keys, ["id", "workspaceId"]);
    const problem = hostSuppliedIdentityProblem(keys);
    assert.equal(problem.status, 400);
    assert.equal(problem.code, "invalid-request");
    assert.match(problem.detail, /id, workspaceId/);
  });

  it("parses the #74 kubernetes engine catalog", () => {
    const catalog = parseKubernetesEngineCatalog({
      credentialType: "kubernetes",
      credentialSecretField: "kubeconfig",
      allowedKinds: ["ConfigMap", "Deployment"],
      allowedVerbs: ["get", "apply"],
      evaluationKeys: [
        {
          canonical: "allowedNamespaces",
          aliases: ["allowedNamespaces", "namespaces"],
          failClosedWhenPresent: true,
          requiredForPublish: true,
        },
      ],
      serviceAccount: {
        defaultName: "flowforge-runner",
        roleTemplate: "namespace-scoped-runner",
        notes: "Apply namespace-scoped Role templates.",
      },
      publishRules: {
        emptyAllowlistsRejected: true,
        denyAllowsMissingAllowlist: true,
        credentialType: "kubernetes",
      },
    });
    assert.ok(catalog);
    assert.equal(catalog?.credentialType, "kubernetes");
    assert.deepEqual(catalog?.allowedKinds, ["ConfigMap", "Deployment"]);
    assert.equal(catalog?.serviceAccount.defaultName, "flowforge-runner");
    assert.equal(catalog?.publishRules.emptyAllowlistsRejected, true);
    assert.equal(catalog?.evaluationKeys[0]?.requiredForPublish, true);
    assert.deepEqual(catalog?.nodes, []);
    assert.deepEqual(catalog?.errors, []);
    assert.equal(catalog?.apply.fieldManager, "flowforge");
    assert.equal(catalog?.apply.force, false);
    assert.equal(catalog?.apply.serverDryRunAlways, true);
    assert.equal(catalog?.apply.waitReady, "");
    assert.equal(catalog?.observation?.waitReady, "");
    assert.equal(catalog?.observation?.verb, "");
  });

  it("parses GET /kubernetes/catalog nodes[] / errors[] / apply / observation from #79", () => {
    const catalog = parseKubernetesEngineCatalog({
      credentialType: "kubernetes",
      allowedKinds: ["ConfigMap", "Service"],
      allowedVerbs: ["get", "list", "apply"],
      nodes: [
        {
          type: "kubernetes.apply",
          verb: "apply",
          title: "Apply manifests",
          permissions: ["workflow.execute", "kubernetes.apply", "clusterTarget.use"],
          requiredWith: ["clusterTargetId", "namespace"],
          allowedWith: [
            { name: "clusterTargetId", kind: "uuid", required: true },
            { name: "manifests", kind: "string" },
          ],
          outputs: ["result"],
          sideEffects: true,
          fieldManager: "flowforge",
          force: false,
          serverDryRunAlways: true,
          waitReady: "observed",
        },
        {
          type: "kubernetes.get",
          verb: "get",
          requiredWith: ["clusterTargetId", "namespace", "kind", "name"],
        },
        {
          type: "kubernetes.list",
          verb: "list",
          requiredWith: ["clusterTargetId", "namespace", "kind"],
        },
      ],
      errors: [
        { code: "ownership-conflict", status: 409, meaning: "Force is never applied." },
      ],
      apply: {
        fieldManager: "flowforge",
        force: false,
        serverDryRunAlways: true,
        clientDryRunAddsLocalValidationOnly: true,
        waitReady: "observed",
      },
      observation: {
        waitReady: "observed",
        states: ["ready", "failed", "timeout", "canceled", "skipped", "progressing"],
        kinds: ["Deployment", "StatefulSet", "DaemonSet", "Job"],
        verb: "watch",
        cancel: "stop-wait",
        timeout: "stop-wait",
        neverDeletesOrRollsBack: true,
      },
    });
    assert.ok(catalog);
    assert.equal(catalog?.nodes.length, 3);
    assert.equal(catalog?.nodes[0]?.type, "kubernetes.apply");
    assert.equal(catalog?.nodes[0]?.verb, "apply");
    assert.equal(catalog?.errors[0]?.code, "ownership-conflict");
    assert.equal(catalog?.errors[0]?.status, 409);
    assert.equal(catalog?.apply.fieldManager, "flowforge");
    assert.equal(catalog?.apply.force, false);
    assert.equal(catalog?.apply.waitReady, "observed");
    assert.equal(catalog?.observation?.waitReady, "observed");
    assert.deepEqual(catalog?.observation?.kinds, [
      "Deployment",
      "StatefulSet",
      "DaemonSet",
      "Job",
    ]);
  });
});

describe("secret stripping", () => {
  it("strips kubeconfig and other unexpected secrets from specs", () => {
    const sanitized = sanitizeKubernetesSpec({
      credentialId: CREDENTIAL_ID,
      endpoint: { apiServer: "https://k8s.example" },
      kubeconfig: "apiVersion: v1\nkind: Config",
      token: "super-secret",
      privateKey: "-----BEGIN FAKE-----",
    });
    assert.equal(sanitized.credentialId, CREDENTIAL_ID);
    assert.equal(sanitized.endpoint?.apiServer, "https://k8s.example");
    assert.equal("kubeconfig" in sanitized, false);
    assert.equal("token" in sanitized, false);
    assert.equal("privateKey" in sanitized, false);
    const leaked = kubernetesSecretKeysIn({
      spec: { kubeconfig: "cluster-admin", credentialId: CREDENTIAL_ID },
    });
    assert.ok(leaked.some((key) => key.includes("kubeconfig")));
    assert.equal(
      leaked.some((key) => key.toLowerCase().includes("credentialid")),
      false,
    );
  });
});

describe("authorized cluster target selectors", () => {
  it("fails closed on 403 and never lists the leaked target", () => {
    const forbidden = authorizedClusterTargets({
      statusCode: 403,
      problem: {
        type: "urn:flowforge:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "Cross-workspace resource.",
        instance: "/cluster-targets",
        code: "forbidden",
        request_id: "req-forbidden-16x",
      },
      items: [target()],
    });
    assert.equal(forbidden.closed, true);
    assert.deepEqual(forbidden.options, []);
    assert.match(forbidden.reason ?? "", /Forbidden/);
    assert.equal(
      JSON.stringify(forbidden.options).includes("kubeconfig"),
      false,
    );
  });

  it("lists only published credential-bound cluster targets", () => {
    const result = authorizedClusterTargets({
      items: [
        target(),
        target({
          id: "44444444-4444-4444-8444-444444444444",
          name: "unbound",
          credentialId: "",
          latestVersionId: "55555555-5555-4555-8555-555555555555",
        }),
        target({
          id: "66666666-6666-4666-8666-666666666666",
          name: "draft-only",
          latestVersionId: undefined,
          latestVersionNumber: undefined,
        }),
        target({
          id: "77777777-7777-4777-8777-777777777777",
          kind: "ssh_target",
          name: "edge-ssh",
        }),
      ],
    });
    assert.equal(result.closed, false);
    assert.deepEqual(
      result.options.map((item) => item.name),
      ["prod-cluster"],
    );
    assert.equal(result.options[0]?.resourceId, RESOURCE_ID);
    assert.doesNotMatch(
      clusterTargetSelectorLabel(result.options[0]!),
      /kubeconfig|BEGIN|token/i,
    );
  });

  it("fails closed when nothing is authorized", () => {
    const empty = authorizedClusterTargets({ items: [] });
    assert.equal(empty.closed, true);
    assert.deepEqual(empty.options, []);
  });
});

describe("authorized kubernetes policy selectors", () => {
  it("fails closed on 403 and drops non-kubernetes pins", () => {
    const forbidden = authorizedKubernetesPolicies({
      statusCode: 403,
      problem: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "not authorized",
        instance: "/policies",
        code: "forbidden",
        request_id: "req-1",
      },
      pins: [pin()],
    });
    assert.equal(forbidden.closed, true);
    assert.equal(forbidden.options.length, 0);

    const filtered = authorizedKubernetesPolicies({
      pins: [
        pin(),
        pin({
          resourceId: "88888888-8888-4888-8888-888888888888",
          spec: { kind: "ssh", policy: {} },
          name: "ssh-policy",
        }),
      ],
    });
    assert.equal(filtered.closed, false);
    assert.deepEqual(
      filtered.options.map((item) => item.name),
      ["prod-k8s-policy"],
    );
  });
});

describe("kubernetes action detection", () => {
  it("recognizes MVP kubernetes node types only", () => {
    assert.equal(isKubernetesActionType("kubernetes.apply"), true);
    assert.equal(isKubernetesActionType("kubernetes.get"), true);
    assert.equal(isKubernetesActionType("ssh.run"), false);
    assert.equal(isKubernetesActionType("flow.delay"), false);
  });
});
