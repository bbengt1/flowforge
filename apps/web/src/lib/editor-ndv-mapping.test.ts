import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_NDV_MAPPING,
  JONNY_PORT_TYPING_INCOMPLETE,
  NDV_MAPPING_CONVERT_KINDS,
  NDV_MAPPING_RAIL_SOURCES,
  NDV_MAX_FIELD_PATH_DEPTH,
  NDV_MAX_MAPPING_ENTRIES,
  R32_EPIC,
  R32_KEEP_STORY_OPEN,
  R32_STORY,
  compatibleUpstreamPortOptions,
  isNdvFieldPath,
  localNdvMappingErrors,
  mappingObjectFromRows,
  ndvDestAcceptsFieldPathMapping,
  ndvFieldKindsCompatible,
  ndvFieldPathError,
  ndvLooksLikeExpression,
  ndvMappingEmbedUnchanged,
  ndvMappingIsEdit,
  ndvMappingNeverGuessesGraph,
  ndvMappingSourceForbidsExpressionLanguage,
  ndvMappingSourceForbidsInventedRoutes,
  ndvMappingSourceForbidsSecretSurface,
  ndvMappingValidationLinks,
  ndvPortKindsCompatible,
  ndvPortTypingIncomplete,
  ndvPortWiresForNode,
  ndvWizardRemainsAdd,
  rowsFromMappingValue,
  suggestNdvFieldPaths,
  validateNdvTypedMapping,
} from "./editor-ndv-mapping.ts";
import { EDITOR_INSPECTOR } from "./editor-inspector.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";
import type { WorkflowCatalog } from "./workflow-types.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function entry(
  type: string,
  extras: Partial<ActionLibraryEntry> = {},
): ActionLibraryEntry {
  return {
    type,
    name: type,
    description: type,
    phase: "core",
    family: "data",
    enabled: true,
    placeable: true,
    inputs: [],
    outputs: [],
    requiredWith: [],
    allowedWith: [],
    policy: null,
    bounds: null,
    redaction: null,
    source: "catalog",
    ...extras,
  };
}

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  triggers: [],
  nodes: [
    {
      type: "data.set",
      phase: "core",
      outputs: [{ name: "result", kind: "object" }],
    },
    {
      type: "data.map",
      phase: "core",
      inputs: [{ name: "input", kind: "object", required: true }],
      outputs: [{ name: "result", kind: "object" }],
      allowedWith: [{ name: "mapping", kind: "mapping", required: true }],
    },
    {
      type: "flow.condition",
      phase: "core",
      inputs: [{ name: "value", kind: "any", required: true }],
      outputs: [
        { name: "true", kind: "any" },
        { name: "false", kind: "any" },
      ],
      allowedWith: [
        { name: "op", kind: "enum", required: true },
        { name: "path", kind: "string" },
      ],
    },
    {
      type: "flow.stop",
      phase: "core",
      inputs: [{ name: "input", kind: "any" }],
      outputs: [{ name: "result", kind: "object" }],
    },
  ],
};

const entries = catalog.nodes.map((node) =>
  entry(node.type, {
    inputs: node.inputs ?? [],
    outputs: node.outputs ?? [],
    allowedWith: node.allowedWith ?? [],
    family: node.type.startsWith("flow.") ? "control" : "data",
  }),
);

describe("R3.2 NDV typed field-path mapping", () => {
  it("keeps #247 open and cites epic #229", () => {
    assert.equal(R32_STORY, 247);
    assert.equal(R32_EPIC, 229);
    assert.equal(R32_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_NDV_MAPPING.keep247Open, true);
    assert.equal(EDITOR_NDV_MAPPING.typedFieldPathMapping, true);
    assert.equal(EDITOR_NDV_MAPPING.usesAllowedWithAndCatalogPortTypes, true);
    assert.equal(EDITOR_NDV_MAPPING.jonnyIfPortTypingIncomplete, true);
  });

  it("keeps the wizard as guided add and the NDV as edit", () => {
    assert.equal(EDITOR_NDV_MAPPING.wizardIsAdd, true);
    assert.equal(EDITOR_NDV_MAPPING.inspectorIsEdit, true);
    assert.equal(ndvWizardRemainsAdd(), true);
    assert.equal(ndvMappingIsEdit(), true);
    assert.equal(EDITOR_NDV_MAPPING.noSecretField, true);
    assert.equal(EDITOR_NDV_MAPPING.displayNamePlusUuidOnly, true);
    assert.equal(EDITOR_NDV_MAPPING.noExpressionLanguage, true);
    assert.equal(EDITOR_NDV_MAPPING.noInventedApiRoutes, true);
    assert.equal(EDITOR_NDV_MAPPING.noAppsApiChanges, true);
    assert.equal(EDITOR_NDV_MAPPING.noDraftExecute, true);
    assert.equal(EDITOR_NDV_MAPPING.edgesRemainNodePort, true);
    assert.equal(ndvMappingEmbedUnchanged(), true);
    assert.equal(EDITOR_INSPECTOR.validationErrorsLinkToNodeOrYaml, true);
    assert.equal(EDITOR_NDV_MAPPING.validationLinksStillWork, true);
  });

  it("accepts dotted identifier paths and rejects expressions", () => {
    assert.equal(isNdvFieldPath("input.status"), true);
    assert.equal(isNdvFieldPath("result.state"), true);
    assert.equal(isNdvFieldPath("a.b.c.d.e.f.g.h"), true);
    assert.equal(isNdvFieldPath("a.b.c.d.e.f.g.h.i"), false);
    assert.equal(NDV_MAX_FIELD_PATH_DEPTH, 8);
    assert.equal(isNdvFieldPath("{{ input.status }}"), false);
    assert.equal(isNdvFieldPath("${input.status}"), false);
    assert.equal(isNdvFieldPath("foo || bar"), false);
    assert.equal(ndvLooksLikeExpression("{{ input.status }}"), true);
    assert.equal(ndvLooksLikeExpression("${foo}"), true);
    assert.match(ndvFieldPathError("{{ x }}", "Source") ?? "", /not an expression/);
    assert.match(ndvFieldPathError("password", "Destination") ?? "", /secret-shaped/);
    assert.match(ndvFieldPathError("token.secret", "Source") ?? "", /secret-shaped/);
    assert.deepEqual([...NDV_MAPPING_CONVERT_KINDS], [
      "string",
      "integer",
      "boolean",
      "object",
    ]);
  });

  it("blocks incompatible port kinds and convert mismatches", () => {
    assert.equal(ndvPortKindsCompatible("object", "object"), true);
    assert.equal(ndvPortKindsCompatible("object", "any"), true);
    assert.equal(ndvPortKindsCompatible("object", "string"), false);
    assert.equal(ndvFieldKindsCompatible({
      fromKind: "object",
      toKind: "object",
    }).ok, true);
    assert.equal(ndvFieldKindsCompatible({
      fromKind: "string",
      toKind: "integer",
      convert: "integer",
    }).ok, true);
    assert.equal(ndvFieldKindsCompatible({
      fromKind: "object",
      toKind: "string",
    }).ok, false);
    assert.match(
      ndvFieldKindsCompatible({
        fromKind: "object",
        toKind: "string",
      }).reason,
      /not compatible/,
    );
    assert.match(
      ndvFieldKindsCompatible({ convert: "array" }).reason,
      /convert must be/,
    );
  });

  it("validates data.map field-path rows and writes YAML-safe mapping", () => {
    const ok = validateNdvTypedMapping(
      [{ dest: "result.state", from: "input.status" }],
      {
        nodeId: "map",
        nodeIndex: 1,
        fromKind: "object",
        destKind: "object",
        allowedWith: [{ name: "mapping", kind: "mapping", required: true }],
      },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.fieldErrors.length, 0);
    assert.deepEqual(
      mappingObjectFromRows([
        { dest: "result.state", from: "input.status" },
        { dest: "result.count", from: "input.n", convert: "integer" },
      ]),
      {
        "result.state": "input.status",
        "result.count": { from: "input.n", convert: "integer" },
      },
    );

    const forbidden = validateNdvTypedMapping(
      [{ dest: "result.state", from: "{{ input.status }}" }],
      { nodeIndex: 1, fromKind: "object", destKind: "object" },
    );
    assert.equal(forbidden.ok, false);
    assert.equal(
      forbidden.fieldErrors.some((error) => error.code === "expression-forbidden"),
      true,
    );
    assert.equal(
      forbidden.fieldErrors[0]?.path,
      "spec.nodes[1].with.mapping.result.state",
    );

    const tooMany = validateNdvTypedMapping(
      Array.from({ length: NDV_MAX_MAPPING_ENTRIES + 1 }, (_, index) => ({
        dest: `dest${index}`,
        from: `from${index}`,
      })),
    );
    assert.equal(tooMany.ok, false);
    assert.equal(
      tooMany.fieldErrors.some((error) => error.code === "aggregation-limit"),
      true,
    );
  });

  it("explains incomplete catalog port typing instead of inventing schemas", () => {
    const missing = ndvPortTypingIncomplete(undefined, "vendor.unknown");
    assert.equal(missing.incomplete, true);
    assert.match(missing.reason ?? "", /Ping jonny/);
    assert.match(JONNY_PORT_TYPING_INCOMPLETE, /Ping jonny/);

    const noKind = ndvPortTypingIncomplete(
      entry("data.map", {
        inputs: [{ name: "input", kind: "" }],
        outputs: [{ name: "result", kind: "object" }],
      }),
      "data.map",
    );
    assert.equal(noKind.incomplete, true);
    assert.match(noKind.reason ?? "", /missing kind/);

    const complete = ndvPortTypingIncomplete(
      entry("data.map", {
        inputs: [{ name: "input", kind: "object" }],
        outputs: [{ name: "result", kind: "object" }],
      }),
      "data.map",
    );
    assert.equal(complete.incomplete, false);
    assert.equal(ndvDestAcceptsFieldPathMapping("data.map", "input"), true);
    assert.equal(ndvDestAcceptsFieldPathMapping("flow.condition", "value"), true);
    assert.equal(ndvDestAcceptsFieldPathMapping("flow.stop", "input"), false);
  });

  it("wires incoming ports with catalog types and blocks incompatible maps", () => {
    const nodes = [
      {
        id: "seed",
        type: "data.set",
        name: "Seed",
        with: { value: { status: "ready" } },
        startLine: 1,
        endLine: 2,
      },
      {
        id: "map",
        type: "data.map",
        name: "Map",
        with: { mapping: { "result.state": "input.status" } },
        startLine: 3,
        endLine: 4,
      },
    ];
    const wires = ndvPortWiresForNode({
      node: nodes[1]!,
      nodes,
      edges: [{ from: "seed.result", to: "map.input" }],
      catalog,
      entries,
      nodeIndex: 1,
    });
    assert.equal(wires.length, 1);
    assert.equal(wires[0]?.from, "seed.result");
    assert.equal(wires[0]?.compatible, true);
    assert.equal(wires[0]?.yamlPath, "spec.nodes[1].inputs.input");

    const options = compatibleUpstreamPortOptions(
      nodes,
      nodes[1]!,
      { name: "input", kind: "object", required: true },
      catalog,
      entries,
    );
    assert.equal(
      options.some((item) => item.from === "seed.result"),
      true,
    );

    const local = localNdvMappingErrors(
      nodes,
      [{ from: "seed.result", to: "map.input", startLine: 1, endLine: 1 }],
      catalog,
      entries,
    );
    assert.equal(local.length, 0);

    const bad = localNdvMappingErrors(
      [
        nodes[0]!,
        {
          ...nodes[1]!,
          with: { mapping: { "result.state": "{{ input.status }}" } },
        },
      ],
      [{ from: "seed.result", to: "map.input", startLine: 1, endLine: 1 }],
      catalog,
      entries,
    );
    assert.ok(bad.some((error) => error.code === "expression-forbidden"));
    assert.ok(bad.some((error) => error.path.includes("with.mapping")));
  });

  it("keeps validation links to node and YAML paths, including mapping errors", () => {
    const links = ndvMappingValidationLinks(
      [
        { path: "metadata.name", code: "invalid-id", message: "bad name" },
        {
          path: "spec.nodes[1].with.mapping.result.state",
          code: "expression-forbidden",
          message: "Source must be a field path, not an expression.",
        },
        { path: "spec.edges[0]", code: "incompatible-ports", message: "seed.result" },
      ],
      [{ id: "seed" }, { id: "map" }],
      [{ from: "seed.result", to: "map.input" }],
    );
    assert.equal(links.workflow.length, 1);
    assert.equal(links.node.length, 1);
    assert.equal(links.edge.length, 1);
    assert.ok(links.nodeIds.includes("map") || links.nodeIds.includes("seed"));
    assert.ok(
      links.yamlPaths.includes("spec.nodes[1].with.mapping.result.state"),
    );
    assert.equal(EDITOR_INSPECTOR.validationErrorsLinkToNodeOrYaml, true);
  });

  it("never guesses a canvas graph from invalid YAML", () => {
    assert.equal(
      ndvMappingNeverGuessesGraph({
        errors: [
          {
            path: "spec.nodes[0].with.mapping",
            code: "expression-forbidden",
            message: "bad",
          },
        ],
        summary: {
          apiVersion: "flowforge/v1",
          name: "broken",
          triggers: [],
          nodes: [],
          edges: [],
          outputs: [],
        },
        yaml: "not: valid",
      }),
      true,
    );
  });

  it("suggests redacted last-run field paths and skips secret keys", () => {
    assert.deepEqual(
      suggestNdvFieldPaths({
        status: "ready",
        count: 2,
        token: "[redacted]",
        nested: { state: "ok" },
      }),
      ["status", "count", "nested.state"],
    );
    assert.deepEqual(
      rowsFromMappingValue({ "result.state": "input.status" }),
      [{ dest: "result.state", from: "input.status" }],
    );
    assert.deepEqual(
      rowsFromMappingValue({
        "result.count": { from: "input.n", convert: "integer" },
      }),
      [{ dest: "result.count", from: "input.n", convert: "integer" }],
    );
  });

  it("forbids SecretField, expressions, and invented routes in rail sources", () => {
    for (const relative of NDV_MAPPING_RAIL_SOURCES) {
      const text = source(relative.replace("src/", ""));
      assert.equal(ndvMappingSourceForbidsSecretSurface(text), true, relative);
      assert.equal(ndvMappingSourceForbidsExpressionLanguage(text), true, relative);
      assert.equal(ndvMappingSourceForbidsInventedRoutes(text), true, relative);
      assert.equal(text.includes("SecretField"), false, relative);
      assert.equal(text.includes('type="password"'), false, relative);
      assert.equal(text.includes("{{"), false, relative);
    }
  });
});
