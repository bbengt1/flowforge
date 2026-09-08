import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProblemDetails } from "./problem.ts";
import {
  csrfRequiredProblem,
  formatSessionCountdown,
  isCsrfProblem,
  isStaleSessionProblem,
  parseBrowserSession,
  remainingSessionMs,
  sessionExpiryState,
} from "./session.ts";

function problem(partial: Partial<ProblemDetails> & Pick<ProblemDetails, "code" | "status">): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${partial.code}`,
    title: partial.title ?? "Problem",
    status: partial.status,
    detail: partial.detail ?? "detail",
    instance: "/api/control-plane/session",
    code: partial.code,
    request_id: "req-id-16charsxxx",
  };
}

describe("parseBrowserSession", () => {
  it("requires a subject and accepts csrf_token / expires_at", () => {
    assert.equal(parseBrowserSession(null), null);
    assert.equal(parseBrowserSession({ issuer: "https://idp" }), null);
    const parsed = parseBrowserSession({
      issuer: "https://idp",
      subject: "operator-chloe",
      display_name: "Chloe",
      expires_at: "2026-09-08T20:00:00.000Z",
      csrf_token: "csrf-abc",
    });
    assert.deepEqual(parsed, {
      issuer: "https://idp",
      subject: "operator-chloe",
      displayName: "Chloe",
      expiresAt: "2026-09-08T20:00:00.000Z",
      csrfToken: "csrf-abc",
    });
  });
});

describe("session expiry UX", () => {
  const now = Date.parse("2026-09-08T19:00:00.000Z");

  it("counts down and warns in the last five minutes", () => {
    assert.equal(remainingSessionMs("2026-09-08T19:10:00.000Z", now), 10 * 60 * 1000);
    assert.equal(sessionExpiryState("2026-09-08T19:10:00.000Z", now), "ok");
    assert.equal(sessionExpiryState("2026-09-08T19:04:00.000Z", now), "warning");
    assert.equal(sessionExpiryState("2026-09-08T18:59:00.000Z", now), "expired");
    assert.equal(sessionExpiryState(null, now), "unknown");
    assert.equal(
      formatSessionCountdown("2026-09-08T19:04:05.000Z", now),
      "Expires in 4m 5s",
    );
    assert.equal(formatSessionCountdown("2026-09-08T18:00:00.000Z", now), "Session expired");
  });
});

describe("session problem mapping", () => {
  it("maps 401 unauthenticated/stale-session as stale", () => {
    assert.equal(
      isStaleSessionProblem(problem({ status: 401, code: "unauthenticated" })),
      true,
    );
    assert.equal(
      isStaleSessionProblem(problem({ status: 401, code: "stale-session" })),
      true,
    );
    assert.equal(
      isStaleSessionProblem(problem({ status: 403, code: "forbidden" })),
      false,
    );
  });

  it("maps csrf-required/invalid and csrf-worded 403 as CSRF fail-closed", () => {
    assert.equal(
      isCsrfProblem(problem({ status: 403, code: "csrf-required" })),
      true,
    );
    assert.equal(
      isCsrfProblem(problem({ status: 403, code: "csrf-invalid" })),
      true,
    );
    assert.equal(
      isCsrfProblem(
        problem({
          status: 403,
          code: "forbidden",
          title: "Forbidden",
          detail: "CSRF token missing",
        }),
      ),
      true,
    );
    assert.equal(
      isCsrfProblem(problem({ status: 403, code: "forbidden", detail: "not a member" })),
      false,
    );
    const local = csrfRequiredProblem("/api/control-plane/tenants", "req-id-16charsxxx");
    assert.equal(local.code, "csrf-required");
    assert.equal(local.status, 403);
  });
});
