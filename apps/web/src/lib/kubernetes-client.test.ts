import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createClusterTarget,
  createKubernetesPolicy,
  getKubernetesCatalog,
  listClusterTargets,
  selectClusterTarget,
  selectKubernetesPolicy,
} from "./kubernetes-client.ts";
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
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";

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

describe("kubernetes client", () => {
  it("lists cluster targets through the retarget adapter path", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          items: [
            {
              id: RESOURCE_ID,
              kind: "cluster_target",
              name: "prod-cluster",
              status: "published",
              draftRevision: 1,
              latestVersionId: VERSION_ID,
              latestVersionNumber: 1,
              credentialId: CREDENTIAL_ID,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await listClusterTargets(identity);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.items[0]?.name, "prod-cluster");
      assert.equal(result.items[0]?.credentialId, CREDENTIAL_ID);
    }
    assert.match(seen[0] ?? "", /\/api\/v1\/cluster-targets$/);
  });

  it("creates a cluster target without kubeconfig or host ids and sends CSRF", async () => {
    withSession();
    const seen: { url?: string; body?: string; headers?: HeadersInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      seen.headers = init?.headers;
      return new Response(
        JSON.stringify({
          resource: {
            id: RESOURCE_ID,
            kind: "cluster_target",
            name: "prod-cluster",
            status: "draft",
            draftRevision: 1,
          },
          draft: {
            resourceId: RESOURCE_ID,
            kind: "cluster_target",
            revision: 1,
            spec: {
              credentialId: CREDENTIAL_ID,
              endpoint: { apiServer: "https://k8s.example" },
              kubeconfig: "should-be-stripped",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await createClusterTarget(identity, "prod-cluster", {
      credentialId: CREDENTIAL_ID,
      endpoint: { apiServer: "https://k8s.example" },
      kubeconfig: "apiVersion: v1",
    } as never);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal("kubeconfig" in result.draft.spec, false);
      assert.equal(result.draft.spec.credentialId, CREDENTIAL_ID);
    }
    const body = JSON.parse(seen.body ?? "{}") as Record<string, unknown>;
    assert.equal("id" in body, false);
    assert.equal("workspaceId" in body, false);
    assert.doesNotMatch(seen.body ?? "", /kubeconfig|apiVersion: v1/);
    const headers = new Headers(seen.headers);
    assert.equal(headers.get(CSRF_HEADER), "csrf-ok");
    assert.match(seen.url ?? "", /\/api\/v1\/cluster-targets$/);
  });

  it("fails closed on 403 select and never invents a pin", async () => {
    withSession();
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Cross-workspace resource.",
          instance: `/cluster-targets/${RESOURCE_ID}/select`,
          code: "forbidden",
          request_id: "req-forbidden-16x",
        }),
        { status: 403, headers: { "Content-Type": PROBLEM_JSON } },
      );
    }) as typeof fetch;

    const result = await selectClusterTarget(identity, RESOURCE_ID, VERSION_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.equal(result.problem.code, "forbidden");
    }
  });

  it("creates a kubernetes policy and rejects a non-kubernetes select", async () => {
    withSession();
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/policies") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          spec?: { kind?: string };
        };
        assert.equal(body.spec?.kind, "kubernetes");
        assert.doesNotMatch(String(init.body), /kubeconfig/);
        return new Response(
          JSON.stringify({
            resource: {
              id: RESOURCE_ID,
              kind: "policy",
              name: "prod-k8s",
              status: "draft",
              draftRevision: 1,
            },
            draft: {
              resourceId: RESOURCE_ID,
              kind: "policy",
              revision: 1,
              spec: { kind: "kubernetes", policy: { allowedNamespaces: ["app"] } },
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          kind: "policy",
          resourceId: RESOURCE_ID,
          versionId: VERSION_ID,
          versionNumber: 1,
          digest: "sha256:aa",
          spec: { kind: "ssh", policy: {} },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const created = await createKubernetesPolicy(identity, "prod-k8s", {
      kind: "kubernetes",
      policy: { allowedNamespaces: ["app"] },
    });
    assert.equal(created.ok, true);

    const selected = await selectKubernetesPolicy(identity, RESOURCE_ID);
    assert.equal(selected.ok, false);
    if (!selected.ok) {
      assert.match(selected.problem.detail ?? "", /not a kubernetes policy/i);
    }
  });

  it("loads GET /kubernetes/catalog and rejects host-supplied identity", async () => {
    withSession();
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          credentialType: "kubernetes",
          allowedKinds: ["ConfigMap"],
          allowedVerbs: ["get"],
          evaluationKeys: [],
          serviceAccount: { defaultName: "flowforge-runner", roleTemplate: "namespace-scoped-runner" },
          publishRules: { emptyAllowlistsRejected: true, credentialType: "kubernetes" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const catalog = await getKubernetesCatalog(identity);
    assert.equal(catalog.ok, true);
    if (catalog.ok) {
      assert.equal(catalog.catalog.credentialType, "kubernetes");
    }
    assert.match(seen[0] ?? "", /\/api\/v1\/kubernetes\/catalog$/);

    globalThis.fetch = (async () => {
      throw new Error("must not call upstream when host identity is present");
    }) as typeof fetch;
    const rejected = await createClusterTarget(identity, "prod-cluster", {
      credentialId: CREDENTIAL_ID,
      endpoint: { apiServer: "https://k8s.example" },
      id: RESOURCE_ID,
      workspaceId: VERSION_ID,
    } as never);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.problem.code, "invalid-request");
      assert.match(rejected.problem.detail ?? "", /id, workspaceId/);
    }
  });
});
