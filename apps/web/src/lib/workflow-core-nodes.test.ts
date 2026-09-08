import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptCoreNeutralPalette,
  catalogExcludesTriggerNodes,
  catalogHasNonNeutralCore,
  CORE_NEUTRAL_NODE_TYPES,
  filterCoreNeutralNodes,
  filterPaletteEntries,
  formatBounds,
  formatPolicy,
  formatPort,
  isCoreNeutralNodeType,
} from "./workflow-core-nodes.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  rules: {
    triggersAreWorkflowLevel: true,
    graphNodesExcludeTriggers: true,
    unsupportedPhasesRejected: true,
  },
  triggers: [
    { type: "manual", phase: "core", outputs: [{ name: "event", kind: "object" }] },
    { type: "event", phase: "next", outputs: [] },
  ],
  nodes: [
    {
      type: "flow.condition",
      phase: "core",
      title: "API Condition",
      inputs: [
        {
          name: "value",
          kind: "any",
          required: true,
          classification: "inherit",
          maxBytes: 16384,
        },
      ],
      outputs: [
        { name: "true", kind: "any", classification: "inherit", maxBytes: 16384 },
        { name: "false", kind: "any", classification: "inherit", maxBytes: 16384 },
      ],
      requiredWith: ["op"],
      allowedWith: [
        { name: "op", kind: "enum", required: true, enum: ["eq", "exists"] },
        { name: "compare", kind: "any" },
        { name: "path", kind: "string" },
      ],
      policy: {
        permissions: ["workflow.execute"],
        retrySafe: true,
        sideEffects: false,
        cancellation: "path-local",
      },
      bounds: { maxInputBytes: 16384, maxOutputBytes: 16384 },
      redaction: { strategy: "mask-classified", auditFields: ["op", "matched"] },
    },
    { type: "flow.delay", phase: "core", requiredWith: ["duration"] },
    { type: "data.set", phase: "core", requiredWith: ["value"] },
    { type: "data.map", phase: "core", requiredWith: ["mapping"] },
    { type: "data.validate", phase: "core", requiredWith: ["schema"] },
    { type: "flow.stop", phase: "core" },
    { type: "flow.fail", phase: "core" },
    { type: "kubernetes.apply", phase: "core", requiredWith: ["clusterTargetId"] },
    { type: "flow.approval", phase: "core", requiredWith: ["approverRole"] },
    { type: "workflow.call", phase: "next" },
    { type: "servicenow.ticket", phase: "provider" },
    { type: "mystery.action", phase: "experimental" },
  ],
};

describe("filterCoreNeutralNodes", () => {
  it("keeps the seven E3.3 types and fail-closes next/provider/other core", () => {
    const filtered = filterCoreNeutralNodes(catalog.nodes);
    assert.deepEqual(
      filtered.map((item) => item.type),
      [...CORE_NEUTRAL_NODE_TYPES],
    );
    assert.equal(filtered.some((item) => item.type === "kubernetes.apply"), false);
    assert.equal(filtered.some((item) => item.type === "workflow.call"), false);
    assert.equal(isCoreNeutralNodeType("manual"), false);
    assert.equal(isCoreNeutralNodeType("flow.switch"), false);
    assert.equal(catalogHasNonNeutralCore(catalog), true);
    assert.equal(catalogExcludesTriggerNodes(catalog), true);
  });

  it("does not treat triggers as placeable nodes", () => {
    const palette = adaptCoreNeutralPalette(catalog);
    assert.equal(
      palette.some((item) => item.type === ("manual" as typeof item.type)),
      false,
    );
    assert.equal(palette.every((item) => item.phase === "core"), true);
    assert.equal(palette.length, CORE_NEUTRAL_NODE_TYPES.length);
  });
});

describe("adaptCoreNeutralPalette", () => {
  it("prefers catalog title, allowedWith, policy object, and port classification", () => {
    const palette = adaptCoreNeutralPalette(catalog);
    const condition = palette.find((item) => item.type === "flow.condition");
    assert.ok(condition);
    assert.equal(condition.source, "catalog");
    assert.equal(condition.name, "API Condition");
    assert.deepEqual(
      condition.allowedWith.map((field) => field.name),
      ["op", "compare", "path"],
    );
    assert.equal(condition.policy?.permissions?.[0], "workflow.execute");
    assert.match(formatPolicy(condition.policy), /retry-safe/);
    assert.match(formatPolicy(condition.policy), /workflow.execute/);
    assert.equal(condition.redaction?.strategy, "mask-classified");
    assert.equal(condition.inputs[0]?.classification, "inherit");
    assert.equal(condition.inputs[0]?.maxBytes, 16384);
    assert.match(formatPort(condition.inputs[0]!, "in"), /inherit/);
    assert.deepEqual(
      condition.outputs.map((port) => port.name),
      ["true", "false"],
    );
  });

  it("uses the #32 contract fallback when a core type is omitted or thin", () => {
    const palette = adaptCoreNeutralPalette({
      apiVersion: "flowforge/v1",
      triggers: [],
      nodes: [{ type: "data.set", phase: "core", requiredWith: ["value"] }],
    });
    const delay = palette.find((item) => item.type === "flow.delay");
    assert.ok(delay);
    assert.equal(delay.source, "contract-fallback");
    assert.equal(delay.requiredWith[0], "duration");
    assert.equal(delay.bounds?.maxDurationSeconds, 7 * 24 * 60 * 60);
    assert.match(formatBounds(delay.bounds), /P7D/);
    const set = palette.find((item) => item.type === "data.set");
    assert.equal(set?.source, "contract-fallback");
    assert.ok((set?.allowedWith.length ?? 0) > 0);
  });

  it("filters the palette by type, name, ports, and family", () => {
    const palette = adaptCoreNeutralPalette(catalog);
    assert.deepEqual(
      filterPaletteEntries(palette, "delay").map((item) => item.type),
      ["flow.delay"],
    );
    assert.deepEqual(
      filterPaletteEntries(palette, "true").map((item) => item.type),
      ["flow.condition"],
    );
    assert.equal(filterPaletteEntries(palette, "lifecycle").length, 2);
    assert.equal(filterPaletteEntries(palette, "manual").length, 0);
    assert.ok(filterPaletteEntries(palette, "compare").length >= 1);
  });

  it("stays usable from the #32 contract when GET catalog is empty", () => {
    const palette = adaptCoreNeutralPalette(null);
    assert.equal(palette.length, 7);
    assert.equal(palette.every((item) => item.source === "contract-fallback"), true);
    assert.equal(
      palette.find((item) => item.type === "flow.fail")?.requiredWith.includes("code"),
      true,
    );
  });
});
