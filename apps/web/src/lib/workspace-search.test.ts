import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CredentialRecord } from "./credential-types.ts";
import type { ExecutionRecord } from "./execution-types.ts";
import type { WorkflowCatalog, WorkflowRecord } from "./workflow-types.ts";
import {
  buildSearchIndex,
  querySearchIndex,
  sanitizeSearchSource,
  searchIndexContainsSecret,
} from "./workspace-search.ts";

const workflow: WorkflowRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "deploy",
  name: "Deploy app",
  status: "published",
  draftRevision: 2,
  draftDigest: "sha256:aaaa",
  latestVersionNumber: 1,
  latestVersionId: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

const catalog: WorkflowCatalog = {
  apiVersion: "flowforge/v1",
  triggers: [{ type: "manual", phase: "core" }],
  nodes: [
    { type: "data.set", phase: "core", title: "Set data" },
    { type: "workflow.call", phase: "next", title: "Call" },
  ],
};

const credential = {
  id: "33333333-3333-4333-8333-333333333333",
  type: "kubernetes",
  displayName: "prod-k8s",
  status: "active",
  tags: ["prod", "cluster"],
  metadata: {},
  fingerprint: "ab:cd",
  encryptionVersion: 1,
  keyReference: "kek-1",
  lastTestStatus: "untested",
  useCount: 0,
  permittedActions: ["view"],
  secret: "super-secret-value",
  token: "tok-live",
  kubeconfig: "apiVersion: v1",
} as CredentialRecord & {
  secret: string;
  token: string;
  kubeconfig: string;
};

const execution = {
  id: "44444444-4444-4444-8444-444444444444",
  workflowId: workflow.id,
  workflowName: "Deploy app",
  workflowSlug: "deploy",
  workflowVersionId: "22222222-2222-4222-8222-222222222222",
  workflowVersionNumber: 1,
  workflowDigest: "sha256:aaaa",
  status: "succeeded",
  startedAt: "2026-01-02T00:00:00Z",
  finishedAt: "2026-01-02T00:01:00Z",
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T00:01:00Z",
  retentionUntil: "",
  correlationId: "corr-1",
  idempotencyKey: "idem-1",
  replayed: false,
  requestedBy: "user-1",
  triggerId: "",
  input: { password: "hunter2", token: "should-not-index" },
  policySnapshot: null,
  permittedActions: [],
} as ExecutionRecord;

const viewer = ["workflow.view", "execution.view", "alert.view"];
const editor = [...viewer, "credential.view"];

describe("sanitizeSearchSource", () => {
  it("strips unexpected secret fields before indexing", () => {
    const stripped: string[] = [];
    const cleaned = sanitizeSearchSource(
      {
        displayName: "prod-k8s",
        secret: "super-secret-value",
        token: "tok-live",
        kubeconfig: "apiVersion: v1",
        tags: ["prod"],
      },
      stripped,
    );
    const json = JSON.stringify(cleaned);
    assert.equal(json.includes("super-secret-value"), false);
    assert.equal(json.includes("tok-live"), false);
    assert.equal(json.includes("apiVersion: v1"), false);
    assert.ok(stripped.length > 0);
  });
});

describe("buildSearchIndex", () => {
  it("never indexes secrets, YAML payloads, or redacted execution input", () => {
    const index = buildSearchIndex(
      {
        workflows: [
          {
            ...workflow,
            definitionYaml: "kubeconfig: SHOULD-NOT-INDEX",
          } as WorkflowRecord & { definitionYaml: string },
        ],
        catalog,
        credentials: [credential],
        executions: [execution],
        swaggerUrl: "https://example.test/swagger",
      },
      editor,
    );
    assert.equal(searchIndexContainsSecret(index, "super-secret-value"), false);
    assert.equal(searchIndexContainsSecret(index, "tok-live"), false);
    assert.equal(searchIndexContainsSecret(index, "hunter2"), false);
    assert.equal(searchIndexContainsSecret(index, "should-not-index"), false);
    assert.equal(searchIndexContainsSecret(index, "SHOULD-NOT-INDEX"), false);

    assert.equal(querySearchIndex(index, "super-secret-value").length, 0);
    assert.equal(querySearchIndex(index, "hunter2").length, 0);
    assert.equal(querySearchIndex(index, "Deploy app")[0]?.kind, "workflow");
    assert.equal(querySearchIndex(index, "prod-k8s")[0]?.kind, "credential");
    assert.equal(querySearchIndex(index, "prod")[0]?.kind, "credential");
    assert.equal(
      querySearchIndex(index, "44444444-4444-4444-8444-444444444444")[0]?.kind,
      "execution",
    );
    assert.equal(querySearchIndex(index, "data.set")[0]?.kind, "action");
    assert.equal(querySearchIndex(index, "workflow.call").length, 0);
    assert.ok(querySearchIndex(index, "openapi")[0]?.title.includes("OpenAPI"));
    assert.equal(querySearchIndex(index, "openapi")[0]?.href, "/settings#api-docs");
    assert.equal(querySearchIndex(index, "health")[0]?.href, "/settings#health");
  });

  it("does not index credentials or executions the caller cannot see", () => {
    const index = buildSearchIndex(
      {
        workflows: [workflow],
        credentials: [credential],
        executions: [execution],
      },
      ["workflow.view"],
    );
    assert.equal(querySearchIndex(index, "prod-k8s").length, 0);
    assert.equal(
      querySearchIndex(index, "44444444-4444-4444-8444-444444444444").length,
      0,
    );
    assert.equal(querySearchIndex(index, "Deploy").length, 1);
    assert.equal(querySearchIndex(index, "membership").length, 0);
    assert.equal(querySearchIndex(index, "isolation").length, 0);
  });

  it("indexes membership/isolation docs only with the ADV-024 grant", () => {
    const denied = buildSearchIndex({}, viewer);
    assert.equal(querySearchIndex(denied, "membership").length, 0);
    assert.equal(querySearchIndex(denied, "isolation").length, 0);
    const granted = buildSearchIndex({}, [...viewer, "workspace.administer"]);
    assert.equal(querySearchIndex(granted, "membership")[0]?.href, "/membership");
    assert.equal(querySearchIndex(granted, "isolation")[0]?.href, "/isolation");
    assert.match(
      querySearchIndex(granted, "isolation")[0]?.subtitle ?? "",
      /denial/,
    );
  });
});
