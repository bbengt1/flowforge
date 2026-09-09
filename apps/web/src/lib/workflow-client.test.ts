import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { STARTER_WORKFLOW_YAML } from "./workflow.ts";
import {
  createWorkflow,
  fetchWorkflowCatalog,
  IF_MATCH_HEADER,
  normalizeWorkflowYaml,
  saveWorkflowDraft,
  startWorkflowExecution,
  validateWorkflowYaml,
} from "./workflow-client.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const summary = {
  apiVersion: "flowforge/v1",
  name: "validate-example",
  triggers: [{ id: "manual", type: "manual" }],
  nodes: [{ id: "seed", type: "data.set", name: "Seed value" }],
  edges: [],
  outputs: [],
};

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

describe("workflow client", () => {
  it("filters catalog to core phase after a credentialed GET", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          apiVersion: "flowforge/v1",
          triggers: [
            { type: "manual", phase: "core" },
            { type: "event", phase: "next" },
          ],
          nodes: [
            { type: "data.set", phase: "core" },
            { type: "workflow.call", phase: "next" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchWorkflowCatalog(identity);
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/workflows/catalog");
    assert.equal(seen.init?.credentials, "include");
    if (result.ok) {
      assert.deepEqual(
        result.catalog.triggers.map((item) => item.type),
        ["manual"],
      );
      assert.deepEqual(
        result.catalog.nodes.map((item) => item.type),
        ["data.set"],
      );
    }
  });

  it("posts definitionYaml with CSRF and keeps invalid-workflow errors[]", async () => {
    withSession();
    const seen: { url?: string; headers?: Headers; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.headers = new Headers(init?.headers);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:invalid-workflow",
          title: "Invalid Workflow",
          status: 400,
          detail: "The workflow definition is not valid.",
          instance: "/api/v1/workflows/validate",
          code: "invalid-workflow",
          request_id: "wf-validate-err-16",
          errors: [
            {
              path: "spec.triggers",
              line: 6,
              column: 3,
              code: "missing-field",
              message: "At least one trigger is required.",
            },
          ],
        }),
        {
          status: 400,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "wf-validate-err-16",
          },
        },
      );
    }) as typeof fetch;

    const result = await validateWorkflowYaml(identity, "kind: Workflow");
    assert.equal(seen.url, "/api/v1/workflows/validate");
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.headers?.get("Content-Type"), "application/json");
    assert.match(seen.body ?? "", /definitionYaml/);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "invalid-workflow");
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]?.path, "spec.triggers");
      assert.equal(result.errors[0]?.line, 6);
      assert.equal(result.problem.errors?.[0]?.code, "missing-field");
    }
  });

  it("replaces the buffer from normalize definitionYaml + digest", async () => {
    withSession();
    const normalized = `${STARTER_WORKFLOW_YAML}# normalized\n`;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          definitionYaml: normalized,
          digest: "sha256:deadbeef",
          summary,
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await normalizeWorkflowYaml(identity, STARTER_WORKFLOW_YAML);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.applied.yaml, normalized);
      assert.equal(result.applied.digest, "sha256:deadbeef");
      assert.equal(result.applied.summary.name, "validate-example");
    }
  });

  it("creates a workflow without host-supplied id or workspaceId", async () => {
    withSession();
    const seen: { url?: string; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          workflow: {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "validate-example",
            name: "validate-example",
            status: "draft",
            draftRevision: 1,
            draftDigest: "sha256:one",
            latestVersionNumber: 0,
            createdAt: "2026-09-08T21:00:00.000Z",
            updatedAt: "2026-09-08T21:00:00.000Z",
          },
          draft: {
            workflowId: "11111111-1111-4111-8111-111111111111",
            revision: 1,
            definitionYaml: STARTER_WORKFLOW_YAML,
            digest: "sha256:one",
            summary,
            warnings: [],
            validationState: "valid",
            updatedAt: "2026-09-08T21:00:00.000Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await createWorkflow(identity, {
      definitionYaml: STARTER_WORKFLOW_YAML,
      slug: "validate-example",
    });
    assert.equal(seen.url, "/api/v1/workflows");
    assert.match(seen.body ?? "", /definitionYaml/);
    assert.doesNotMatch(seen.body ?? "", /"id"/);
    assert.doesNotMatch(seen.body ?? "", /workspaceId/);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.applied.revision, 1);
      assert.equal(result.applied.yaml, STARTER_WORKFLOW_YAML);
    }
  });

  it("saves with revision + If-Match and offers conflict reload on 409", async () => {
    withSession();
    const seen: { url?: string; headers?: Headers; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.headers = new Headers(init?.headers);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:conflict",
          title: "Conflict",
          status: 409,
          detail: "Draft revision is stale.",
          instance: "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
          code: "conflict",
          request_id: "wf-save-conflict16",
        }),
        {
          status: 409,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "wf-save-conflict16",
          },
        },
      );
    }) as typeof fetch;

    const result = await saveWorkflowDraft(
      identity,
      "11111111-1111-4111-8111-111111111111",
      STARTER_WORKFLOW_YAML,
      1,
    );
    assert.equal(
      seen.url,
      "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
    );
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen.headers?.get(IF_MATCH_HEADER), "1");
    assert.match(seen.body ?? "", /"revision":1/);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.conflict, true);
      assert.equal(result.problem.code, "conflict");
    }
  });

  it("starts an execution with workflowVersionId and optional idempotency — never draft: true", async () => {
    withSession();
    const seen: { url?: string; body?: string; csrf?: string | null } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      seen.csrf = new Headers(init?.headers).get(CSRF_HEADER);
      return new Response(
        JSON.stringify({
          id: "33333333-3333-4333-8333-333333333333",
          workflowId: "11111111-1111-4111-8111-111111111111",
          workflowVersionId: "22222222-2222-4222-8222-222222222222",
          workflowDigest: "sha256:v1",
          status: "pinned",
          createdAt: "2026-09-08T21:00:00.000Z",
          pins: [
            {
              kind: "cluster_target",
              resourceId: "11111111-1111-4111-8111-111111111111",
              versionId: "22222222-2222-4222-8222-222222222222",
              versionNumber: 2,
              digest: "sha256:aa",
              name: "prod-cluster",
            },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const rejected = await startWorkflowExecution(
      identity,
      "11111111-1111-4111-8111-111111111111",
      "draft",
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.match(rejected.problem.detail, /Drafts cannot be executed/);
    }

    const result = await startWorkflowExecution(
      identity,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      { idempotencyKey: "deploy-prod-1" },
    );
    assert.equal(
      seen.url,
      "/api/v1/workflows/11111111-1111-4111-8111-111111111111/executions",
    );
    assert.match(seen.body ?? "", /workflowVersionId/);
    assert.match(seen.body ?? "", /idempotencyKey/);
    assert.doesNotMatch(seen.body ?? "", /"draft"/);
    assert.equal(seen.csrf, "csrf-ok");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.execution.workflowVersionId,
        "22222222-2222-4222-8222-222222222222",
      );
      assert.equal(result.execution.pins?.[0]?.name, "prod-cluster");
      assert.equal(result.execution.pins?.[0]?.resourceId, "11111111-1111-4111-8111-111111111111");
    }
  });
});
