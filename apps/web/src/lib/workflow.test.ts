import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { problemFieldErrors } from "./problem.ts";
import {
  applyNormalizeResponse,
  canShowSummary,
  coreCatalog,
  isCorePhase,
  isInvalidWorkflowProblem,
  isNormalizeResponse,
  isValidateResponse,
  offsetForLine,
  STARTER_WORKFLOW_YAML,
  summaryCounts,
  workflowErrorsFromProblem,
} from "./workflow.ts";
import type { WorkflowCatalog, WorkflowSummary } from "./workflow-types.ts";

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
  triggers: [
    { type: "manual", phase: "core", outputs: [] },
    { type: "event", phase: "next", outputs: [] },
  ],
  nodes: [
    { type: "data.set", phase: "core", requiredWith: ["value"] },
    { type: "workflow.call", phase: "next" },
    { type: "servicenow.ticket", phase: "provider" },
    { type: "mystery.action", phase: "experimental" },
    { type: "missing-phase", phase: "" },
  ],
};

describe("coreCatalog", () => {
  it("lists phase: core only and fail-closes next/provider/unknown", () => {
    const filtered = coreCatalog(catalog);
    assert.deepEqual(
      filtered.triggers.map((item) => item.type),
      ["manual"],
    );
    assert.deepEqual(
      filtered.nodes.map((item) => item.type),
      ["data.set"],
    );
    assert.equal(isCorePhase("next"), false);
    assert.equal(isCorePhase("provider"), false);
    assert.equal(isCorePhase(undefined), false);
    assert.equal(isCorePhase(""), false);
  });
});

describe("invalid-workflow errors", () => {
  it("surfaces path/line/column/code/message and does not fabricate a graph", () => {
    const problem = {
      type: "urn:flowforge:problem:invalid-workflow",
      title: "Invalid Workflow",
      status: 400,
      detail: "The workflow definition is not valid.",
      instance: "/api/v1/workflows/validate",
      code: "invalid-workflow",
      request_id: "wf-error-request16",
      errors: [
        {
          path: "spec.nodes[0].id",
          line: 9,
          column: 7,
          code: "invalid-id",
          message: "Node IDs must be DNS labels.",
        },
        {
          path: "spec.nodes[0].type",
          line: 10,
          column: 7,
          code: "unsupported-node",
          message: "workflow.call is not enabled.",
        },
      ],
    };
    assert.equal(isInvalidWorkflowProblem(problem), true);
    const errors = workflowErrorsFromProblem(problem);
    assert.equal(errors.length, 2);
    assert.equal(errors[0]?.path, "spec.nodes[0].id");
    assert.equal(errors[0]?.line, 9);
    assert.equal(errors[0]?.column, 7);
    assert.equal(errors[0]?.code, "invalid-id");
    assert.equal(canShowSummary(errors, summary), false);
    assert.equal(problemFieldErrors(problem).length, 2);
  });

  it("does not invent errors or a summary from a non-workflow problem", () => {
    const problem = {
      type: "urn:flowforge:problem:forbidden",
      title: "Forbidden",
      status: 403,
      detail: "You are not authorized to perform this action.",
      instance: "/api/v1/workflows/validate",
      code: "forbidden",
      request_id: "wf-forbid-request1",
    };
    assert.deepEqual(workflowErrorsFromProblem(problem), []);
    assert.equal(canShowSummary([], null), false);
  });
});

describe("applyNormalizeResponse", () => {
  it("replaces the editor buffer and digest from the API response only", () => {
    const applied = applyNormalizeResponse({
      definitionYaml: STARTER_WORKFLOW_YAML,
      digest: "sha256:abc123",
      summary,
      warnings: [],
    });
    assert.ok(applied);
    assert.equal(applied.yaml, STARTER_WORKFLOW_YAML);
    assert.equal(applied.digest, "sha256:abc123");
    assert.deepEqual(summaryCounts(applied.summary), {
      triggers: 1,
      nodes: 2,
      edges: 1,
      outputs: 0,
    });
    assert.equal(canShowSummary(applied.warnings, applied.summary), true);
  });

  it("rejects a normalize payload that is missing yaml or digest", () => {
    assert.equal(
      applyNormalizeResponse({
        definitionYaml: "",
        digest: "sha256:abc",
        summary,
        warnings: [],
      }),
      null,
    );
    assert.equal(isNormalizeResponse({ digest: "sha256:abc" }), false);
    assert.equal(isValidateResponse({ valid: false, summary }), false);
    assert.equal(isValidateResponse({ valid: true, summary }), true);
  });
});

describe("yaml line offsets", () => {
  it("maps a 1-based line to a buffer offset for editor linking", () => {
    const yaml = "one\ntwo\nthree";
    assert.equal(offsetForLine(yaml, 1), 0);
    assert.equal(offsetForLine(yaml, 2), 4);
    assert.equal(offsetForLine(yaml, 3), 8);
  });
});
