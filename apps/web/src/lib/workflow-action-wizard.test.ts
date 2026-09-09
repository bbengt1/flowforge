import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptActionLibrary } from "./workflow-action-library.ts";
import {
  applyTargetPin,
  applyWizardToYaml,
  authorizedCredentialOptions,
  credentialTypesForAction,
  defaultWithForType,
  emptyActionWizardDraft,
  opsConfigKindsForAction,
  publishedPinsFromList,
  recommendActions,
  redactedYamlPreview,
  sanitizeWizardWith,
  secretFreeDraftSnapshot,
  validateWizardDraft,
  wizardConfigFields,
  wizardNeedsTargetStep,
  wizardPolicyPreview,
} from "./workflow-action-wizard.ts";
import { STARTER_WORKFLOW_YAML } from "./workflow.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";
import { listYamlEdges, listYamlNodes } from "./workflow-yaml-nodes.ts";
import type { CredentialRecord } from "./credential-types.ts";
import type { OpsConfigSummary } from "./ops-config-types.ts";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  rules: { triggersAreWorkflowLevel: true },
  triggers: [{ type: "manual", phase: "core" }],
  nodes: [
    {
      type: "data.set",
      phase: "core",
      title: "Set data",
      outputs: [{ name: "result", kind: "object" }],
      allowedWith: [{ name: "value", kind: "object", required: true }],
      policy: {
        permissions: ["workflow.execute"],
        retrySafe: true,
        sideEffects: false,
        defaultMaxAttempts: 1,
      },
    },
    {
      type: "flow.stop",
      phase: "core",
      inputs: [{ name: "input", kind: "any" }],
    },
    {
      type: "kubernetes.apply",
      phase: "core",
      title: "Apply",
      requiredWith: ["clusterTargetId"],
      inputs: [{ name: "parameters", kind: "object" }],
      outputs: [{ name: "result", kind: "object" }],
      policy: {
        permissions: ["workflow.execute", "kubernetes.apply"],
        retrySafe: false,
        sideEffects: true,
        defaultMaxAttempts: 1,
      },
    },
    {
      type: "ssh.run",
      phase: "core",
      requiredWith: ["sshTargetId", "commandProfileId"],
    },
    { type: "workflow.call", phase: "next" },
  ],
};

const palette = adaptActionLibrary(catalog);

const k8sCred: CredentialRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "prod-k8s",
  tags: ["prod"],
  type: "kubernetes",
  status: "active",
  metadata: {},
  fingerprint: "sha256:abc",
  encryptionVersion: 1,
  keyReference: "env:CREDENTIAL_KEK",
  lastTestStatus: "passed",
  useCount: 0,
  permittedActions: ["view", "use"],
};

describe("action wizard selectors", () => {
  it("lists only authorized active credentials of the matching type", () => {
    const closed = authorizedCredentialOptions({
      items: [k8sCred],
      statusCode: 403,
      allowedTypes: ["kubernetes"],
    });
    assert.equal(closed.closed, true);
    assert.equal(closed.options.length, 0);
    assert.match(closed.reason ?? "", /Forbidden/);

    const filtered = authorizedCredentialOptions({
      items: [
        k8sCred,
        { ...k8sCred, id: "22222222-2222-4222-8222-222222222222", type: "token", displayName: "api" },
        {
          ...k8sCred,
          id: "33333333-3333-4333-8333-333333333333",
          status: "disabled",
          displayName: "old-k8s",
        },
      ],
      allowedTypes: ["kubernetes"],
    });
    assert.equal(filtered.closed, false);
    assert.deepEqual(
      filtered.options.map((item) => item.displayName),
      ["prod-k8s"],
    );
    assert.equal(
      JSON.stringify(filtered.options).includes("kubeconfig"),
      false,
    );
  });

  it("published pin selector fails closed on empty or unauthorized lists", () => {
    const empty = publishedPinsFromList({ items: [] });
    assert.equal(empty.closed, true);
    assert.equal(empty.options.length, 0);

    const forbidden = publishedPinsFromList({
      items: [],
      problem: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "not authorized",
        instance: "/cluster-targets",
        code: "forbidden",
        request_id: "req-1",
      },
      statusCode: 403,
    });
    assert.equal(forbidden.closed, true);
    assert.match(forbidden.reason ?? "", /Forbidden/);

    const items: OpsConfigSummary[] = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "cluster_target",
        name: "prod-cluster",
        status: "published",
        draftRevision: 1,
        latestVersionId: "55555555-5555-4555-8555-555555555555",
        latestVersionNumber: 2,
        latestVersionDigest: "sha256:abcd",
      },
    ];
    const open = publishedPinsFromList({ items });
    assert.equal(open.closed, false);
    assert.equal(open.options[0]?.resourceId, items[0]?.id);
    assert.equal(open.options[0]?.name, "prod-cluster");
  });
});

describe("action wizard catalog inference and recommendations", () => {
  it("infers k8s/SSH configure fields when allowedWith is missing", () => {
    const apply = palette.find((item) => item.type === "kubernetes.apply");
    const fields = wizardConfigFields(apply, "kubernetes.apply");
    assert.equal(fields.some((field) => field.name === "clusterTargetId" && field.inferred), true);
    assert.equal(fields.some((field) => field.name === "dryRun"), true);
    assert.deepEqual(credentialTypesForAction("kubernetes.apply"), ["kubernetes"]);
    assert.deepEqual(opsConfigKindsForAction("ssh.run"), ["ssh_target", "command_profile"]);
    assert.equal(wizardNeedsTargetStep("flow.delay"), false);
    assert.equal(wizardNeedsTargetStep("kubernetes.apply"), true);
    assert.equal(defaultWithForType("kubernetes.apply").dryRun, "server");
  });

  it("recommends compatible enabled actions from upstream port and targets", () => {
    const { recommended, visible } = recommendActions({
      entries: palette,
      upstream: { type: "data.set", port: { name: "result", kind: "object" } },
      permissions: ["workflow.execute", "kubernetes.apply"],
      enabledTargetKinds: ["cluster_target"],
    });
    assert.equal(visible.some((item) => item.type === "workflow.call"), false);
    const apply = recommended.find((item) => item.type === "kubernetes.apply");
    assert.ok(apply);
    assert.ok(apply.score >= 5);
    assert.ok(apply.reasons.some((reason) => /upstream/i.test(reason)));
  });
});

describe("action wizard insert + redaction", () => {
  it("inserts a kubernetes.apply node and typed edge into starter YAML", () => {
    const entry = palette.find((item) => item.type === "kubernetes.apply");
    const draft = emptyActionWizardDraft("kubernetes.apply", "Restart API");
    draft.with = {
      ...draft.with,
      clusterTargetId: "11111111-1111-4111-8111-111111111111",
      namespace: "cp-ops-nprd",
      dryRun: "server",
      token: "must-not-persist",
    };
    draft.mappings = [{ from: "seed.result", toPort: "parameters" }];
    const result = applyWizardToYaml(STARTER_WORKFLOW_YAML, draft, catalog, entry);
    assert.deepEqual(result.errors, []);
    assert.equal(result.node.type, "kubernetes.apply");
    const nodes = listYamlNodes(result.yaml);
    const added = nodes.find((node) => node.id === result.node.id);
    assert.ok(added);
    assert.equal(added?.with.clusterTargetId, "11111111-1111-4111-8111-111111111111");
    assert.equal(added?.with.namespace, "cp-ops-nprd");
    assert.equal("token" in (added?.with ?? {}), false);
    const edges = listYamlEdges(result.yaml);
    assert.ok(edges.some((edge) => edge.from === "seed.result" && edge.to === `${result.node.id}.parameters`));
    assert.match(result.yaml, /type: kubernetes\.apply/);
  });

  it("rejects unauthorized types and secret-shaped with values before insert", () => {
    const draft = emptyActionWizardDraft("workflow.call", "Call");
    const rejected = validateWizardDraft(draft, catalog);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((error) => /not enabled/i.test(error)));

    const leaky = emptyActionWizardDraft("kubernetes.apply", "Apply");
    leaky.with = {
      clusterTargetId: "11111111-1111-4111-8111-111111111111",
      namespace: "default",
      kubeconfig: "-----BEGIN FAKE-----",
    };
    const sanitized = sanitizeWizardWith(leaky.with);
    assert.equal("kubeconfig" in sanitized, false);
    const preview = redactedYamlPreview({
      ...leaky,
      with: { namespace: "default", token: "sk-leaked" },
    });
    assert.equal(preview.includes("sk-leaked"), false);
    assert.match(preview, /\[redacted\]/);
  });

  it("applies target pins as resource UUIDs and keeps snapshots secret-free", () => {
    const draft = applyTargetPin(emptyActionWizardDraft("ssh.run", "Clear cache"), "ssh_target", {
      kind: "ssh_target",
      resourceId: "22222222-2222-4222-8222-222222222222",
      versionId: "33333333-3333-4333-8333-333333333333",
      versionNumber: 1,
      digest: "sha256:pin",
      name: "edge-host",
    });
    assert.equal(draft.with.sshTargetId, "22222222-2222-4222-8222-222222222222");
    const snapshot = secretFreeDraftSnapshot({
      ...draft,
      with: { ...draft.with, privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" },
    });
    assert.equal("privateKey" in snapshot.with, false);
  });

  it("builds a policy preview from catalog metadata and evaluate", () => {
    const entry = palette.find((item) => item.type === "kubernetes.apply");
    const preview = wizardPolicyPreview({
      entry,
      evaluation: {
        decision: "approval-required",
        dispatchAllowed: false,
        evaluationId: "eval-1",
        workflowVersionId: "66666666-6666-4666-8666-666666666666",
        workflowDigest: "sha256:draft",
        operation: "kubernetes.apply",
        requirements: [
          {
            nodeId: "restart",
            nodeName: "Restart",
            operation: "kubernetes.apply",
            targetKind: "cluster_target",
            targetId: "11111111-1111-4111-8111-111111111111",
            targetVersionId: "55555555-5555-4555-8555-555555555555",
            policyResourceId: "77777777-7777-4777-8777-777777777777",
            policyVersionId: "88888888-8888-4888-8888-888888888888",
            policyRevision: 1,
            approverRole: "production-approver",
            expiresIn: "PT30M",
            expiresAt: "2026-09-09T12:00:00.000Z",
            reason: "production target",
          },
        ],
        denied: [],
        approvals: [],
      },
    });
    assert.equal(preview.evaluationApprovalRequired, true);
    assert.equal(preview.sideEffects, true);
    assert.match(preview.retryHint, /Not retry-safe/);
    assert.equal(preview.dispatchAllowed, false);
  });
});
