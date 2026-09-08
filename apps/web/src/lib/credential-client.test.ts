import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createCredential,
  deleteCredential,
  getCredentialDeletionImpact,
  listCredentials,
  rotateCredential,
  testCredential,
} from "./credential-client.ts";
import { emptySecretDraft } from "./credential-contract.ts";
import type { DevIdentity } from "./identity-headers.ts";
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

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

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

function metadataPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    displayName: "prod-k8s",
    type: "kubernetes_target",
    tags: ["prod"],
    status: "active",
    health: "healthy",
    policyState: "allowed",
    permittedActions: ["view", "rotate", "test", "delete"],
    lastTestedAt: "2026-09-08T21:00:00.000Z",
    rotatedAt: "2026-09-08T20:00:00.000Z",
    ...overrides,
  };
}

describe("credential client", () => {
  it("lists with credentials include and metadata-only search", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          items: [
            metadataPayload(),
            {
              ...metadataPayload({
                id: "22222222-2222-4222-8222-222222222222",
                displayName: "ssh-edge",
                type: "ssh_private_key",
                tags: ["edge"],
              }),
              privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await listCredentials(identity, { q: "prod", tag: "prod" });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/credentials?q=prod&tag=prod");
    assert.equal(seen.init?.credentials, "include");
    assert.doesNotMatch(seen.url ?? "", /privateKey|kubeconfig|BEGIN/);
    if (result.ok) {
      assert.equal(result.items.length, 2);
      assert.equal(result.items[1]?.displayName, "ssh-edge");
      assert.ok(result.strippedKeys.some((key) => key.includes("privateKey")));
      assert.equal(
        JSON.stringify(result.items).includes("BEGIN OPENSSH"),
        false,
      );
    }
  });

  it("create/rotate/test send CSRF and never retain plaintext after submit", async () => {
    withSession();
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const url = String(input);
      if (url.endsWith("/test")) {
        return new Response(
          JSON.stringify({
            status: "passed",
            testedAt: "2026-09-08T22:00:00.000Z",
            token: "should-be-stripped",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(metadataPayload({ token: "echoed" })), {
        status: url.includes("/rotate") ? 200 : 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const createDraft = emptySecretDraft();
    createDraft.kubeconfig = "apiVersion: v1\nkind: Config\n";
    const created = await createCredential(identity, {
      displayName: "prod-k8s",
      type: "kubernetes_target",
      secret: createDraft,
      tags: ["prod"],
      testOnCreate: true,
    });
    assert.equal(created.ok, true);
    assert.equal(createDraft.kubeconfig, "");
    if (created.ok) {
      assert.equal(created.credential.displayName, "prod-k8s");
      assert.equal(
        JSON.stringify(created.credential).includes("kind: Config"),
        false,
      );
      assert.ok(created.strippedKeys.includes("token"));
    }

    const rotateDraft = emptySecretDraft();
    rotateDraft.kubeconfig = "replacement-kubeconfig";
    const rotated = await rotateCredential(
      identity,
      CREDENTIAL_ID,
      "kubernetes_target",
      rotateDraft,
      true,
    );
    assert.equal(rotated.ok, true);
    assert.equal(rotateDraft.kubeconfig, "");

    const tested = await testCredential(identity, CREDENTIAL_ID);
    assert.equal(tested.ok, true);
    if (tested.ok) {
      assert.equal(tested.test.status, "passed");
      assert.equal(
        JSON.stringify(tested.test).includes("should-be-stripped"),
        false,
      );
      assert.ok(tested.strippedKeys.includes("token"));
    }

    assert.equal(seen[0]?.url, "/api/v1/credentials");
    assert.equal(seen[0]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.match(seen[0]?.body ?? "", /kind: Config/);
    assert.equal(seen[1]?.url, `/api/v1/credentials/${CREDENTIAL_ID}/rotate`);
    assert.equal(seen[1]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.match(seen[1]?.body ?? "", /replacement-kubeconfig/);
    assert.equal(seen[2]?.url, `/api/v1/credentials/${CREDENTIAL_ID}/test`);
    assert.equal(seen[2]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.equal(seen[2]?.body, "{}");
    for (const call of seen) {
      assert.equal(call.headers.get("Authorization"), null);
    }
  });

  it("loads deletion impact then deletes with CSRF", async () => {
    withSession();
    const seen: Array<{ url: string; method?: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
      });
      if (String(input).endsWith("/deletion-impact")) {
        return new Response(
          JSON.stringify({
            credentialId: CREDENTIAL_ID,
            displayName: "prod-k8s",
            canDelete: true,
            affectedDrafts: [{ workflowId: CREDENTIAL_ID, name: "rollout" }],
            affectedVersions: [],
            activeExecutions: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const impact = await getCredentialDeletionImpact(identity, CREDENTIAL_ID);
    assert.equal(impact.ok, true);
    if (impact.ok) {
      assert.equal(impact.impact.canDelete, true);
      assert.equal(impact.impact.affectedDrafts[0]?.name, "rollout");
    }
    const deleted = await deleteCredential(identity, CREDENTIAL_ID);
    assert.equal(deleted.ok, true);
    assert.equal(
      seen[0]?.url,
      `/api/v1/credentials/${CREDENTIAL_ID}/deletion-impact`,
    );
    assert.equal(seen[1]?.url, `/api/v1/credentials/${CREDENTIAL_ID}`);
    assert.equal(seen[1]?.method, "DELETE");
    assert.equal(seen[1]?.headers.get(CSRF_HEADER), "csrf-ok");
  });

  it("fail-closes create locally when a session has no CSRF token", async () => {
    let fetched = false;
    setActiveSession({
      issuer: "https://flowforge.local",
      subject: "operator-chloe",
      displayName: "Chloe",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "",
    });
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const draft = emptySecretDraft();
    draft.token = "must-not-leave-the-client";
    const result = await createCredential(identity, {
      displayName: "blocked",
      type: "token",
      secret: draft,
    });
    assert.equal(result.ok, false);
    assert.equal(fetched, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "csrf-required");
    }
    assert.equal(draft.token, "");
  });
});
