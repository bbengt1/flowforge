import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STARTER_WORKFLOW_YAML } from "./workflow.ts";
import {
  allocateNodeId,
  applyCoreNodeConfig,
  configFromNode,
  defaultCoreWith,
  insertCoreNode,
  isForbiddenYamlKey,
  listYamlNodes,
  serializeCoreWith,
  serializeNodeBlock,
  updateYamlNode,
} from "./workflow-yaml-nodes.ts";
import { CORE_NEUTRAL_NODE_TYPES } from "./workflow-core-nodes.ts";

describe("insertCoreNode", () => {
  it("appends a canonical flow.delay block into starter YAML", () => {
    const inserted = insertCoreNode(STARTER_WORKFLOW_YAML, "flow.delay");
    assert.equal(inserted.node.id, "delay");
    assert.equal(inserted.node.type, "flow.delay");
    assert.match(inserted.yaml, /id: delay\n {6}type: flow\.delay\n {6}name: Delay\n {6}with:\n {8}duration: PT5M/);
    assert.match(inserted.yaml, /id: seed/);
    assert.match(inserted.yaml, /id: done/);
    const ids = listYamlNodes(inserted.yaml).map((node) => node.id);
    assert.deepEqual(ids, ["seed", "done", "delay"]);
  });

  it("allocates unique DNS-label ids and never inserts a trigger node", () => {
    const once = insertCoreNode(STARTER_WORKFLOW_YAML, "flow.stop");
    const twice = insertCoreNode(once.yaml, "flow.stop");
    assert.equal(twice.node.id, "stop-2");
    const insertedTypes = listYamlNodes(twice.yaml).map((node) => node.type);
    assert.equal(insertedTypes.includes("manual"), false);
    assert.equal(isForbiddenYamlKey("secret"), true);
    assert.deepEqual(allocateNodeId(["delay", "delay-2"], "flow.delay"), "delay-3");
  });

  it("inserts each core type with the documented with defaults", () => {
    const empty = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: core-nodes
spec:
  triggers:
    - id: manual
      type: manual
  nodes: []
  edges: []
`;
    let yaml = empty;
    for (const type of CORE_NEUTRAL_NODE_TYPES) {
      yaml = insertCoreNode(yaml, type).yaml;
    }
    const nodes = listYamlNodes(yaml);
    assert.equal(nodes.length, CORE_NEUTRAL_NODE_TYPES.length);
    for (const type of CORE_NEUTRAL_NODE_TYPES) {
      const node = nodes.find((item) => item.type === type);
      assert.ok(node, type);
      const expected = defaultCoreWith(type);
      for (const key of Object.keys(expected)) {
        assert.ok(key in node.with, `${type} missing with.${key}`);
      }
    }
  });

  it("replaces nodes: [] with a list item", () => {
    const yaml = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: empty-nodes
spec:
  triggers:
    - id: manual
      type: manual
  nodes: []
  edges: []
`;
    const inserted = insertCoreNode(yaml, "data.set");
    assert.match(inserted.yaml, /nodes:\n {4}- id: set/);
    assert.doesNotMatch(inserted.yaml, /nodes: \[\]/);
  });
});

describe("config serialization", () => {
  it("serializes bounded with fields and rejects secrets and expressions", () => {
    assert.deepEqual(serializeCoreWith({ type: "flow.delay", duration: "PT5M" }).with, {
      duration: "PT5M",
    });
    assert.deepEqual(
      serializeCoreWith({
        type: "flow.condition",
        op: "eq",
        path: "status",
        compare: "ready",
      }).with,
      { op: "eq", path: "status", compare: "ready" },
    );
    const mapped = serializeCoreWith({
      type: "data.map",
      mapping: [{ from: "input.status", to: "result.state" }],
    });
    assert.deepEqual(mapped.with, {
      mapping: [{ from: "input.status", to: "result.state" }],
    });

    const secret = serializeCoreWith({
      type: "data.set",
      fields: [{ key: "password", kind: "string", value: "hunter2" }],
    });
    assert.ok(secret.errors.some((error) => /not allowed/.test(error)));
    assert.deepEqual(secret.with.value, {});

    const token = serializeCoreWith({
      type: "data.set",
      fields: [{ key: "note", kind: "string", value: "Bearer abc" }],
    });
    assert.ok(token.errors.some((error) => /secret material/.test(error)));

    const expr = serializeCoreWith({
      type: "data.map",
      mapping: [{ from: "{{ input.status }}", to: "result.state" }],
    });
    assert.ok(expr.errors.some((error) => /expression/.test(error)));

    const fail = serializeCoreWith({
      type: "flow.fail",
      status: "failure",
      code: "operator-failed",
      message: "Stopped by operator policy.",
    });
    assert.equal(fail.errors.length, 0);
    assert.equal(fail.with.code, "operator-failed");
  });

  it("updates an existing node block from the inspector config", () => {
    const inserted = insertCoreNode(STARTER_WORKFLOW_YAML, "flow.condition");
    const applied = applyCoreNodeConfig(inserted.yaml, inserted.node.id, "Check ready", {
      type: "flow.condition",
      op: "eq",
      path: "status",
      compare: "ready",
    });
    assert.equal(applied.errors.length, 0);
    assert.ok(applied.yaml);
    assert.match(applied.yaml ?? "", /name: Check ready/);
    assert.match(applied.yaml ?? "", /op: eq/);
    assert.match(applied.yaml ?? "", /path: status/);
    const node = listYamlNodes(applied.yaml ?? "").find((item) => item.id === "condition");
    assert.deepEqual(node?.with, { op: "eq", path: "status", compare: "ready" });
  });

  it("round-trips starter data.set/flow.stop through parse + serialize", () => {
    const nodes = listYamlNodes(STARTER_WORKFLOW_YAML);
    assert.equal(nodes.length, 2);
    const seed = nodes[0];
    assert.equal(seed?.type, "data.set");
    assert.deepEqual(seed?.with, { value: { status: "ready" } });
    const config = configFromNode(seed!);
    assert.equal(config?.type, "data.set");
    if (config?.type === "data.set") {
      assert.deepEqual(config.fields, [{ key: "status", kind: "string", value: "ready" }]);
    }
    const updated = updateYamlNode(STARTER_WORKFLOW_YAML, {
      id: "seed",
      type: "data.set",
      name: "Seed value",
      with: { value: { status: "ready", count: 2 } },
    });
    assert.ok(updated);
    assert.match(updated ?? "", /count: 2/);
    const block = serializeNodeBlock({
      id: "validate",
      type: "data.validate",
      name: "Validate data",
      with: { schema: "88888888-8888-4888-8888-888888888888" },
    });
    assert.match(block, /type: data\.validate/);
    assert.match(block, /schema: 88888888-8888-4888-8888-888888888888/);
  });
});
