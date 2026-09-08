import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { STARTER_WORKFLOW_YAML } from "./workflow.ts";
import {
  fetchWorkflowCatalog,
  normalizeWorkflowYaml,
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
});
