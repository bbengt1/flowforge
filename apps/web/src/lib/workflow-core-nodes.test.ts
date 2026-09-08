import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptCoreNeutralPalette,
  catalogHasNonNeutralCore,
  CORE_NEUTRAL_NODE_TYPES,
  filterCoreNeutralNodes,
  filterPaletteEntries,
  isCoreNeutralNodeType,
} from "./workflow-core-nodes.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  triggers: [
    { type: "manual", phase: "core", outputs: [{ name: "event", kind: "object" }] },
    { type: "event", phase: "next", outputs: [] },
  ],
  nodes: [
    {
      type: "flow.condition",
      phase: "core",
      inputs: [{ name: "value", kind: "any", required: true }],
      outputs: [
        { name: "true", kind: "any" },
        { name: "false", kind: "any" },
      ],
      requiredWith: ["op"],
      name: "API Condition",
      policy: "Catalog policy hint",
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
  it("prefers catalog ports/name/policy and mirrors missing hints", () => {
    const palette = adaptCoreNeutralPalette(catalog);
    const condition = palette.find((item) => item.type === "flow.condition");
    assert.ok(condition);
    assert.equal(condition.source, "catalog");
    assert.equal(condition.name, "API Condition");
    assert.equal(condition.policy, "Catalog policy hint");
    assert.match(condition.redaction, /secret/i);
    assert.deepEqual(
      condition.outputs.map((port) => port.name),
      ["true", "false"],
    );
  });

  it("mirrors documented entries when the catalog omits a core type", () => {
    const palette = adaptCoreNeutralPalette({
      apiVersion: "flowforge/v1",
      triggers: [],
      nodes: [{ type: "data.set", phase: "core", requiredWith: ["value"] }],
    });
    const delay = palette.find((item) => item.type === "flow.delay");
    assert.ok(delay);
    assert.equal(delay.source, "documented-mirror");
    assert.equal(delay.requiredWith[0], "duration");
    const set = palette.find((item) => item.type === "data.set");
    assert.equal(set?.source, "catalog");
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
  });

  it("stays usable against the documented catalog when GET catalog is empty", () => {
    const palette = adaptCoreNeutralPalette(null);
    assert.equal(palette.length, 7);
    assert.equal(palette.every((item) => item.source === "documented-mirror"), true);
  });
});
