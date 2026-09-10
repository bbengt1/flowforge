import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCAL_SEED_DISPLAY_NAME,
  LOCAL_SEED_EXAMPLE_IDENTITY,
  LOCAL_SEED_ISSUER,
  LOCAL_SEED_SUBJECT,
  LOCAL_SEED_TENANT_NAME,
  LOCAL_SEED_TENANT_SLUG,
  LOCAL_SEED_WORKBENCH_KEY,
  LOCAL_SEED_WORKSPACE_NAME,
} from "./local-seed-example.ts";

describe("local seed example identity", () => {
  it("matches the compose localseed tenant, workbench, and PLATFORM_ADMINS subject", () => {
    assert.equal(LOCAL_SEED_ISSUER, "https://idp.example");
    assert.equal(LOCAL_SEED_SUBJECT, "admin-1");
    assert.equal(LOCAL_SEED_DISPLAY_NAME, "Admin (local seed)");
    assert.equal(LOCAL_SEED_TENANT_SLUG, "local");
    assert.equal(LOCAL_SEED_TENANT_NAME, "Local demo");
    assert.equal(LOCAL_SEED_WORKBENCH_KEY, "default");
    assert.equal(LOCAL_SEED_WORKSPACE_NAME, "Local workbench");
    assert.deepEqual(LOCAL_SEED_EXAMPLE_IDENTITY, {
      issuer: "https://idp.example",
      subject: "admin-1",
      displayName: "Admin (local seed)",
      tenantId: "",
      tenantSlug: "local",
      workbenchKey: "default",
    });
  });
});
