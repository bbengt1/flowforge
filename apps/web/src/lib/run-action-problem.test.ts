import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExecutionForbidden } from "./execution.ts";
import type { ProblemDetails } from "./problem.ts";
import { runActionFailure } from "./run-action-problem.ts";

function problem(status: number, code: string, detail = "refused"): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: "Problem",
    status,
    detail,
    instance: "/executions/x/retry",
    code,
    request_id: "req-630",
  };
}

describe("runActionFailure (#630)", () => {
  it("treats a 403 forbidden as a role refusal and never reaches the page", () => {
    const failure = runActionFailure(problem(403, "forbidden"), 403);
    assert.deepEqual(failure, {
      roleRefused: true,
      pageProblem: null,
      actionProblem: null,
    });
  });

  it("uses the status code even when the body status or code is missing", () => {
    const bare = { ...problem(0, ""), status: 0 };
    assert.equal(runActionFailure(bare, 403).roleRefused, true);
    assert.equal(runActionFailure(bare, 403).pageProblem, null);
  });

  it("uses the forbidden code even when the status is not 403", () => {
    const failure = runActionFailure(problem(400, "forbidden"), 400);
    assert.equal(failure.roleRefused, true);
    assert.equal(failure.pageProblem, null);
  });

  it("keeps session-gate 403s as a banner without swapping the page", () => {
    for (const code of [
      "csrf-required",
      "csrf-invalid",
      "mfa-required",
      "password_change_required",
    ]) {
      const gate = problem(403, code);
      const failure = runActionFailure(gate, 403);
      assert.equal(failure.roleRefused, false, code);
      assert.equal(failure.pageProblem, null, code);
      assert.equal(failure.actionProblem, gate, code);
    }
  });

  it("reads the server's CSRF rejection (403 forbidden) as a session check", () => {
    // core/session.go answers a CSRF mismatch with code `forbidden`.
    const csrf = problem(403, "forbidden", "CSRF validation failed.");
    const failure = runActionFailure(csrf, 403);
    assert.equal(failure.roleRefused, false);
    assert.equal(failure.pageProblem, null);
    assert.equal(failure.actionProblem, csrf);
  });

  it("counts the response status for CSRF when the body status is missing", () => {
    const csrf = { ...problem(0, "forbidden", "CSRF validation failed."), status: 0 };
    assert.equal(runActionFailure(csrf, 403).actionProblem, csrf);
  });

  it("reads MFA and password-change by code only, not message text", () => {
    const failure = runActionFailure(
      problem(403, "forbidden", "mfa-required; password_change_required"),
      403,
    );
    assert.equal(failure.roleRefused, true);
    assert.equal(failure.actionProblem, null);
  });

  it("passes other errors to the page unchanged", () => {
    for (const [status, code] of [
      [409, "conflict"],
      [404, "not-found"],
      [500, "upstream-error"],
      [401, "unauthenticated"],
    ] as const) {
      const other = problem(status, code);
      const failure = runActionFailure(other, status);
      assert.equal(failure.roleRefused, false);
      assert.equal(failure.pageProblem, other);
      assert.equal(failure.actionProblem, null);
    }
  });

  it("never hands the page a problem that would show the forbidden view", () => {
    const cases: [ProblemDetails, number][] = [
      [problem(403, "forbidden"), 403],
      [problem(403, "policy-denied"), 403],
      [problem(403, "csrf-invalid"), 403],
      [problem(400, "forbidden"), 400],
      [problem(409, "conflict"), 409],
    ];
    for (const [item, status] of cases) {
      assert.equal(isExecutionForbidden(runActionFailure(item, status).pageProblem), false);
    }
  });
});
