import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { emptyStoredIdentity } from "./dev-identity.ts";
import { runPublishedTestVersion } from "./editor-test-run-client.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";

const originalFetch = globalThis.fetch;
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const DIGEST = "sha256:test";
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

function workflowRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    slug: "ops-deploy",
    name: "Deploy app",
    status: "published",
    draftRevision: 2,
    draftDigest: DIGEST,
    latestVersionNumber: 1,
    latestVersionId: VERSION_ID,
    latestVersionDigest: DIGEST,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    ...overrides,
  };
}

function versionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    digest: DIGEST,
    publishNote: "test",
    publishedAt: "2026-09-12T00:00:00Z",
    ...overrides,
  };
}

function executionRecord() {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    workflowDigest: DIGEST,
    status: "queued",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function problemResponse(detail: string, status = 409) {
  return new Response(
    JSON.stringify({
      type: "urn:flowforge:problem:conflict",
      title: "Conflict",
      status,
      detail,
      instance: `/api/v1/workflows/${WORKFLOW_ID}/publish`,
      code: "conflict",
      request_id: "wf-test-run-conflict16",
    }),
    { status, headers: { "Content-Type": PROBLEM_JSON } },
  );
}

function classify(url: string): "publish" | "start" | "versions" | "version" | "workflow" {
  if (url.endsWith("/publish")) {
    return "publish";
  }
  if (url.endsWith("/executions")) {
    return "start";
  }
  if (url.endsWith("/versions")) {
    return "versions";
  }
  if (url.includes("/versions/")) {
    return "version";
  }
  return "workflow";
}

function publishThenStartFetch(seen: { urls: string[]; bodies: string[] }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.urls.push(url);
    seen.bodies.push(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    if (classify(url) === "publish") {
      return jsonResponse(
        {
          workflow: workflowRecord({ draftDigest: "sha256:bbbb" }),
          version: versionRecord(),
        },
        201,
      );
    }
    return jsonResponse(executionRecord(), 201);
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
      draftDigest: "sha256:new",
      latestVersionDigest: "sha256:old",
      latestVersionId: VERSION_ID,
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
      assert.equal(result.reusedExistingPublished, false);
      assert.equal(result.version.id, VERSION_ID);
      assert.equal(result.version.publishNote, "test");
      assert.equal(result.execution.workflowVersionId, VERSION_ID);
      assert.equal(result.execution.id, EXECUTION_ID);
    }
  });

  it("starts the existing published version when saved digest already matches", async () => {
    withSession();
    const seen = { urls: [] as string[], bodies: [] as string[] };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.urls.push(url);
      seen.bodies.push(typeof init?.body === "string" ? init.body : "");
      const kind = classify(url);
      assert.notEqual(kind, "publish");
      if (kind === "workflow") {
        return jsonResponse(workflowRecord());
      }
      if (kind === "version") {
        return jsonResponse(versionRecord());
      }
      if (kind === "start") {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
        return jsonResponse(executionRecord(), 201);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const result = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      permissions: ALLOWED,
      idempotencyKey: "test-run-reuse",
      draftDigest: DIGEST,
      latestVersionDigest: DIGEST,
      latestVersionId: VERSION_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(seen.urls.includes(`/api/v1/workflows/${WORKFLOW_ID}/publish`), false);
    assert.equal(
      seen.urls.includes(`/api/v1/workflows/${WORKFLOW_ID}/executions`),
      true,
    );
    assert.match(
      seen.bodies.find((body) => body.includes("workflowVersionId")) ?? "",
      /"workflowVersionId":"22222222-2222-4222-8222-222222222222"/,
    );
    assert.doesNotMatch(seen.bodies.join("\n"), /"draft"\s*:\s*true/);
    if (result.ok) {
      assert.equal(result.reusedExistingPublished, true);
      assert.equal(result.version.id, VERSION_ID);
      assert.equal(result.execution.workflowVersionId, VERSION_ID);
    }
  });

  it("treats publish 409 already-published as start latest published — not a draft conflict", async () => {
    withSession();
    const seen = { urls: [] as string[], bodies: [] as string[] };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.urls.push(url);
      seen.bodies.push(typeof init?.body === "string" ? init.body : "");
      const kind = classify(url);
      if (kind === "publish") {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
        return problemResponse("This normalized definition is already published.");
      }
      if (kind === "workflow") {
        return jsonResponse(workflowRecord());
      }
      if (kind === "version") {
        return jsonResponse(versionRecord());
      }
      if (kind === "start") {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
        return jsonResponse(executionRecord(), 201);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const result = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      permissions: ALLOWED,
      idempotencyKey: "test-run-409",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.urls[0], `/api/v1/workflows/${WORKFLOW_ID}/publish`);
    assert.equal(seen.urls.includes(`/api/v1/workflows/${WORKFLOW_ID}`), true);
    assert.equal(
      seen.urls.includes(`/api/v1/workflows/${WORKFLOW_ID}/versions/${VERSION_ID}`),
      true,
    );
    assert.equal(
      seen.urls.includes(`/api/v1/workflows/${WORKFLOW_ID}/executions`),
      true,
    );
    if (result.ok) {
      assert.equal(result.reusedExistingPublished, true);
      assert.equal(result.version.id, VERSION_ID);
      assert.equal(result.execution.id, EXECUTION_ID);
    }
  });

  it("still surfaces draft revision 409 as a publish conflict", async () => {
    withSession();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (classify(url) === "publish") {
        return problemResponse(
          "Draft revision does not match the current saved revision.",
        );
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const result = await runPublishedTestVersion(identity, {
      workflowId: WORKFLOW_ID,
      revision: 2,
      permissions: ALLOWED,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "publish");
      assert.equal(result.conflict, true);
      assert.match(result.problem.detail ?? "", /Draft revision/);
    }
  });
});
