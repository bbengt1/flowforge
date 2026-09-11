import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDITOR_CANVAS_LAYOUT,
  R25_EPIC,
  R25_KEEP_STORY_OPEN,
  R25_STORY,
  UI_LAYOUT_VERSION,
  canvasLayoutEmbedUnchanged,
  canvasLayoutFromUi,
  parseLayoutPoint,
  parseWorkflowUILayout,
  readPersistedCanvasLayout,
  readYamlCanvasLayout,
  uiLayoutFromCanvas,
  writeCanvasLayoutYaml,
} from "./editor-canvas-layout.ts";
import { mergeCanvasPositions } from "./editor-canvas-history.ts";
import { EDITOR_CHROME } from "./editor-chrome.ts";
import { layoutGraphNodes, projectCanvasGraph } from "./workflow-graph.ts";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML, canShowSummary } from "./workflow.ts";
import type { WorkflowSummary } from "./workflow-types.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

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

function starterWithLayout(block: string): string {
  return STARTER_WORKFLOW_YAML.replace(
    "metadata:\n  name: validate-example\n",
    `metadata:\n  name: validate-example\n${block}`,
  );
}

describe("R2.5 persist metadata.ui.layout", () => {
  it("keeps #238 open and cites epic #228", () => {
    assert.equal(R25_STORY, 238);
    assert.equal(R25_EPIC, 228);
    assert.equal(R25_KEEP_STORY_OPEN, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.keep238Open, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.noAppsApiChanges, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.migrateInPlace, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.noGreenfieldPackage, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.noDraftExecute, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.layoutNeverInventGraph, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.neverSecondCanvasFile, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.missingInvalidAutoLayout, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.noEdgesTypesWithCredentialsPorts, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.noSecretField, true);
    assert.equal(EDITOR_CANVAS_LAYOUT.noExpressionLanguage, true);
    assert.equal(canvasLayoutEmbedUnchanged(), true);
    assert.equal(EDITOR_CHROME.saveNormalizesThenPutsDraft, true);
    assert.equal(EDITOR_CHROME.invalidYamlNeverGuessesGraph, true);
    assert.equal(EDITOR_CHROME.draftsCannotStart, true);
    assert.equal(UI_LAYOUT_VERSION, 1);
  });

  it("reads summary.ui.layout and YAML metadata.ui.layout", () => {
    const yaml = starterWithLayout(`  ui:
    layout:
      version: 1
      nodes:
        seed: { x: 120, y: 80 }
        done: { x: 360, y: 80 }
`);
    const fromYaml = readYamlCanvasLayout(yaml);
    assert.deepEqual(fromYaml, {
      seed: { x: 120, y: 80 },
      done: { x: 360, y: 80 },
    });

    const withSummary = readPersistedCanvasLayout(
      {
        ...summary,
        ui: {
          layout: {
            version: 1,
            nodes: {
              seed: { x: 16, y: 32 },
              ghost: { x: 99, y: 99 },
            },
          },
        },
      },
      yaml,
    );
    assert.deepEqual(withSummary, { seed: { x: 16, y: 32 } });
    assert.equal(withSummary.ghost, undefined);
    assert.equal(withSummary.done, undefined);

    const yamlOnly = readPersistedCanvasLayout(summary, yaml);
    assert.deepEqual(yamlOnly, {
      seed: { x: 120, y: 80 },
      done: { x: 360, y: 80 },
    });
  });

  it("round-trips layout through YAML write and prefers finite x/y only", () => {
    const written = writeCanvasLayoutYaml(STARTER_WORKFLOW_YAML, {
      seed: { x: 120, y: 80 },
      done: { x: 288.5, y: 48 },
    });
    assert.match(written, /ui:\n    layout:\n      version: 1\n      nodes:/);
    assert.match(written, /done: \{ x: 288\.5, y: 48 \}/);
    assert.match(written, /seed: \{ x: 120, y: 80 \}/);
    const uiBlock = written.slice(written.indexOf("  ui:"), written.indexOf("spec:"));
    assert.doesNotMatch(uiBlock, /\bedges:|\btype:|\bwith:|credential|\bports:/);

    const again = readYamlCanvasLayout(written);
    assert.deepEqual(again, {
      done: { x: 288.5, y: 48 },
      seed: { x: 120, y: 80 },
    });
    const withLabels = STARTER_WORKFLOW_YAML.replace(
      "metadata:\n  name: validate-example\n",
      "metadata:\n  name: validate-example\n  labels:\n    team: platform\n",
    );
    const replaced = writeCanvasLayoutYaml(
      writeCanvasLayoutYaml(withLabels, { seed: { x: 1, y: 2 } }),
      { seed: { x: 40, y: 60 }, done: { x: 80, y: 60 } },
    );
    assert.match(replaced, /labels:\n    team: platform\n  ui:/);
    assert.match(replaced, /seed: \{ x: 40, y: 60 \}/);
    assert.doesNotMatch(replaced, /x: 1/);
    assert.equal(writeCanvasLayoutYaml(STARTER_WORKFLOW_YAML, {}), STARTER_WORKFLOW_YAML);
    assert.deepEqual(uiLayoutFromCanvas({ seed: { x: 1, y: 2 } }), {
      version: 1,
      nodes: { seed: { x: 1, y: 2 } },
    });
    assert.equal(uiLayoutFromCanvas({}), null);
  });

  it("treats missing or invalid layout as auto-layout and strips ghost keys", () => {
    assert.deepEqual(readPersistedCanvasLayout(summary, STARTER_WORKFLOW_YAML), {});
    assert.equal(parseWorkflowUILayout(null), null);
    assert.equal(parseWorkflowUILayout("nope"), null);
    assert.equal(parseWorkflowUILayout(1), null);
    assert.equal(parseWorkflowUILayout({ version: 2, nodes: { seed: { x: 1, y: 2 } } }), null);
    assert.equal(parseWorkflowUILayout({ version: Number.NaN, nodes: {} }), null);
    assert.equal(
      parseWorkflowUILayout({
        version: 1,
        nodes: { seed: { x: 1, y: 2 } },
        edges: [{ from: "a", to: "b" }],
      }),
      null,
    );
    assert.equal(parseLayoutPoint({ x: 1, y: Number.POSITIVE_INFINITY }), null);
    assert.equal(parseLayoutPoint({ x: 1, y: 2, type: "data.set" }), null);
    assert.equal(parseLayoutPoint({ x: "nope", y: 2 }), null);

    const invalidYaml = starterWithLayout(`  ui:
    layout:
      version: 1
      nodes:
        seed: { x: .inf, y: 8 }
        done:
          x: 10
          y: foo
`);
    const parsed = readYamlCanvasLayout(invalidYaml);
    assert.deepEqual(parsed, {});

    const blockStyle = starterWithLayout(`  ui:
    layout:
      version: 1
      nodes:
        seed:
          x: 12
          y: 24
`);
    assert.deepEqual(readYamlCanvasLayout(blockStyle), { seed: { x: 12, y: 24 } });

    const ghost = canvasLayoutFromUi(
      {
        version: 1,
        nodes: {
          seed: { x: 8, y: 8 },
          invented: { x: 99, y: 99 },
        },
      },
      ["seed", "done"],
    );
    assert.deepEqual(ghost, { seed: { x: 8, y: 8 } });
    assert.equal(ghost.invented, undefined);
  });

  it("merges persisted hints onto auto-layout without inventing a graph", () => {
    const graph = projectCanvasGraph({
      errors: [],
      summary,
      yaml: STARTER_WORKFLOW_YAML,
    });
    assert.ok(graph);
    const auto = layoutGraphNodes(graph.nodes, graph.edges);
    const merged = mergeCanvasPositions(auto, {
      seed: { x: 120, y: 80 },
      ghost: { x: 9, y: 9 },
    });
    assert.equal(merged.get("seed")?.x, 120);
    assert.equal(merged.get("seed")?.y, 80);
    assert.equal(merged.has("ghost"), false);
    assert.ok(merged.has("done"));
    assert.equal(canShowSummary([], summary), true);
  });

  it("never projects a guessed graph from invalid YAML that includes layout", () => {
    const yaml = `${INVALID_WORKFLOW_YAML}metadata:\n  ui:\n    layout:\n      version: 1\n      nodes:\n        Bad_ID: { x: 8, y: 8 }\n`;
    assert.equal(
      projectCanvasGraph({
        errors: [
          {
            path: "spec.nodes[0].id",
            code: "invalid-id",
            message: "Node IDs must be DNS labels.",
          },
        ],
        summary: {
          apiVersion: "flowforge/v1",
          name: "broken",
          triggers: [],
          nodes: [{ id: "Bad_ID", type: "workflow.call", name: "Next-phase call" }],
          edges: [],
          outputs: [],
          ui: {
            layout: {
              version: 1,
              nodes: { Bad_ID: { x: 8, y: 8 } },
            },
          },
        },
        yaml,
      }),
      null,
    );
    assert.equal(mergeCanvasPositions(new Map(), { Bad_ID: { x: 8, y: 8 } }).size, 0);
  });

  it("wires load/save on the editor without draft execute or API changes", () => {
    const operator = source("components/workflows/WorkflowOperator.tsx");
    const canvas = source("components/workflows/WorkflowCanvas.tsx");
    const types = source("lib/workflow-types.ts");
    assert.match(operator, /readPersistedCanvasLayout/);
    assert.match(operator, /writeCanvasLayoutYaml/);
    assert.match(operator, /saveCanonicalWorkflowDraft/);
    assert.match(operator, /emptyCanvasHistory\(next\.yaml, readPersistedCanvasLayout/);
    assert.match(canvas, /mergeCanvasPositions/);
    assert.match(types, /WorkflowUILayout/);
    assert.match(types, /keep #238 open/);
    assert.doesNotMatch(operator, /executeDraft|runDraft|draft execute/i);
    assert.doesNotMatch(operator, /SecretField/);
    assert.doesNotMatch(operator, /apps\/api/);
    assert.doesNotMatch(canvas, /from ["']@xyflow|reactflow|react-flow/i);
    const frontend = readFileSync(
      join(here, "..", "..", "..", "..", "docs", "reference", "frontend-ui.md"),
      "utf8",
    );
    assert.match(frontend, /keep #238 open/);
    assert.doesNotMatch(frontend, /Closes #238|Fixes #238|Close #238/);
  });
});
