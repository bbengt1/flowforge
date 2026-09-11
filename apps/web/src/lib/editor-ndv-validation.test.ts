import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { policyEvaluatePath } from "./approval-contract.ts";
import type { PolicyEvaluation } from "./approval-types.ts";
import { EDITOR_INSPECTOR } from "./editor-inspector.ts";
import {
  EDITOR_NDV_VALIDATION,
  JONNY_EVALUATE_PAYLOAD_GAP,
  NDV_APPROVAL_DECIDE_HELP,
  NDV_EVALUATE_WHEN_PUBLISHED_HELP,
  NDV_NO_DRAFT_EXECUTE_HELP,
  NDV_VALIDATION_JUMP_HELP,
  NDV_VALIDATION_PANEL,
  NDV_VALIDATION_RAIL_SOURCES,
  R33_EPIC,
  R33_KEEP_STORY_OPEN,
  R33_STORY,
  focusNdvRailField,
  ndvActionableJump,
  ndvApprovalResumeStaysDecide,
  ndvCatalogPolicyBounds,
  ndvDecideHref,
  ndvEvaluateForNode,
  ndvEvaluatePayloadHasGap,
  ndvFieldFromYamlPath,
  ndvValidationEmbedUnchanged,
  ndvValidationIsEdit,
  ndvValidationLinks,
  ndvValidationNeverGuessesGraph,
  ndvValidationSourceForbidsDraftExecute,
  ndvValidationSourceForbidsExpressionLanguage,
  ndvValidationSourceForbidsInventedRoutes,
  ndvValidationSourceForbidsSecretSurface,
  ndvValidationView,
  ndvWizardRemainsAdd,
} from "./editor-ndv-validation.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function entry(
  extras: Partial<ActionLibraryEntry> = {},
): ActionLibraryEntry {
  return {
    type: "ssh.run",
    name: "Run SSH",
    description: "run",
    phase: "core",
    family: "ssh",
    enabled: true,
    placeable: true,
    inputs: [],
    outputs: [],
    requiredWith: [],
    allowedWith: [],
    policy: {
      permissions: ["workflow.execute"],
      retrySafe: false,
      sideEffects: true,
      defaultMaxAttempts: 0,
    },
    bounds: { maxInputBytes: 16384, maxOutputBytes: 16384 },
    redaction: { strategy: "redact-secrets" },
    source: "catalog",
    ...extras,
  };
}

function evaluation(extras: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  return {
    decision: "approval-required",
    dispatchAllowed: false,
    evaluationId: "eval-1",
    workflowVersionId: "ver-1",
    workflowDigest: "sha256:abc",
    operation: "workflow.execute",
    requirements: [
      {
        nodeId: "run",
        nodeName: "Run SSH",
        operation: "ssh.run",
        targetKind: "ssh_target",
        targetId: "tgt",
        targetVersionId: "tv",
        policyResourceId: "pol",
        policyVersionId: "pv",
        policyRevision: 1,
        approverRole: "approver",
        expiresIn: "PT1H",
        expiresAt: "",
        reason: "production target",
      },
    ],
    approvals: [],
    denied: [],
    operations: [
      {
        nodeId: "run",
        operation: "ssh.run",
        decision: "approval-required",
        retrySafe: false,
        retryMaxAttempts: 0,
        retryAllowed: false,
        verificationDeclared: true,
      },
    ],
    ...extras,
  };
}

describe("R3.3 NDV validation and policy", () => {
  it("keeps #248 open and cites epic #229", () => {
    assert.equal(R33_STORY, 248);
    assert.equal(R33_EPIC, 229);
    assert.equal(R33_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_NDV_VALIDATION.keep248Open, true);
    assert.equal(NDV_VALIDATION_PANEL, "validation");
  });

  it("keeps wizard as guided add and the inspector as edit", () => {
    assert.equal(EDITOR_NDV_VALIDATION.wizardIsAdd, true);
    assert.equal(EDITOR_NDV_VALIDATION.inspectorIsEdit, true);
    assert.equal(ndvWizardRemainsAdd(), true);
    assert.equal(ndvValidationIsEdit(), true);
    assert.equal(EDITOR_INSPECTOR.wizardIsAdd, true);
    assert.equal(EDITOR_INSPECTOR.inspectorIsEdit, true);
  });

  it("surfaces selected-node validate problems and workflow-level notes", () => {
    const view = ndvValidationView({
      nodeId: "seed",
      status: "invalid",
      nodes: [{ id: "seed" }, { id: "stop" }],
      edges: [{ from: "seed.result", to: "stop.in" }],
      errors: [
        { path: "metadata.name", code: "invalid-id", message: "bad name" },
        {
          path: "spec.nodes[0].with.op",
          code: "unknown-field",
          message: "bad op",
          line: 12,
          column: 5,
        },
        {
          path: "spec.edges[0]",
          code: "incompatible-ports",
          message: "seed.result",
        },
        {
          path: "spec.nodes[1].with.message",
          code: "invalid-with",
          message: "other node",
        },
      ],
      warnings: [
        {
          path: "spec.nodes[0].with.path",
          code: "unused-path",
          message: "optional",
        },
      ],
    });
    assert.equal(view.status, "invalid");
    assert.equal(view.node.length, 1);
    assert.equal(view.node[0]?.path, "spec.nodes[0].with.op");
    assert.equal(view.workflow.length, 1);
    assert.equal(view.workflow[0]?.path, "metadata.name");
    assert.equal(view.edge.length, 1);
    assert.equal(view.warnings.length, 1);
    assert.ok(
      !view.node.some((error) => error.path === "spec.nodes[1].with.message"),
    );
  });

  it("makes failures actionable with field and YAML path jumps", () => {
    assert.equal(EDITOR_NDV_VALIDATION.failuresAreActionable, true);
    assert.equal(EDITOR_NDV_VALIDATION.jumpToFieldOrYamlPath, true);
    assert.match(NDV_VALIDATION_JUMP_HELP, /field|YAML path/);
    const op = ndvActionableJump({
      path: "spec.nodes[0].with.op",
      code: "unknown-field",
      message: "bad op",
      line: 12,
      column: 5,
      nodeId: "seed",
    });
    assert.equal(op.field, "op");
    assert.equal(op.panel, "parameters");
    assert.equal(op.yamlPath, "spec.nodes[0].with.op");
    assert.equal(op.line, 12);
    assert.equal(op.location, "12:5");
    assert.deepEqual(ndvFieldFromYamlPath("spec.nodes[1].with.mapping.result"), {
      field: "mapping",
      panel: "mapping",
    });
    assert.deepEqual(ndvFieldFromYamlPath("spec.nodes[0].with.path"), {
      field: "path",
      panel: "mapping",
    });
    assert.deepEqual(ndvFieldFromYamlPath("spec.nodes[0].with.clusterTargetId"), {
      field: "clusterTargetId",
      panel: "pins",
    });
    assert.deepEqual(ndvFieldFromYamlPath("spec.nodes[0].with.credentialId"), {
      field: "credentialId",
      panel: "credentials",
    });
    assert.deepEqual(ndvFieldFromYamlPath("spec.nodes[0].name"), {
      field: "name",
      panel: "parameters",
    });
    assert.equal(ndvFieldFromYamlPath("metadata.name").field, null);
    const links = ndvValidationLinks(
      [{ path: "spec.nodes[0].with.op", code: "unknown-field", message: "bad" }],
      [{ id: "seed" }],
    );
    assert.ok(links.yamlPaths.includes("spec.nodes[0].with.op"));
    assert.deepEqual(links.nodeIds, ["seed"]);
  });

  it("surfaces catalog policy and bounds for the selected node", () => {
    const hints = ndvCatalogPolicyBounds(entry());
    assert.match(hints.policyLabel, /workflow.execute/);
    assert.match(hints.policyLabel, /side-effects/);
    assert.match(hints.boundsLabel, /16384B/);
    assert.match(hints.redactionLabel, /redact-secrets/);
    assert.equal(EDITOR_NDV_VALIDATION.surfacesPolicyBounds, true);
  });

  it("scopes evaluate to the selected node and keeps workflow notes", () => {
    const scoped = ndvEvaluateForNode({
      nodeId: "run",
      publishedVersionId: "ver-1",
      evaluation: evaluation({
        denied: [
          {
            nodeId: "other",
            operation: "kubernetes.apply",
            decision: "deny",
            reason: "namespace",
          },
        ],
        requirements: [
          ...evaluation().requirements,
          {
            nodeId: "gate",
            nodeName: "Gate",
            operation: "workflow.execute",
            targetKind: "",
            targetId: "",
            targetVersionId: "",
            policyResourceId: "",
            policyVersionId: "",
            policyRevision: null,
            approverRole: "approver",
            expiresIn: "",
            expiresAt: "",
            reason: "change window",
          },
        ],
      }),
    });
    assert.equal(scoped.publishedVersionInPlay, true);
    assert.equal(scoped.decision, "approval-required");
    assert.equal(scoped.dispatchAllowed, false);
    assert.equal(scoped.operations.length, 1);
    assert.equal(scoped.operations[0]?.nodeId, "run");
    assert.equal(scoped.requirements.length, 1);
    assert.equal(scoped.denied.length, 0);
    assert.ok(scoped.workflowNotes.some((note) => note.includes("gate")));
    assert.ok(scoped.workflowNotes.some((note) => /dispatch blocked/.test(note)));
  });

  it("does not evaluate drafts and does not invent an evaluate route", () => {
    const draft = ndvEvaluateForNode({ nodeId: "run" });
    assert.equal(draft.publishedVersionInPlay, false);
    assert.deepEqual(draft.operations, []);
    assert.ok(draft.workflowNotes.includes(NDV_NO_DRAFT_EXECUTE_HELP));
    assert.equal(EDITOR_NDV_VALIDATION.noDraftExecute, true);
    assert.equal(EDITOR_NDV_VALIDATION.noInventedEvaluateRoute, true);
    assert.equal(EDITOR_NDV_VALIDATION.evaluatePath, policyEvaluatePath());
    assert.equal(EDITOR_NDV_VALIDATION.evaluatePath, "/policy/evaluate");
    assert.match(NDV_EVALUATE_WHEN_PUBLISHED_HELP, /workflowVersionId/);
    assert.equal(focusNdvRailField("op"), false);
  });

  it("keeps approval resume as decide and reports no evaluate payload gap", () => {
    assert.equal(ndvApprovalResumeStaysDecide(), true);
    assert.match(NDV_APPROVAL_DECIDE_HELP, /decide/);
    assert.equal(ndvDecideHref("apr-1"), "/approvals/apr-1");
    assert.equal(JONNY_EVALUATE_PAYLOAD_GAP, null);
    assert.equal(ndvEvaluatePayloadHasGap(evaluation()), null);
    assert.equal(ndvEvaluatePayloadHasGap(null), null);
    assert.equal(
      ndvEvaluatePayloadHasGap(
        evaluation({
          operations: [
            { operation: "ssh.run", decision: "deny" },
            { operation: "kubernetes.apply", decision: "deny" },
          ],
          requirements: [],
        }),
      ),
      "POST /policy/evaluate rows lack nodeId; cannot scope policy to the selected node. Ping jonny — do not invent an evaluate route.",
    );
  });

  it("never guesses a graph from invalid YAML", () => {
    assert.equal(
      ndvValidationNeverGuessesGraph({
        errors: [{ path: "spec.nodes[0]", code: "invalid-with", message: "bad" }],
        summary: {
          name: "x",
          description: "",
          triggers: [],
          nodes: [{ id: "seed", type: "data.set", name: "Seed" }],
          edges: [],
          outputs: [],
        },
        yaml: "apiVersion: flowforge/v1\n",
      }),
      true,
    );
  });

  it("forbids SecretField, expression language, invented routes, and draft execute", () => {
    assert.equal(EDITOR_NDV_VALIDATION.noSecretField, true);
    assert.equal(EDITOR_NDV_VALIDATION.noExpressionLanguage, true);
    assert.equal(EDITOR_NDV_VALIDATION.noAppsApiChanges, true);
    assert.equal(ndvValidationEmbedUnchanged(), true);
    for (const relative of NDV_VALIDATION_RAIL_SOURCES) {
      const src = source(relative);
      assert.equal(ndvValidationSourceForbidsSecretSurface(src), true, relative);
      assert.equal(
        ndvValidationSourceForbidsExpressionLanguage(src),
        true,
        relative,
      );
      assert.equal(
        ndvValidationSourceForbidsInventedRoutes(src),
        true,
        relative,
      );
      assert.equal(ndvValidationSourceForbidsDraftExecute(src), true, relative);
      assert.equal(src.includes("SecretField"), false, relative);
    }
  });

  it("wires the validation panel into the selected-node inspector", () => {
    const inspector = source("src/components/workflows/EditorInspector.tsx");
    const panel = source("src/components/workflows/NdvValidationPanel.tsx");
    const operator = source("src/components/workflows/WorkflowOperator.tsx");
    const parameters = source("src/components/workflows/NdvParameterEditors.tsx");
    const nodeInspector = source("src/components/workflows/NodeInspector.tsx");
    const mapping = source("src/components/workflows/NdvMappingPanel.tsx");
    assert.match(inspector, /data-ndv-panel="validation"/);
    assert.match(inspector, /NdvValidationPanel/);
    assert.match(panel, /Validation and policy/);
    assert.match(panel, /focusNdvRailField|onJumpField/);
    assert.match(panel, /ndvDecideHref|\/approvals\//);
    assert.match(panel, /[Dd]ecide/);
    assert.doesNotMatch(panel, /startDraft|runDraft|draftExecute/);
    assert.match(operator, /NdvValidationPanel|validation=\{/);
    assert.match(parameters, /data-ndv-field=\{editor.name\}/);
    assert.match(nodeInspector, /data-ndv-field/);
    assert.match(mapping, /data-ndv-field="mapping"/);
  });
});
