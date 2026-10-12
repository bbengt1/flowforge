import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CREDENTIAL_LIST_QUERY_CONTRACT_NOTE,
  credentialListNeedsStepUp,
  fetchSharedCredentialList,
} from "./credential-list-query.ts";
import { CREDENTIAL_PICKER_MFA_ACTION, CREDENTIAL_PICKER_MFA_HINT } from "./config-plain-copy.ts";
import { createFlowforgeQueryClient } from "./query-cache.ts";
import type { DevIdentity } from "./identity-headers.ts";

const identity: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "admin",
  displayName: "Admin",
  tenantId: "11111111-1111-4111-8111-111111111111",
  tenantSlug: "acme",
  workbenchKey: "ops",
};

const mfaProblem = {
  type: "urn:flowforge:problem:mfa-required",
  title: "MFA Required",
  status: 403,
  detail: "Verify MFA before using this permission.",
  instance: "/api/v1/credentials",
  code: "mfa-required",
  request_id: "req-1",
};

function fakeList(result: unknown) {
  const calls: { quietMfa?: boolean }[] = [];
  const list = (async (_identity: unknown, _query: unknown, options: { quietMfa?: boolean } = {}) => {
    calls.push(options);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return result;
  }) as never;
  return { list, calls };
}

describe("shared credential list (#634 F5)", () => {
  it("sends one quiet request for concurrent and repeated background reads", async () => {
    const client = createFlowforgeQueryClient();
    const refused = { ok: false, statusCode: 403, requestId: "req-1", problem: mfaProblem, strippedKeys: [] };
    const { list, calls } = fakeList(refused);
    const [a, b] = await Promise.all([
      fetchSharedCredentialList(client, identity, { list }),
      fetchSharedCredentialList(client, identity, { list }),
    ]);
    const c = await fetchSharedCredentialList(client, identity, { list });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { quietMfa: true });
    assert.equal(a.ok, false);
    assert.equal(b, a);
    assert.equal(c, a);
    client.clear();
  });

  it("reads loudly, and again, only when the person asks", async () => {
    const client = createFlowforgeQueryClient();
    const { list, calls } = fakeList({ ok: true, statusCode: 200, requestId: "r", items: [], limit: 50, cursor: "", next: "", strippedKeys: [] });
    await fetchSharedCredentialList(client, identity, { list });
    await fetchSharedCredentialList(client, identity, { list, loud: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {});
    await fetchSharedCredentialList(client, identity, { list, fresh: true });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], { quietMfa: true });
    client.clear();
  });

  it("tells step-up apart by status and code, never text", () => {
    assert.equal(credentialListNeedsStepUp(mfaProblem), true);
    assert.equal(credentialListNeedsStepUp({ status: 403, code: "forbidden" }), false);
    assert.equal(credentialListNeedsStepUp({ status: 401, code: "mfa-required" }), false);
    assert.equal(credentialListNeedsStepUp(null), false);
  });

  it("keeps developer notes out of the picker copy", () => {
    assert.match(CREDENTIAL_LIST_QUERY_CONTRACT_NOTE, /GET \/credentials/);
    for (const text of [CREDENTIAL_PICKER_MFA_HINT, CREDENTIAL_PICKER_MFA_ACTION]) {
      assert.doesNotMatch(text, /GET |\/credentials|403|mfa-required|quietMfa/);
    }
  });
});
