import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptActionLibrary,
  filterEnabledActionNodes,
  rejectDisabledActionType,
} from "./workflow-action-library.ts";
import {
  canConnectPorts,
  canSaveWorkflowEditor,
  canvasYamlRoundTrip,
  connectGraphEdge,
  disconnectGraphEdge,
  groupValidationErrors,
  groupedValidationBuckets,
  parsePortRef,
  parseYamlGraph,
  portsCompatible,
  projectCanvasGraph,
  removeGraphNode,
} from "./workflow-graph.ts";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML, canShowSummary } from "./workflow.ts";
import type { WorkflowCatalog, WorkflowFieldError, WorkflowSummary } from "./workflow-types.ts";
import { insertCoreNode, listYamlEdges, listYamlNodes } from "./workflow-yaml-nodes.ts";

const summary: WorkflowSummary = {
  apiVersion: "flowforge/v1",
  name: "validate-example",
  triggers: [{ id: "manual", type: "manual" }],
  nodes: [
    { id: "seed", type: "data.set", name: "Seed value" },
    { id: "done", type: "flow.stop", name: "Stop" },
  ],
  edges: [{ from: "seed.result", to: "done.input" }],
  outputs: [],
};

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  rules: {
    triggersAreWorkflowLevel: true,
    graphNodesExcludeTriggers: true,
    unsupportedPhasesRejected: true,
  },
  triggers: [
    { type: "manual", phase: "core" },
    { type: "event", phase: "next" },
  ],
  nodes: [
    {
      type: "data.set",
      phase: "core",
      title: "Set data",
      outputs: [{ name: "result", kind: "object" }],
      requiredWith: ["value"],
    },
    {
      type: "flow.stop",
      phase: "core",
      inputs: [{ name: "input", kind: "any" }],
    },
    {
      type: "flow.condition",
      phase: "core",
      inputs: [{ name: "value", kind: "any" }],
      outputs: [
        { name: "true", kind: "any" },
        { name: "false", kind: "any" },
      ],
    },
    { type: "kubernetes.apply", phase: "core", requiredWith: ["clusterTargetId"] },
    { type: "workflow.call", phase: "next" },
    { type: "servicenow.ticket", phase: "provider" },
    { type: "data.merge", phase: "next", enabled: false },
    { type: "flow.switch", phase: "next", enabled: true },
  ],
};

describe("invalid YAML never projects a guessed graph", () => {
  it("returns null when validate errors are present even if a summary exists", () => {
    const errors: WorkflowFieldError[] = [
      {
        path: "spec.nodes[0].id",
        line: 9,
        column: 7,
        code: "invalid-id",
        message: "Node IDs must be DNS labels.",
      },
    ];
    assert.equal(canShowSummary(errors, summary), false);
    assert.equal(
      projectCanvasGraph({
        errors,
        summary,
        yaml: INVALID_WORKFLOW_YAML,
        catalog,
      }),
      null,
    );
    const parsed = parseYamlGraph(INVALID_WORKFLOW_YAML);
    assert.equal(parsed.nodes[0]?.id, "Bad_ID");
    assert.equal(parsed.nodes[0]?.type, "workflow.call");
  });

  it("projects nodes and typed ports only after a valid summary", () => {
    const graph = projectCanvasGraph({
      errors: [],
      summary,
      yaml: STARTER_WORKFLOW_YAML,
      catalog,
    });
    assert.ok(graph);
    assert.deepEqual(
      graph.nodes.map((node) => node.id),
      ["seed", "done"],
    );
    assert.equal(graph.edges[0]?.from, "seed.result");
    assert.equal(graph.edges[0]?.to, "done.input");
    assert.equal(graph.edges[0]?.fromRef.port, "result");
    assert.equal(graph.triggers.some((trigger) => trigger.type === "manual"), true);
    assert.equal(graph.nodes.some((node) => node.type === "manual"), false);
  });
});

describe("action library catalog filter", () => {
  it("exposes enabled core implementations and never treats triggers as nodes", () => {
    const nodes = filterEnabledActionNodes(catalog.nodes);
    assert.equal(nodes.some((item) => item.type === "manual"), false);
    assert.equal(nodes.some((item) => item.type === "workflow.call"), false);
    assert.equal(nodes.some((item) => item.type === "servicenow.ticket"), false);
    assert.equal(nodes.some((item) => item.type === "data.merge"), false);
    assert.equal(nodes.some((item) => item.type === "flow.switch"), true);
    assert.equal(nodes.some((item) => item.type === "kubernetes.apply"), true);

    const library = adaptActionLibrary(catalog);
    assert.equal(library.some((item) => item.type === "manual"), false);
    assert.equal(library.some((item) => item.type === "webhook"), false);
    assert.equal(rejectDisabledActionType("manual", catalog).ok, false);
    assert.equal(rejectDisabledActionType("workflow.call", catalog).ok, false);
    assert.equal(rejectDisabledActionType("data.set", catalog).ok, true);
    assert.equal(rejectDisabledActionType("flow.switch", catalog).ok, true);
    assert.equal(rejectDisabledActionType("kubernetes.apply", catalog).ok, true);
    const fallback = adaptActionLibrary(null);
    assert.equal(fallback.some((item) => item.type === "kubernetes.apply"), true);
    assert.equal(fallback.some((item) => item.type === "kubernetes.get"), true);
    assert.equal(fallback.some((item) => item.type === "kubernetes.list"), true);
    assert.equal(fallback.some((item) => item.type === "kubernetes.rolloutStatus"), true);
    assert.equal(fallback.some((item) => item.type === "ssh.run"), true);
    assert.equal(
      fallback.find((item) => item.type === "ssh.run")?.source,
      "contract-fallback",
    );
    assert.equal(fallback.some((item) => item.type === "script.python"), true);
    assert.equal(fallback.some((item) => item.type === "script.go"), true);
    assert.equal(
      fallback.find((item) => item.type === "script.python")?.source,
      "contract-fallback",
    );
    assert.equal(rejectDisabledActionType("kubernetes.apply", null).ok, true);
    assert.equal(rejectDisabledActionType("ssh.run", null).ok, true);
    assert.equal(rejectDisabledActionType("script.python", null).ok, true);
    assert.equal(rejectDisabledActionType("script.go", null).ok, true);
    assert.equal(fallback.some((item) => item.type === "http.request"), true);
    assert.equal(fallback.some((item) => item.type === "notification.webhook"), true);
    assert.equal(fallback.some((item) => item.type === "notification.email"), true);
    assert.equal(
      fallback.find((item) => item.type === "http.request")?.source,
      "contract-fallback",
    );
    assert.equal(rejectDisabledActionType("http.request", null).ok, true);
    assert.equal(rejectDisabledActionType("notification.email", null).ok, true);
    assert.equal(
      rejectDisabledActionType("http.request", {
        apiVersion: "flowforge/v1",
        rules: { integrationActionsEnabled: false },
        integrationGate: { enabled: false },
        triggers: [],
        nodes: [{ type: "http.request", phase: "core" }],
      }).ok,
      false,
    );
  });
});

describe("canvas YAML round-trip", () => {
  it("re-serializes starter nodes and keeps nodeId.port edges", () => {
    const round = canvasYamlRoundTrip(STARTER_WORKFLOW_YAML);
    assert.deepEqual(
      round.nodes.map((node) => node.id),
      ["seed", "done"],
    );
    assert.deepEqual(round.edges, [{ from: "seed.result", to: "done.input" }]);
    const parsed = parseYamlGraph(round.yaml);
    assert.deepEqual(parsed.nodes[0]?.with, { value: { status: "ready" } });
    assert.equal(parsePortRef("seed.result")?.nodeId, "seed");
    assert.equal(parsePortRef("not-a-port"), null);
  });

  it("inserts a compatible edge and rejects incompatible ports", () => {
    const withCondition = insertCoreNode(STARTER_WORKFLOW_YAML, "flow.condition");
    const connected = connectGraphEdge(
      withCondition.yaml,
      "seed.result",
      "condition.value",
      catalog,
    );
    assert.equal(connected.errors.length, 0);
    assert.ok(listYamlEdges(connected.yaml).some((edge) => edge.to === "condition.value"));

    const objectOnly = {
      ...catalog,
      nodes: [
        ...catalog.nodes,
        {
          type: "data.map",
          phase: "core" as const,
          inputs: [{ name: "input", kind: "object" }],
          outputs: [{ name: "result", kind: "object" }],
        },
      ],
    };
    const mapped = insertCoreNode(STARTER_WORKFLOW_YAML, "data.map");
    const rejected = connectGraphEdge(mapped.yaml, "done.input", "map.input", objectOnly);
    const removed = removeGraphNode(connected.yaml, "condition");
    assert.equal(listYamlNodes(removed).some((node) => node.id === "condition"), false);
    const disconnected = disconnectGraphEdge(connected.yaml, "seed.result", "condition.value");
    assert.equal(
      listYamlEdges(disconnected).some((edge) => edge.to === "condition.value"),
      false,
    );
    assert.ok(rejected.errors.length > 0);
    assert.equal(portsCompatible({ name: "result", kind: "object" }, { name: "input", kind: "any" }), true);
    assert.equal(
      canConnectPorts(objectOnly, "flow.stop", "result", "data.map", "input").ok,
      false,
    );
  });
});

describe("save eligibility and validation groups", () => {
  it("disables save when YAML, ports, or config are invalid", () => {
    assert.equal(
      canSaveWorkflowEditor({ status: "valid", errors: [], localErrors: [] }),
      true,
    );
    assert.equal(
      canSaveWorkflowEditor({
        status: "invalid",
        errors: [{ path: "spec.nodes[0]", code: "invalid-id", message: "bad" }],
      }),
      false,
    );
    assert.equal(
      canSaveWorkflowEditor({ status: "valid", errors: [], localErrors: ["missing with.code"] }),
      false,
    );
    const grouped = groupValidationErrors(
      [
        { path: "metadata.name", code: "invalid-id", message: "bad name" },
        { path: "spec.nodes[0].with.op", code: "unknown-field", message: "bad op" },
        { path: "spec.edges[0]", code: "incompatible-ports", message: "seed.result" },
      ],
      listYamlNodes(STARTER_WORKFLOW_YAML),
      listYamlEdges(STARTER_WORKFLOW_YAML),
    );
    const buckets = groupedValidationBuckets(grouped);
    assert.equal(buckets.workflow.length, 1);
    assert.equal(buckets.node.length, 1);
    assert.equal(buckets.edge.length, 1);
    assert.equal(buckets.node[0]?.nodeId, "seed");
  });
});
