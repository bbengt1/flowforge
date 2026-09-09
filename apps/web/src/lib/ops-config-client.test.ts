import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  compareOpsConfig,
  createOpsConfig,
  listAuthorizedPins,
  listOpsConfig,
  publishOpsConfig,
  saveOpsConfigDraft,
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

describe("ops-config client", () => {
  it("lists and selects authorized pins with credentials include", async () => {
    withSession();
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
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
              latestDigest: "sha256:aa",
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
    }

    seen.url = undefined;
    const authorized = await listAuthorizedPins(identity, "cluster_target");
    assert.equal(authorized.ok, true);
    assert.equal(seen.url, "/api/v1/cluster-targets/authorized");
    assert.equal(seen.init?.credentials, "include");
  });

  it("create/save/publish send CSRF and If-Match, never secrets or workspaceId", async () => {
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
              spec: { template: "true", retrySafe: true },
            },
            version: {
              id: VERSION_ID,
              resourceId: RESOURCE_ID,
              kind: "command_profile",
              name: "restart",
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
            name: "restart",
            revision: url.includes("/draft") ? 2 : 1,
            spec: { template: "true", retrySafe: true },
          },
          resource: {
            id: RESOURCE_ID,
            kind: "command_profile",
            name: "restart",
            status: "draft",
            draftRevision: url.includes("/draft") ? 2 : 1,
            spec: { template: "true", retrySafe: true },
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
      "restart",
      { template: "true", retrySafe: true },
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
    assert.equal(seen[1]?.headers.get("If-Match"), "1");
    assert.equal(seen[2]?.url, `/api/v1/command-profiles/${RESOURCE_ID}/publish`);
    assert.equal(seen[2]?.headers.get(CSRF_HEADER), "csrf-ok");
    assert.match(seen[2]?.body ?? "", /first pin/);
  });

  it("fails closed when authorized selection returns 403 problem+json", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Foreign workspace resource.",
          instance: "/api/v1/ssh-targets/authorized",
          code: "forbidden",
          request_id: "cfg-forbidden-16xx",
        }),
        {
          status: 403,
          headers: { "Content-Type": PROBLEM_JSON },
        },
      )) as typeof fetch;

    const result = await listAuthorizedPins(identity, "ssh_target");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 403);
      assert.equal(result.problem.code, "forbidden");
      assert.equal(result.problem.request_id, "cfg-forbidden-16xx");
    }
  });

  it("compare posts CSRF and preserves digestMatch", async () => {
    withSession();
    const seen: { url?: string; headers?: Headers; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.headers = new Headers(init?.headers);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          equal: false,
          digestMatch: false,
          leftDigest: "sha256:aa",
          rightDigest: "sha256:bb",
          changes: [{ path: "spec.template", message: "changed" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await compareOpsConfig(
      identity,
      "command_profile",
      RESOURCE_ID,
      { kind: "draft" },
      { kind: "version", versionId: VERSION_ID },
    );
    assert.equal(result.ok, true);
    assert.equal(seen.url, `/api/v1/command-profiles/${RESOURCE_ID}/compare`);
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    if (result.ok) {
      assert.equal(result.compare.digestMatch, false);
      assert.equal(result.compare.changes[0]?.path, "spec.template");
    }
  });
});
