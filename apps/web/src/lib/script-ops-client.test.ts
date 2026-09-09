import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
import {
  emergencyStopExecution,
  revokeScriptArtifact,
} from "./script-ops-client.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const ARTIFACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const STEP_ID = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

function withSession() {
  setActiveSession({
    issuer: "https://flowforge.local",
    subject: "operator-chloe",
    displayName: "Chloe",
    sessionId: "sess-1",
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    csrfToken: "csrf-ok",
  });
}

describe("script ops client", () => {
  it("POSTs /scripts/{id}/revoke with CSRF and keeps revokedAt fail-closed", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          id: ARTIFACT_ID,
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          language: "python",
          entrypoint: "main.py",
          signature: "hmac-sha256:sig",
          scanStatus: "clean",
          status: "published",
          revokedAt: "2026-09-09T15:04:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await revokeScriptArtifact(identity, ARTIFACT_ID, {
      reason: "leaked handle",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.artifact.revokedAt, "2026-09-09T15:04:00Z");
      assert.match(result.message, /artifact-revoked/);
    }
    assert.equal(seen.url, `/api/v1/scripts/${ARTIFACT_ID}/revoke`);
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(seen.init?.body)), { reason: "leaked handle" });
  });

  it("fail-closes revoke on 403 and rejects a blob in the revoke response", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          code: "forbidden",
        }),
        { status: 403, headers: { "Content-Type": PROBLEM_JSON } },
      )) as typeof fetch;
    const denied = await revokeScriptArtifact(identity, ARTIFACT_ID);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.forbidden, true);
      assert.match(denied.problem.detail ?? "", /script\.revoke/);
    }

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: ARTIFACT_ID,
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          language: "python",
          entrypoint: "main.py",
          signature: "hmac-sha256:sig",
          scanStatus: "clean",
          status: "published",
          revokedAt: "2026-09-09T15:04:00Z",
          storageRef: "s3://nope",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const blob = await revokeScriptArtifact(identity, ARTIFACT_ID);
    assert.equal(blob.ok, false);
    if (!blob.ok) {
      assert.equal(blob.problem.code, "contract-bug");
    }
  });

  it("POSTs emergency-stop on the execution and step routes and never offers retry", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          id: EXECUTION_ID,
          status: "indeterminate",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const running = await emergencyStopExecution(identity, EXECUTION_ID, {
      uncertain: true,
      status: "running",
    });
    assert.equal(running.ok, true);
    if (running.ok) {
      assert.equal(running.outcome, "indeterminate");
      assert.equal(running.uncertain, true);
      assert.equal(running.retryOffered, false);
      assert.match(running.message, /indeterminate/);
    }
    assert.equal(seen.url, `/api/v1/executions/${EXECUTION_ID}/emergency-stop`);
    assert.deepEqual(JSON.parse(String(seen.init?.body)), { uncertain: true });

    const step = await emergencyStopExecution(identity, EXECUTION_ID, {
      stepId: STEP_ID,
      status: "queued",
    });
    assert.equal(step.ok, true);
    assert.equal(
      seen.url,
      `/api/v1/executions/${EXECUTION_ID}/steps/${STEP_ID}/emergency-stop`,
    );
  });

  it("fail-closes emergency stop on policy deny and does not invent a retry", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:emergency-stop-denied",
          title: "Forbidden",
          status: 403,
          code: "emergency-stop-denied",
        }),
        { status: 403, headers: { "Content-Type": PROBLEM_JSON } },
      )) as typeof fetch;
    const denied = await emergencyStopExecution(identity, EXECUTION_ID);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.forbidden, true);
      assert.match(denied.problem.detail ?? "", /allowEmergencyStop|emergency-stop-denied/);
    }
  });
});
