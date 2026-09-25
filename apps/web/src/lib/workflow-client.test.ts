import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { COLLECTION_PAGE_INVALID_DETAIL } from "./collection-page.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { INVALID_WORKFLOW_YAML, STARTER_WORKFLOW_YAML } from "./workflow.ts";
import {
  createWorkflow,
  deleteWorkflow,
  fetchWorkflowCatalog,
  IF_MATCH_HEADER,
  listWorkflows,
  moveWorkflowToFolder,
  normalizeWorkflowYaml,
  importValidatedWorkflow,
  saveCanonicalWorkflowDraft,
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

  it("lists workflows with folderId=unfiled or a folder UUID", async () => {
    withSession();
    const seen: { url?: string } = {};
    globalThis.fetch = (async (input) => {
      seen.url = String(input);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              slug: "deploy",
              name: "Deploy",
              status: "draft",
              draftRevision: 1,
              draftDigest: "sha256:aaaa",
              latestVersionNumber: 0,
              createdAt: "2026-09-13T00:00:00Z",
              updatedAt: "2026-09-13T00:00:00Z",
              folderId: null,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const unfiled = await listWorkflows(identity, { folderId: "unfiled" });
    assert.equal(unfiled.ok, true);
    assert.equal(seen.url, "/api/v1/workflows?folderId=unfiled");
    if (unfiled.ok) {
      assert.equal(unfiled.items[0]?.folderId, null);
    }

    const folderId = "22222222-2222-4222-8222-222222222222";
    const filed = await listWorkflows(identity, { folderId });
    assert.equal(filed.ok, true);
    assert.equal(seen.url, `/api/v1/workflows?folderId=${folderId}`);
  });

  it("reads the page object and refuses a bad q without echoing it", async () => {
    withSession();
    const seen: { url?: string } = {};
    globalThis.fetch = (async (input) => {
      seen.url = String(input);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              slug: "deploy",
              name: "Deploy",
              status: "draft",
              draftRevision: 1,
              draftDigest: "sha256:aaaa",
              latestVersionNumber: 0,
              createdAt: "2026-09-13T00:00:00Z",
              updatedAt: "2026-09-13T00:00:00Z",
              folderId: null,
            },
          ],
          limit: 50,
          cursor: "",
          next: "wf-next",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const page = await listWorkflows(identity, {
      folderId: "unfiled",
      q: "Deploy",
      limit: 50,
    });
    assert.equal(page.ok, true);
    assert.match(seen.url ?? "", /folderId=unfiled/);
    assert.match(seen.url ?? "", /q=Deploy/);
    assert.match(seen.url ?? "", /limit=50/);
    if (page.ok) {
      assert.equal(page.items.length, 1);
      assert.equal(page.next, "wf-next");
      assert.equal(page.limit, 50);
    }

    const secret = "sk-sample";
    const rejected = await listWorkflows(identity, { q: secret });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.problem.detail, COLLECTION_PAGE_INVALID_DETAIL);
      assert.equal(JSON.stringify(rejected.problem).includes(secret), false);
    }

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:invalid-request",
          title: "Invalid Request",
          status: 400,
          detail: "bad cursor wf-next-echo",
          instance: "/api/v1/workflows?cursor=wf-next-echo&folderId=unfiled",
          code: "invalid-request",
          request_id: "req-page",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "req-page",
          },
        },
      )) as typeof fetch;
    const scrubbed = await listWorkflows(identity, { cursor: "wf-next" });
    assert.equal(scrubbed.ok, false);
    if (!scrubbed.ok) {
      assert.equal(scrubbed.problem.detail, COLLECTION_PAGE_INVALID_DETAIL);
      assert.equal(scrubbed.problem.instance.includes("wf-next-echo"), false);
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

  it("saveCanonicalWorkflowDraft normalizes then PUTs draft and prefers normalize yaml", async () => {
    withSession();
    const calls: { url?: string; body?: string }[] = [];
    const normalized = `${STARTER_WORKFLOW_YAML}# canonical\n`;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      if (url.endsWith("/workflows/normalize")) {
        return new Response(
          JSON.stringify({
            definitionYaml: normalized,
            digest: "sha256:normalized",
            summary,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          workflow: {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "validate-example",
            name: "validate-example",
            status: "draft",
            draftRevision: 2,
            draftDigest: "sha256:draft",
            latestVersionNumber: 0,
            createdAt: "2026-09-08T21:00:00.000Z",
            updatedAt: "2026-09-08T21:00:00.000Z",
          },
          draft: {
            workflowId: "11111111-1111-4111-8111-111111111111",
            revision: 2,
            definitionYaml: `${normalized}# from-draft\n`,
            digest: "sha256:draft",
            summary,
            warnings: [],
            validationState: "valid",
            updatedAt: "2026-09-08T21:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await saveCanonicalWorkflowDraft(
      identity,
      "11111111-1111-4111-8111-111111111111",
      STARTER_WORKFLOW_YAML,
      1,
    );
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, "/api/v1/workflows/normalize");
    assert.equal(
      calls[1]?.url,
      "/api/v1/workflows/11111111-1111-4111-8111-111111111111/draft",
    );
    assert.match(calls[1]?.body ?? "", /# canonical/);
    if (result.ok) {
      assert.equal(result.normalized, true);
      assert.equal(result.applied.yaml, normalized);
      assert.equal(result.applied.digest, "sha256:normalized");
      assert.equal(result.applied.revision, 2);
      assert.equal(result.normalizeDigest, "sha256:normalized");
    }
  });

  it("importValidatedWorkflow validates before POST /workflows", async () => {
    withSession();
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:invalid-workflow",
          title: "Invalid Workflow",
          status: 400,
          detail: "The workflow definition is not valid.",
          instance: "/api/v1/workflows/validate",
          code: "invalid-workflow",
          request_id: "wf-import-invalid16",
          errors: [
            {
              path: "spec.nodes[0].type",
              line: 10,
              column: 7,
              code: "unsupported-node",
              message: "workflow.call is not enabled.",
            },
          ],
        }),
        {
          status: 400,
          headers: {
            "Content-Type": PROBLEM_JSON,
            [REQUEST_ID_HEADER]: "wf-import-invalid16",
          },
        },
      );
    }) as typeof fetch;

    const result = await importValidatedWorkflow(identity, INVALID_WORKFLOW_YAML);
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ["/api/v1/workflows/validate"]);
    if (!result.ok) {
      assert.equal(result.errors[0]?.code, "unsupported-node");
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

  it("starts an execution with workflowVersionId, idempotency, and input — never draft: true", async () => {
    withSession();
    const seen: {
      url?: string;
      body?: string;
      csrf?: string | null;
      idempotency?: string | null;
    } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      const headers = new Headers(init?.headers);
      seen.csrf = headers.get(CSRF_HEADER);
      seen.idempotency = headers.get("Idempotency-Key");
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
    assert.match(seen.body ?? "", /"input":\{\}/);
    assert.doesNotMatch(seen.body ?? "", /"draft"/);
    assert.equal(seen.csrf, "csrf-ok");
    assert.equal(seen.idempotency, "deploy-prod-1");
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

  it("PATCHes /workflows/{id}/folder with CSRF; Unfiled is folderId null", async () => {
    withSession();
    const record = {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "deploy",
      name: "Deploy",
      status: "draft",
      draftRevision: 4,
      draftDigest: "sha256:aaaa",
      latestVersionNumber: 2,
      createdAt: "2026-09-13T00:00:00Z",
      updatedAt: "2026-09-13T00:00:00Z",
      folderId: "22222222-2222-4222-8222-222222222222",
    };
    const seen: Array<{
      url?: string;
      method?: string;
      headers?: Headers;
      body?: string;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ ...record, folderId: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const filed = await moveWorkflowToFolder(
      identity,
      record.id,
      "22222222-2222-4222-8222-222222222222",
    );
    assert.equal(filed.ok, true);
    assert.equal(seen[0]?.url, `/api/v1/workflows/${record.id}/folder`);
    assert.equal(seen[0]?.method, "PATCH");
    assert.equal(seen[0]?.headers?.get(CSRF_HEADER), "csrf-ok");
    const filedBody = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(filedBody, {
      folderId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(Object.hasOwn(filedBody, "definitionYaml"), false);
    assert.equal(Object.hasOwn(filedBody, "draftRevision"), false);
    if (filed.ok) {
      assert.equal(filed.workflow.draftRevision, 4);
    }

    const unfiled = await moveWorkflowToFolder(identity, record.id, null);
    assert.equal(unfiled.ok, true);
    const unfiledBody = JSON.parse(seen[1]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(unfiledBody, { folderId: null });
    assert.equal(unfiledBody.folderId, null);
    if (unfiled.ok) {
      assert.equal(unfiled.workflow.draftRevision, 4);
      assert.equal(unfiled.workflow.folderId, null);
    }

    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "",
    });
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(JSON.stringify(record), { status: 200 });
    }) as typeof fetch;
    const missing = await moveWorkflowToFolder(identity, record.id, null);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.problem.code, "csrf-required");
      assert.equal(missing.statusCode, 403);
    }
    assert.equal(fetched, false);
  });

  it("DELETEs a workflow as 204 with no YAML body and keeps capabilities", async () => {
    withSession();
    const id = "11111111-1111-4111-8111-111111111111";
    const record = {
      id,
      slug: "deploy",
      name: "Deploy",
      status: "published",
      draftRevision: 2,
      capabilities: { delete: true },
    };
    const seen: Array<{ url?: string; method?: string; body?: string; csrf?: string | null }> =
      [];
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      seen.push({
        url: String(input),
        method,
        body: typeof init?.body === "string" ? init.body : "",
        csrf: new Headers(init?.headers).get(CSRF_HEADER),
      });
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ items: [record] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const listed = await listWorkflows(identity);
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.items[0]?.capabilities?.delete, true);
    }

    const deleted = await deleteWorkflow(identity, id);
    assert.equal(deleted.ok, true);
    if (deleted.ok) {
      assert.equal(deleted.statusCode, 204);
    }
    assert.equal(seen[1]?.url, `/api/v1/workflows/${id}`);
    assert.equal(seen[1]?.method, "DELETE");
    assert.equal(seen[1]?.body, "");
    assert.equal(seen[1]?.csrf, "csrf-ok");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "do not match this sentence",
          instance: `/workflows/${id}`,
          code: "workflow_has_active_executions",
          request_id: "req-delete",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      )) as typeof fetch;
    const blocked = await deleteWorkflow(identity, id);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.statusCode, 409);
      assert.equal(blocked.problem.code, "workflow_has_active_executions");
    }
  });
});
