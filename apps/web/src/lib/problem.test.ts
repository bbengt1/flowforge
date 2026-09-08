import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProblemContentType,
  isProblemDetails,
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
  });
});
