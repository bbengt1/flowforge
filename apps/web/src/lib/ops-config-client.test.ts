import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createOpsConfig,
  getOpsConfigCatalog,
  listOpsConfig,
  listWorkflowVersionPins,
  publishOpsConfig,
  saveOpsConfigDraft,
  selectOpsConfig,
  selectOpsConfigBatch,
} from "./ops-config-client.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { PROBLEM_JSON } from "./problem.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";

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

const pinPayload = {
  kind: "cluster_target",
  resourceId: RESOURCE_ID,
  name: "prod-cluster",
  versionId: VERSION_ID,
  versionNumber: 2,
  digest: "sha256:aa",
};

describe("ops-config client", () => {
  it("lists heads and POSTs select with credentials include", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      seen.body = typeof init?.body === "string" ? init.body : "";
      if (String(input).endsWith("/select")) {
        return new Response(JSON.stringify(pinPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: RESOURCE_ID,
              kind: "cluster_target",
              name: "prod-cluster",
              status: "published",
              latestVersionId: VERSION_ID,
              latestVersionNumber: 2,
              latestVersionDigest: "sha256:aa",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const list = await listOpsConfig(identity, "cluster_target");
    assert.equal(list.ok, true);
    assert.equal(seen.url, "/api/v1/cluster-targets");
    assert.equal(seen.init?.credentials, "include");
    if (list.ok) {
      assert.equal(list.items[0]?.name, "prod-cluster");
      assert.equal(list.items[0]?.latestVersionId, VERSION_ID);
    }

    const selected = await selectOpsConfig(
      identity,
      "cluster_target",
      RESOURCE_ID,
      VERSION_ID,
    );
    assert.equal(selected.ok, true);
    assert.equal(seen.url, `/api/v1/cluster-targets/${RESOURCE_ID}/select`);
    assert.equal(seen.init?.credentials, "include");
    assert.match(seen.body ?? "", /versionId/);
    if (selected.ok) {
      assert.equal(selected.pin.resourceId, RESOURCE_ID);
      assert.equal(selected.pin.name, "prod-cluster");
    }
  });

  it("create/save/publish send CSRF and body revision, never If-Match, secrets, or workspaceId", async () => {
    withSession();
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const url = String(input);
      if (url.endsWith("/publish")) {
        return new Response(
          JSON.stringify({
            resource: {
              id: RESOURCE_ID,
              kind: "command_profile",
              name: "restart",
              status: "published",
              draftRevision: 2,
            },
            version: {
              id: VERSION_ID,
              resourceId: RESOURCE_ID,
              kind: "command_profile",
              versionNumber: 1,
              digest: "sha256:abc",
              spec: { template: "true", retrySafe: true },
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          draft: {
            resourceId: RESOURCE_ID,
            kind: "command_profile",
            revision: url.includes("/draft") ? 2 : 1,
            spec: { template: "true", retrySafe: true },
          },
          resource: {
            id: RESOURCE_ID,
            kind: "command_profile",
            name: "restart",
            status: "draft",
            draftRevision: url.includes("/draft") ? 2 : 1,
          },
        }),
        {
          status: url.endsWith("/command-profiles") ? 201 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const created = await createOpsConfig(identity, "command_profile", "restart", {
      template: "true",
      retrySafe: true,
    });
    assert.equal(created.ok, true);
    const saved = await saveOpsConfigDraft(
      identity,
      "command_profile",
      RESOURCE_ID,
      1,
      { template: "true", retrySafe: true },
      "restart",
    );
    assert.equal(saved.ok, true);
    const published = await publishOpsConfig(
      identity,
      "command_profile",
      RESOURCE_ID,
      2,
      "first pin",
    );
    assert.equal(published.ok, true);
    if (published.ok) {
      assert.equal(published.version.versionNumber, 1);
      assert.equal(published.version.digest, "sha256:abc");
    }

    assert.equal(seen[0]?.url, "/api/v1/command-profiles");
    assert.equal(seen[0]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.doesNotMatch(seen[0]?.body ?? "", /workspaceId|workspace_id|"id":/);
    assert.doesNotMatch(seen[0]?.body ?? "", /secret|kubeconfig|privateKey/);
    assert.equal(seen[1]?.url, `/api/v1/command-profiles/${RESOURCE_ID}/draft`);
    assert.equal(seen[1]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen[1]?.headers.get("If-Match"), null);
    assert.match(seen[1]?.body ?? "", /"revision":1/);
    assert.equal(seen[2]?.url, `/api/v1/command-profiles/${RESOURCE_ID}/publish`);
    assert.equal(seen[2]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.match(seen[2]?.body ?? "", /first pin/);
  });

  it("fails closed when select returns 403 problem+json", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Foreign workspace resource.",
          instance: "/api/v1/ssh-targets/11111111-1111-4111-8111-111111111111/select",
          code: "forbidden",
          request_id: "cfg-forbidden-16xx",
        }),
        {
          status: 403,
          headers: { "Content-Type": PROBLEM_JSON },
        },
      )) as typeof fetch;

    const result = await selectOpsConfig(identity, "ssh_target", RESOURCE_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.equal(result.problem.code, "forbidden");
      assert.equal(result.problem.request_id, "cfg-forbidden-16xx");
    }
  });

  it("loads catalog and workflow pins, and batch-selects refs", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/ops-config/catalog")) {
        return new Response(
          JSON.stringify({
            kinds: [
              {
                kind: "cluster_target",
                collection: "cluster-targets",
                displayName: "Cluster targets",
                yamlFields: ["clusterTargetId"],
                usePermission: "clusterTarget.use",
                allowedCredentialTypes: ["kubernetes"],
              },
            ],
            kubernetesEngine: {
              credentialType: "kubernetes",
              allowedKinds: ["ConfigMap"],
              kubeconfig: "should-be-stripped",
            },
            sshEngine: {
              credentialType: "ssh_private_key",
              privateKey: "should-be-stripped",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/pins") || url.endsWith("/ops-config/select")) {
        return new Response(JSON.stringify({ items: [pinPayload] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const catalog = await getOpsConfigCatalog(identity);
    assert.equal(catalog.ok, true);
    if (catalog.ok) {
      assert.equal(catalog.catalog.kinds[0]?.collection, "cluster-targets");
      assert.deepEqual(
        catalog.catalog.kinds[0]?.allowedCredentialTypes,
        ["kubernetes"],
      );
      assert.equal(
        catalog.catalog.kubernetesEngine?.credentialType,
        "kubernetes",
      );
      assert.equal("kubeconfig" in (catalog.catalog.kubernetesEngine ?? {}), false);
      assert.equal(
        catalog.catalog.sshEngine?.credentialType,
        "ssh_private_key",
      );
      assert.equal("privateKey" in (catalog.catalog.sshEngine ?? {}), false);
    }

    const pins = await listWorkflowVersionPins(identity, WORKFLOW_ID, VERSION_ID);
    assert.equal(pins.ok, true);
    if (pins.ok) {
      assert.equal(pins.items[0]?.resourceId, RESOURCE_ID);
    }

    const batch = await selectOpsConfigBatch(identity, [
      { kind: "cluster_target", resourceId: RESOURCE_ID, versionId: VERSION_ID },
    ]);
    assert.equal(batch.ok, true);
    assert.deepEqual(seen, [
      "/api/v1/ops-config/catalog",
      `/api/v1/workflows/${WORKFLOW_ID}/versions/${VERSION_ID}/pins`,
      "/api/v1/ops-config/select",
    ]);
  });

  it("rejects host-supplied id/workspaceId on create without calling upstream", async () => {
    withSession();
    globalThis.fetch = (async () => {
      throw new Error("must not call upstream when host identity is present");
    }) as typeof fetch;
    const result = await createOpsConfig(identity, "cluster_target", "prod", {
      credentialId: RESOURCE_ID,
      id: RESOURCE_ID,
      workspaceId: VERSION_ID,
    } as never);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.problem.code, "invalid-request");
      assert.match(result.problem.detail, /id, workspaceId/);
    }
  });
});
