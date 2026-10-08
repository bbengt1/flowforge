import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DevIdentity } from "./identity-headers.ts";
import { PROBLEM_JSON } from "./problem.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";
import { createScimToken, listScimTokens, revokeScimToken } from "./scim-tokens-client.ts";

const originalFetch = globalThis.fetch;

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-admin",
  displayName: "Admin",
  tenantId: "",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const ROW_ID = "3f1c2a4e-9d7b-4c1a-8e2f-0a1b2c3d4e5f";
const ADA = "88888888-8888-4888-8888-888888888888";
const PLAINTEXT = `ffscim_${"x".repeat(43)}`;

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
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Problem",
      status,
      detail: "detail",
      instance: "/api/v1/workspace/scim-tokens",
      request_id: "req-1",
      ...body,
    }),
    { status, headers: { "Content-Type": PROBLEM_JSON } },
  );
}

const record = {
  id: ROW_ID,
  displayName: "Okta prod",
  prefix: "ffscim_",
  createdBy: { id: ADA, displayName: "Ada" },
  createdAt: "2026-10-07T23:00:00Z",
  lastUsedAt: null,
};

describe("SCIM tokens client", () => {
  it("lists tokens with GET and reads maxActive and configured", async () => {
    withSession();
    const seen = capture(() => json(200, { items: [record], maxActive: 2, configured: true }));
    const result = await listScimTokens(identity);
    assert.equal(seen[0]?.method, "GET");
    assert.equal(seen[0]?.url, "/api/v1/workspace/scim-tokens");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.list.items[0]?.displayName, "Okta prod");
      assert.equal(result.list.maxActive, 2);
      assert.equal(result.list.configured, true);
    }
  });

  it("creates with a trimmed displayName only, under CSRF, and splits out the plaintext", async () => {
    withSession();
    const seen = capture(() => json(201, { ...record, token: PLAINTEXT }));
    const result = await createScimToken(identity, "  Okta prod ");
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "/api/v1/workspace/scim-tokens");
    assert.deepEqual(seen[0]?.body, { displayName: "Okta prod" });
    assert.equal(seen[0]?.csrf, "csrf-ok");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.plaintext, PLAINTEXT);
      assert.ok(result.record);
      assert.equal("token" in result.record, false);
      assert.equal(JSON.stringify(result.record).includes(PLAINTEXT), false);
    }
  });

  it("returns create problems untouched for the dialog to place", async () => {
    withSession();
    capture(() =>
      problemResponse(400, {
        code: "invalid-request",
        errors: [{ path: "displayName", message: "too long" }],
      }),
    );
    const invalid = await createScimToken(identity, "x");
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.problem.errors?.[0]?.path, "displayName");
    }
    capture(() => problemResponse(409, { code: "scim_token_limit" }));
    const limit = await createScimToken(identity, "Okta");
    assert.equal(!limit.ok && limit.problem.code, "scim_token_limit");
    capture(() => problemResponse(503, { code: "scim_not_configured" }));
    const off = await createScimToken(identity, "Okta");
    assert.equal(!off.ok && off.problem.code, "scim_not_configured");
    capture(() => problemResponse(501, { code: "internal-error" }));
    const stub = await createScimToken(identity, "Okta");
    assert.equal(!stub.ok && stub.statusCode, 501);
  });

  it("revokes with DELETE under CSRF; 204 is done", async () => {
    withSession();
    const seen = capture(() => new Response(null, { status: 204 }));
    const result = await revokeScimToken(identity, ROW_ID);
    assert.equal(seen[0]?.method, "DELETE");
    assert.equal(seen[0]?.url, `/api/v1/workspace/scim-tokens/${ROW_ID}`);
    assert.equal(seen[0]?.csrf, "csrf-ok");
    assert.deepEqual(result.ok && result.alreadyGone, false);
  });

  it("treats a 404 revoke as already gone", async () => {
    withSession();
    capture(() => problemResponse(404, { code: "not-found" }));
    const result = await revokeScimToken(identity, ROW_ID);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.alreadyGone, true);
  });

  it("returns other revoke problems, such as mfa-required", async () => {
    withSession();
    capture(() => problemResponse(403, { code: "mfa-required", detail: "Verify MFA before using this permission." }));
    const result = await revokeScimToken(identity, ROW_ID);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.problem.code, "mfa-required");
  });
});
