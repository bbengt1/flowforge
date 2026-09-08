import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyDevIdentity } from "./identity-headers.ts";
import { parseDevIdentity } from "./dev-identity.ts";

describe("parseDevIdentity", () => {
  it("keeps only the documented bootstrap fields", () => {
    const parsed = parseDevIdentity({
      issuer: "https://host.example",
      subject: "operator-1",
      displayName: "Chloe",
      tenantId: "11111111-1111-1111-1111-111111111111",
      tenantSlug: "acme",
      workbenchKey: "ops",
      workspaceId: "should-not-persist",
      secret: "nope",
    });
    assert.deepEqual(parsed, {
      issuer: "https://host.example",
      subject: "operator-1",
      displayName: "Chloe",
      tenantId: "11111111-1111-1111-1111-111111111111",
      tenantSlug: "acme",
      workbenchKey: "ops",
    });
    assert.equal("workspaceId" in parsed, false);
    assert.equal("secret" in parsed, false);
  });

  it("falls back to an empty identity for invalid input", () => {
    assert.deepEqual(parseDevIdentity(null), emptyDevIdentity());
    assert.deepEqual(parseDevIdentity("x"), emptyDevIdentity());
    assert.deepEqual(parseDevIdentity({ issuer: 12 }), emptyDevIdentity());
  });
});
