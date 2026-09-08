import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FLOWFORGE_ISSUER_HEADER,
  FLOWFORGE_SUBJECT_HEADER,
  FLOWFORGE_TENANT_ID_HEADER,
  FLOWFORGE_TENANT_SLUG_HEADER,
  FLOWFORGE_WORKBENCH_KEY_HEADER,
  FLOWFORGE_WORKSPACE_ID_HEADER,
  clientIdentityHeaders,
  emptyDevIdentity,
  hasCallerIdentity,
  hasWorkspaceLookup,
  isWorkspaceIdOnlyIdentity,
  pickForwardedIdentityHeaders,
} from "./identity-headers.ts";

describe("pickForwardedIdentityHeaders", () => {
  it("copies only the documented FlowForge identity headers", () => {
    const source = new Headers({
      [FLOWFORGE_ISSUER_HEADER]: " https://host.example ",
      [FLOWFORGE_SUBJECT_HEADER]: "operator-1",
      [FLOWFORGE_TENANT_SLUG_HEADER]: "acme",
      [FLOWFORGE_WORKBENCH_KEY_HEADER]: "ops",
      [FLOWFORGE_WORKSPACE_ID_HEADER]: "11111111-1111-1111-1111-111111111111",
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "X-Forwarded-For": "1.2.3.4",
    });

    const forwarded = pickForwardedIdentityHeaders(source);
    assert.equal(forwarded.get(FLOWFORGE_ISSUER_HEADER), "https://host.example");
    assert.equal(forwarded.get(FLOWFORGE_SUBJECT_HEADER), "operator-1");
    assert.equal(forwarded.get(FLOWFORGE_TENANT_SLUG_HEADER), "acme");
    assert.equal(forwarded.get(FLOWFORGE_WORKBENCH_KEY_HEADER), "ops");
    assert.equal(forwarded.get(FLOWFORGE_WORKSPACE_ID_HEADER), null);
    assert.equal(forwarded.get("Authorization"), null);
    assert.equal(forwarded.get("Cookie"), null);
    assert.equal(forwarded.get("X-Forwarded-For"), null);
  });

  it("does not forward a host-supplied workspace UUID as the lookup key", () => {
    const source = new Headers({
      [FLOWFORGE_ISSUER_HEADER]: "https://host.example",
      [FLOWFORGE_SUBJECT_HEADER]: "operator-1",
      [FLOWFORGE_WORKSPACE_ID_HEADER]: "11111111-1111-1111-1111-111111111111",
    });
    const forwarded = pickForwardedIdentityHeaders(source);
    assert.equal(forwarded.get(FLOWFORGE_WORKSPACE_ID_HEADER), null);
    assert.equal(forwarded.get(FLOWFORGE_TENANT_ID_HEADER), null);
    assert.equal(forwarded.get(FLOWFORGE_WORKBENCH_KEY_HEADER), null);
  });
});

describe("clientIdentityHeaders", () => {
  it("never emits X-FlowForge-Workspace-ID", () => {
    const headers = clientIdentityHeaders({
      issuer: "https://host.example",
      subject: "operator-1",
      displayName: "Chloe",
      tenantId: "11111111-1111-1111-1111-111111111111",
      tenantSlug: "acme",
      workbenchKey: "ops",
    });
    assert.equal(headers[FLOWFORGE_WORKSPACE_ID_HEADER], undefined);
    assert.equal(
      Object.keys(headers).some((key) => key.toLowerCase().includes("workspace-id")),
      false,
    );
    assert.equal(headers[FLOWFORGE_ISSUER_HEADER], "https://host.example");
    assert.equal(headers[FLOWFORGE_WORKBENCH_KEY_HEADER], "ops");
  });

  it("omits blank fields", () => {
    const headers = clientIdentityHeaders(emptyDevIdentity());
    assert.deepEqual(headers, {});
  });
});

describe("workspace lookup helpers", () => {
  it("requires issuer+subject for the caller and tenant+workbench for a workspace", () => {
    const identity = emptyDevIdentity();
    assert.equal(hasCallerIdentity(identity), false);
    assert.equal(hasWorkspaceLookup(identity), false);

    identity.issuer = "https://host.example";
    identity.subject = "operator-1";
    assert.equal(hasCallerIdentity(identity), true);
    assert.equal(hasWorkspaceLookup(identity), false);

    identity.tenantSlug = "acme";
    identity.workbenchKey = "ops";
    assert.equal(hasWorkspaceLookup(identity), true);
  });

  it("detects workspace-id-only host identity so the UI never treats it as lookup", () => {
    assert.equal(
      isWorkspaceIdOnlyIdentity(
        new Headers({
          [FLOWFORGE_WORKSPACE_ID_HEADER]: "11111111-1111-1111-1111-111111111111",
        }),
      ),
      true,
    );
    assert.equal(
      isWorkspaceIdOnlyIdentity(
        new Headers({
          [FLOWFORGE_TENANT_SLUG_HEADER]: "acme",
          [FLOWFORGE_WORKBENCH_KEY_HEADER]: "ops",
          [FLOWFORGE_WORKSPACE_ID_HEADER]: "11111111-1111-1111-1111-111111111111",
        }),
      ),
      false,
    );
  });
});
