import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProblemDetails } from "./problem.ts";
import {
  csrfRequiredProblem,
  effectiveExpiresAt,
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
    instance: "/api/v1/session",
    code: partial.code,
    request_id: "req-id-16charsxxx",
  };
}

describe("parseBrowserSession", () => {
  it("reads #22 {session,principal,csrf_token} and idle/absolute expiry", () => {
    assert.equal(parseBrowserSession(null), null);
    assert.equal(parseBrowserSession({ issuer: "https://idp" }), null);
    const parsed = parseBrowserSession({
      session: {
        id: "sess-1",
        created_at: "2026-09-08T19:00:00.000Z",
        last_seen_at: "2026-09-08T19:00:00.000Z",
        idle_expires_at: "2026-09-08T19:30:00.000Z",
        absolute_expires_at: "2026-09-09T07:00:00.000Z",
      },
      principal: {
        issuer: "https://idp",
        external_subject: "operator-chloe",
        display_name: "Chloe",
        status: "active",
      },
      csrf_token: "csrf-abc",
    });
    assert.deepEqual(parsed, {
      issuer: "https://idp",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: "2026-09-08T19:30:00.000Z",
      absoluteExpiresAt: "2026-09-09T07:00:00.000Z",
      csrfToken: "csrf-abc",
    });
    assert.equal(
      effectiveExpiresAt(parsed!),
      "2026-09-08T19:30:00.000Z",
    );
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
      isCsrfProblem(
        problem({
          status: 403,
          code: "forbidden",
          title: "Forbidden",
          detail: "CSRF validation failed.",
        }),
      ),
      true,
    );
    assert.equal(
      isCsrfProblem(problem({ status: 403, code: "forbidden", detail: "not a member" })),
      false,
    );
    const local = csrfRequiredProblem("/api/v1/tenants", "req-id-16charsxxx");
    assert.equal(local.code, "csrf-required");
    assert.equal(local.status, 403);
  });
});
