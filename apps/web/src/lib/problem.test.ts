import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProblemContentType,
  isProblemDetails,
  problemBannerHeading,
  problemFieldErrors,
  safeProblemDetail,
  unreachableProblem,
} from "./problem.ts";

describe("isProblemContentType", () => {
  it("matches application/problem+json with or without parameters", () => {
    assert.equal(isProblemContentType("application/problem+json"), true);
    assert.equal(
      isProblemContentType("application/problem+json; charset=utf-8"),
      true,
    );
    assert.equal(isProblemContentType("application/json"), false);
  });
});

describe("isProblemDetails", () => {
  it("requires the documented problem fields", () => {
    const problem = unreachableProblem("/api/control-plane/readiness", "id-16-characters");
    assert.equal(isProblemDetails(problem), true);
    assert.equal(isProblemDetails({ status: "ok" }), false);
    assert.equal(isProblemDetails(null), false);
  });
});

describe("problemFieldErrors", () => {
  it("keeps invalid-workflow errors[] and ignores malformed rows", () => {
    const problem = {
      type: "urn:flowforge:problem:invalid-workflow",
      title: "Invalid Workflow",
      status: 400,
      detail: "The workflow definition is not valid.",
      instance: "/api/v1/workflows/validate",
      code: "invalid-workflow",
      request_id: "id-16-characters",
      errors: [
        {
          path: "spec.nodes[0].type",
          line: 12,
          column: 7,
          code: "unsupported-node",
          message: "workflow.call is not enabled.",
        },
        { code: 1, message: "bad" },
      ],
    };
    assert.equal(isProblemDetails(problem), true);
    const errors = problemFieldErrors(problem);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.path, "spec.nodes[0].type");
    assert.equal(errors[0]?.line, 12);
    assert.equal(errors[0]?.code, "unsupported-node");
  });
});

describe("safeProblemDetail", () => {
  it("omits details that look like secrets or connection strings", () => {
    assert.equal(
      safeProblemDetail("PostgreSQL is not reachable"),
      "PostgreSQL is not reachable",
    );
    assert.match(
      safeProblemDetail("password=super-secret"),
      /Sensitive detail was omitted/,
    );
    assert.match(
      safeProblemDetail("postgres://flowforge:replace-with-local-password@postgres/db"),
      /Sensitive detail was omitted/,
    );
    assert.equal(
      problemBannerHeading({ title: "Conflict", status: 409 }),
      "Conflict (409)",
    );
  });
});
