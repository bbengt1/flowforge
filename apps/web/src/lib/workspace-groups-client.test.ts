import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import {
  addWorkspaceGroupMember,
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  getWorkspaceGroup,
  listWorkspaceGroups,
  listWorkspaceMembersPage,
  removeWorkspaceGroupMember,
  renameWorkspaceGroup,
} from "./workspace-groups-client.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-admin",
  displayName: "Admin",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const GROUP_ID = "3f1c2a4e-9d7b-4c1a-8e2f-0a1b2c3d4e5f";
const USER_ID = "88888888-8888-4888-8888-888888888888";

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

function withSession() {
  setActiveSession({
    issuer: "https://flowforge.local",
    subject: "operator-admin",
    displayName: "Admin",
    sessionId: "sess-1",
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    csrfToken: "csrf-ok",
  });
}

type Seen = { url: string; method: string; body: unknown; csrf: string | null };

function capture(response: () => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      csrf: headers.get(CSRF_HEADER),
    });
    return response();
  }) as typeof fetch;
  return seen;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Problem",
      status,
      detail: "detail",
      instance: "/api/v1/workspace/groups",
      request_id: "req-1",
      ...body,
    }),
    { status, headers: { "Content-Type": PROBLEM_JSON } },
  );
}

const group = {
  id: GROUP_ID,
  displayName: "Release managers",
  memberCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

describe("workspace groups client", () => {
  it("lists groups with the keyset cursor and reads next", async () => {
    withSession();
    const seen = capture(() =>
      json(200, { items: [group], limit: 50, cursor: "c1", next: "c2" }),
    );
    const result = await listWorkspaceGroups(identity, { limit: 50, cursor: "c1" });
    assert.equal(result.ok, true);
    assert.equal(seen[0]?.method, "GET");
    assert.match(seen[0]?.url ?? "", /^\/api\/v1\/workspace\/groups\?/);
    assert.match(seen[0]?.url ?? "", /cursor=c1/);
    if (result.ok) {
      assert.equal(result.items[0]?.displayName, "Release managers");
      assert.equal(result.next, "c2");
    }
  });

  it("creates with a trimmed displayName only, with CSRF", async () => {
    withSession();
    const seen = capture(() => json(201, group));
    const result = await createWorkspaceGroup(identity, "  Release managers ");
    assert.equal(result.ok, true);
    assert.equal(seen[0]?.url, "/api/v1/workspace/groups");
    assert.equal(seen[0]?.method, "POST");
    assert.deepEqual(seen[0]?.body, { displayName: "Release managers" });
    assert.equal(seen[0]?.csrf, "csrf-ok");
    if (result.ok) {
      assert.equal(result.group?.id, GROUP_ID);
    }
  });

  it("returns the 409 problem with its displayName path", async () => {
    withSession();
    capture(() =>
      problemResponse(409, {
        code: "group_name_taken",
        errors: [{ path: "displayName", code: "group_name_taken", message: "dup" }],
      }),
    );
    const result = await renameWorkspaceGroup(identity, GROUP_ID, "Ops");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 409);
      assert.equal(result.problem.errors?.[0]?.path, "displayName");
    }
  });

  it("renames with PATCH on the group path", async () => {
    withSession();
    const seen = capture(() => json(200, group));
    await renameWorkspaceGroup(identity, GROUP_ID, "Ops ");
    assert.equal(seen[0]?.url, `/api/v1/workspace/groups/${GROUP_ID}`);
    assert.equal(seen[0]?.method, "PATCH");
    assert.deepEqual(seen[0]?.body, { displayName: "Ops" });
  });

  it("reads detail members and treats 204 deletes as success", async () => {
    withSession();
    capture(() =>
      json(200, {
        ...group,
        members: [{ userId: USER_ID, displayName: "Ada", canApprove: false }],
      }),
    );
    const detail = await getWorkspaceGroup(identity, GROUP_ID);
    assert.equal(detail.ok, true);
    if (detail.ok) {
      assert.equal(detail.group.members[0]?.canApprove, false);
    }

    const seen = capture(() => new Response(null, { status: 204 }));
    const deleted = await deleteWorkspaceGroup(identity, GROUP_ID);
    assert.equal(deleted.ok, true);
    assert.equal(seen[0]?.method, "DELETE");
  });

  it("returns 404 for a missing group", async () => {
    withSession();
    capture(() => problemResponse(404, { code: "not-found" }));
    const detail = await getWorkspaceGroup(identity, GROUP_ID);
    assert.equal(detail.ok, false);
    if (!detail.ok) {
      assert.equal(detail.statusCode, 404);
    }
  });

  it("adds and removes members by userId (204 either way)", async () => {
    withSession();
    const seen = capture(() => new Response(null, { status: 204 }));
    const added = await addWorkspaceGroupMember(identity, GROUP_ID, USER_ID);
    const removed = await removeWorkspaceGroupMember(identity, GROUP_ID, USER_ID);
    assert.equal(added.ok, true);
    assert.equal(removed.ok, true);
    assert.equal(seen[0]?.url, `/api/v1/workspace/groups/${GROUP_ID}/members`);
    assert.equal(seen[0]?.method, "POST");
    assert.deepEqual(seen[0]?.body, { userId: USER_ID });
    assert.equal(
      seen[1]?.url,
      `/api/v1/workspace/groups/${GROUP_ID}/members/${USER_ID}`,
    );
    assert.equal(seen[1]?.method, "DELETE");
  });

  it("returns the member 400 with its userId path", async () => {
    withSession();
    capture(() =>
      problemResponse(400, {
        code: "group_member_not_in_workspace",
        errors: [{ path: "userId", code: "group_member_not_in_workspace", message: "x" }],
      }),
    );
    const result = await addWorkspaceGroupMember(identity, GROUP_ID, USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problem.code, "group_member_not_in_workspace");
      assert.equal(result.problem.errors?.[0]?.path, "userId");
    }
  });

  it("pages /workspace/members for the picker", async () => {
    withSession();
    const seen = capture(() =>
      json(200, {
        items: [
          {
            user: {
              id: USER_ID,
              issuer: "https://flowforge.local",
              external_subject: "ada",
              display_name: "Ada",
              status: "active",
            },
            roles: ["viewer"],
            permissions: [],
          },
        ],
        limit: 100,
        cursor: "",
        next: "n1",
      }),
    );
    const page = await listWorkspaceMembersPage(identity);
    assert.equal(page.ok, true);
    assert.match(seen[0]?.url ?? "", /^\/api\/v1\/workspace\/members\?limit=100$/);
    if (page.ok) {
      assert.equal(page.items.length, 1);
      assert.equal(page.next, "n1");
    }
  });
});
