import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearSession, setActiveSession } from "./session-store.ts";
import type { DevIdentity } from "./identity-headers.ts";
import { listWorkflowFolders } from "./workflow-folder-client.ts";

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
});
