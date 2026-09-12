import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { emptyStoredIdentity } from "./dev-identity.ts";
import { runPublishedTestVersion } from "./editor-test-run-client.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const ALLOWED = ["workflow.publish", "workflow.execute"] as const;

const identity = emptyStoredIdentity();

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

function publishThenStartFetch(seen: { urls: string[]; bodies: string[] }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.urls.push(url);
    seen.bodies.push(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    if (url.endsWith("/publish")) {
      return new Response(
        JSON.stringify({
          workflow: {
            id: WORKFLOW_ID,
            slug: "ops-deploy",
            name: "Deploy app",
            status: "published",
            draftRevision: 2,
            draftDigest: "sha256:bbbb",
            latestVersionNumber: 1,
            latestVersionId: VERSION_ID,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-09-12T00:00:00Z",
          },
          version: {
            id: VERSION_ID,
            workflowId: WORKFLOW_ID,
            versionNumber: 1,
            digest: "sha256:test",
            publishNote: "test",
            publishedAt: "2026-09-12T00:00:00Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: EXECUTION_ID,
        workflowId: WORKFLOW_ID,
        workflowVersionId: VERSION_ID,
        workflowDigest: "sha256:test",
        status: "queued",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("R6.3 test-run client", () => {
  it("refuses dirty drafts, missing revision, and missing permissions", async () => {
    const dirty = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      dirty: true,
      permissions: ALLOWED,
    });
    assert.equal(dirty.ok, false);
    if (!dirty.ok) {
      assert.equal(dirty.step, "gate");
      assert.match(dirty.problem.detail ?? "", /Save the draft/);
    }

    const missing = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: null,
      permissions: ALLOWED,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.match(missing.problem.detail ?? "", /revision/);
    }

    const forbidden = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      permissions: ["workflow.execute"],
    });
    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) {
      assert.match(forbidden.problem.detail ?? "", /workflow.publish/);
    }

    const badId = await runPublishedTestVersion(identity, {
      workflowId: "draft",
      revision: 1,
      permissions: ALLOWED,
    });
    assert.equal(badId.ok, false);
    if (!badId.ok) {
      assert.match(badId.problem.detail ?? "", /workflowId/);
    }

    const openYaml = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      permissions: ALLOWED,
      yaml: "name: unsaved-buffer\n",
    } as Parameters<typeof runPublishedTestVersion>[1] & { yaml: string });
    assert.equal(openYaml.ok, false);
    if (!openYaml.ok) {
      assert.equal(openYaml.step, "gate");
      assert.match(openYaml.problem.detail ?? "", /never executes the open editor YAML/);
    }
  });

  it("publishes a test note then starts that workflowVersionId — never draft: true", async () => {
    withSession();
    const seen = { urls: [] as string[], bodies: [] as string[] };
    globalThis.fetch = publishThenStartFetch(seen);

    const result = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      permissions: ALLOWED,
      idempotencyKey: "test-run-1",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.urls[0], `/api/v1/workflows/${WORKFLOW_ID}/publish`);
    assert.equal(seen.urls[1], `/api/v1/workflows/${WORKFLOW_ID}/executions`);
    assert.match(seen.bodies[0] ?? "", /"note":"test"/);
    assert.match(seen.bodies[0] ?? "", /"kind":"test"/);
    assert.match(seen.bodies[0] ?? "", /"revision":2/);
    assert.match(seen.bodies[1] ?? "", /"workflowVersionId":"22222222-2222-4222-8222-222222222222"/);
    assert.match(seen.bodies[1] ?? "", /"idempotencyKey":"test-run-1"/);
    assert.doesNotMatch(seen.bodies[1] ?? "", /"draft"\s*:\s*true/);
    assert.doesNotMatch(seen.bodies.join("\n"), /\/replay/);
    if (result.ok) {
      assert.equal(result.version.id, VERSION_ID);
      assert.equal(result.version.publishNote, "test");
      assert.equal(result.execution.workflowVersionId, VERSION_ID);
      assert.equal(result.execution.id, EXECUTION_ID);
    }
  });
});
