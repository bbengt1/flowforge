import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { problemFieldErrors } from "./problem.ts";
import {
  applyDraftResponse,
  applyNormalizeResponse,
  canShowSummary,
  coreCatalog,
  draftCompareRef,
  executionStartBody,
  isConflictProblem,
  isWorkflowExecution,
  readExecutionPayload,
  isCorePhase,
  isInvalidWorkflowProblem,
  isNormalizeResponse,
  isValidateResponse,
  offsetForLine,
  optionalCreateFields,
  publishedVersions,
  STARTER_WORKFLOW_YAML,
  summaryCounts,
  versionCompareRef,
  workflowErrorsFromProblem,
} from "./workflow.ts";
import type {
  WorkflowCatalog,
  WorkflowDraft,
  WorkflowSummary,
  WorkflowVersion,
} from "./workflow-types.ts";

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

const draft: WorkflowDraft = {
  workflowId: "11111111-1111-4111-8111-111111111111",
  revision: 2,
  definitionYaml: STARTER_WORKFLOW_YAML,
  digest: "sha256:saved",
  summary,
  warnings: [],
  validationState: "valid",
  updatedAt: "2026-09-08T21:00:00.000Z",
};

describe("applyDraftResponse", () => {
  it("replaces the editor buffer from the saved draft YAML and revision", () => {
    const applied = applyDraftResponse(draft);
    assert.ok(applied);
    assert.equal(applied.yaml, STARTER_WORKFLOW_YAML);
    assert.equal(applied.revision, 2);
    assert.equal(applied.digest, "sha256:saved");
  });

  it("rejects a draft payload that cannot replace the buffer", () => {
    assert.equal(
      applyDraftResponse({ ...draft, definitionYaml: "" }),
      null,
    );
  });
});

describe("draft conflict and run guards", () => {
  it("treats 409 conflict as a reload signal", () => {
    assert.equal(
      isConflictProblem({
        type: "urn:flowforge:problem:conflict",
        title: "Conflict",
        status: 409,
        detail: "Draft revision is stale.",
        instance: "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
        code: "conflict",
        request_id: "wf-conflict-req16",
      }),
      true,
    );
  });

  it("requires a published workflowVersionId and never a draft sentinel", () => {
    assert.equal(executionStartBody(null), null);
    assert.equal(executionStartBody("draft"), null);
    assert.equal(executionStartBody(""), null);
    assert.deepEqual(
      executionStartBody("22222222-2222-4222-8222-222222222222"),
      { workflowVersionId: "22222222-2222-4222-8222-222222222222" },
    );
    assert.deepEqual(
      executionStartBody("22222222-2222-4222-8222-222222222222", {
        idempotencyKey: "deploy-prod-1",
        input: { dryRun: true },
      }),
      {
        workflowVersionId: "22222222-2222-4222-8222-222222222222",
        idempotencyKey: "deploy-prod-1",
        input: { dryRun: true },
      },
    );
    const versions: WorkflowVersion[] = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        workflowId: draft.workflowId,
        versionNumber: 1,
        digest: "sha256:v1",
        publishNote: "first",
        publishedAt: "2026-09-08T21:00:00.000Z",
      },
    ];
    assert.equal(publishedVersions(versions).length, 1);
    assert.deepEqual(draftCompareRef(), { kind: "draft" });
    assert.deepEqual(versionCompareRef(versions[0]!.id), {
      kind: "version",
      versionId: versions[0]!.id,
    });
    assert.equal(versionCompareRef("draft"), null);
    assert.deepEqual(optionalCreateFields("  slug  ", ""), { slug: "slug" });
  });

  it("reads flattened #41 execution + pins[]", () => {
    const flattened = readExecutionPayload({
      id: "33333333-3333-4333-8333-333333333333",
      workflowId: draft.workflowId,
      workflowVersionId: "22222222-2222-4222-8222-222222222222",
      workflowDigest: "sha256:v1",
      pins: [{ kind: "policy", resourceId: draft.workflowId }],
    });
    assert.equal(isWorkflowExecution(flattened), true);
    assert.equal((flattened as { pins?: unknown[] }).pins?.length, 1);
  });
});
