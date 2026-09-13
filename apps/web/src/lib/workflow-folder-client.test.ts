import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearSession, setActiveSession } from "./session-store.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { PROBLEM_JSON } from "./problem.ts";
import {
  createWorkflowFolder,
  deleteWorkflowFolder,
  listWorkflowFolders,
  renameWorkflowFolder,
} from "./workflow-folder-client.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
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

describe("workflow folder client", () => {
  it("GETs /workflow-folders and drops Unfiled-shaped rows", async () => {
    withSession();
    const seen: { url?: string; method?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method ?? "GET";
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              parentId: null,
              name: "Ops",
              createdAt: "2026-09-13T00:00:00Z",
              updatedAt: "2026-09-13T00:00:00Z",
            },
            {
              id: "not-a-folder",
              name: "Unfiled",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await listWorkflowFolders(identity);
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/workflow-folders");
    assert.equal(seen.method, "GET");
    if (result.ok) {
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.name, "Ops");
      assert.equal(
        result.items.some((item) => item.name === "Unfiled"),
        false,
      );
    }
  });

  it("POSTs a folder with CSRF and optional parentId", async () => {
    withSession();
    const seen: { url?: string; method?: string; headers?: Headers; body?: string } =
      {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method ?? "GET";
      seen.headers = new Headers(init?.headers);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          parentId: "22222222-2222-4222-8222-222222222222",
          name: "On-call",
          createdAt: "2026-09-13T00:00:00Z",
          updatedAt: "2026-09-13T00:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await createWorkflowFolder(identity, {
      name: "On-call",
      parentId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/workflow-folders");
    assert.equal(seen.method, "POST");
    assert.equal(seen.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.deepEqual(JSON.parse(seen.body ?? "{}"), {
      name: "On-call",
      parentId: "22222222-2222-4222-8222-222222222222",
    });
    if (result.ok) {
      assert.equal(result.folder?.name, "On-call");
    }
  });

  it("PATCHes rename-only and DELETEs empty folders", async () => {
    withSession();
    const seen: Array<{ url?: string; method?: string; headers?: Headers; body?: string }> =
      [];
    globalThis.fetch = (async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      if ((init?.method ?? "GET") === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          parentId: null,
          name: "Operations",
          createdAt: "2026-09-13T00:00:00Z",
          updatedAt: "2026-09-13T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const renamed = await renameWorkflowFolder(
      identity,
      "11111111-1111-4111-8111-111111111111",
      "Operations",
    );
    assert.equal(renamed.ok, true);
    assert.equal(
      seen[0]?.url,
      "/api/v1/workflow-folders/11111111-1111-4111-8111-111111111111",
    );
    assert.equal(seen[0]?.method, "PATCH");
    assert.equal(seen[0]?.headers?.get(CSRF_HEADER), "csrf-ok");
    assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), { name: "Operations" });
    assert.equal(JSON.parse(seen[0]?.body ?? "{}").parentId, undefined);

    const deleted = await deleteWorkflowFolder(
      identity,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(deleted.ok, true);
    if (deleted.ok) {
      assert.equal(deleted.statusCode, 204);
    }
    assert.equal(seen[1]?.method, "DELETE");
    assert.equal(seen[1]?.headers?.get(CSRF_HEADER), "csrf-ok");
  });

  it("surfaces non-empty delete 409 counts and fails closed without CSRF", async () => {
    withSession();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:conflict",
          title: "Conflict",
          status: 409,
          detail: "Move or delete contents first.",
          instance: "/api/v1/workflow-folders/11111111-1111-4111-8111-111111111111",
          code: "conflict",
          request_id: "req-folder-409",
          workflowCount: 2,
          childFolderCount: 1,
        }),
        { status: 409, headers: { "Content-Type": PROBLEM_JSON } },
      )) as typeof fetch;

    const blocked = await deleteWorkflowFolder(
      identity,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.conflict, true);
      assert.deepEqual(blocked.notEmpty, {
        workflowCount: 2,
        childFolderCount: 1,
      });
      assert.equal(blocked.problem.detail, "Move or delete contents first.");
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
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const missing = await createWorkflowFolder(identity, { name: "Ops" });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.problem.code, "csrf-required");
      assert.equal(missing.statusCode, 403);
    }
    assert.equal(fetched, false);
  });
});
