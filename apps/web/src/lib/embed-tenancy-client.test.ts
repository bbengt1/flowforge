import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearDevIdentity, loadDevIdentity } from "./dev-identity.ts";
import { FLOWFORGE_TENANT_ID_HEADER, FLOWFORGE_WORKBENCH_KEY_HEADER } from "./identity-headers.ts";
import {
  attachEmbedWorkspaceHeaders,
  bindIdentityToVerified,
  clearEmbedVerified,
  loadEmbedVerified,
  persistVerifiedFromExchange,
  persistVerifiedFromSession,
  persistVerifiedFromWorkspace,
} from "./embed-tenancy-client.ts";

const memory = new Map<string, string>();
const sessionShim = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};
Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionShim,
  configurable: true,
});

afterEach(() => {
  memory.clear();
  clearEmbedVerified();
  clearDevIdentity();
});

describe("embed-tenancy-client", () => {
  it("persists exchange workspace from FlowForge, not host fields", () => {
    const verified = persistVerifiedFromExchange({
      audience: "flowforge",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view"],
      tokenId: "jti-1",
    });
    assert.equal(verified?.source, "flowforge");
    assert.equal(loadEmbedVerified()?.workbenchKey, "ops");
    assert.equal(loadEmbedVerified()?.tenantSlug, "acme");
  });

  it("rejects host-shaped storage and adopts GET /workspace", () => {
    sessionStorage.setItem(
      "flowforge.embed-verified.v1",
      JSON.stringify({
        source: "host",
        tenantId: "evil",
        workbenchKey: "prod",
      }),
    );
    assert.equal(loadEmbedVerified(), null);
    const adopted = persistVerifiedFromWorkspace({
      workspace: {
        id: "ws-1",
        tenant_id: "ten-1",
        workbench_key: "ops",
        name: "Ops",
        status: "active",
      },
      tenant: { id: "ten-1", slug: "acme", name: "Acme", status: "active" },
      principal: {
        id: "u1",
        issuer: "https://host",
        external_subject: "ada",
        status: "active",
      },
      roles: [],
      permissions: [],
    });
    assert.equal(adopted?.tenantId, "ten-1");
    assert.equal(loadEmbedVerified()?.source, "flowforge");
  });

  it("overwrites tampered identity lookup with the verified pair", () => {
    persistVerifiedFromExchange({
      audience: "flowforge",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: [],
      tokenId: "jti-1",
    });
    const bound = bindIdentityToVerified(
      {
        issuer: "",
        subject: "",
        displayName: "",
        tenantId: "host-supplied",
        tenantSlug: "evil",
        workbenchKey: "prod",
      },
      loadEmbedVerified()!,
    );
    assert.equal(bound.tenantId, "ten-1");
    assert.equal(bound.workbenchKey, "ops");
    assert.equal(loadDevIdentity().tenantSlug, "acme");
    assert.equal(loadDevIdentity().workbenchKey, "ops");
  });

  it("persists GET /session session.embed and overwrites host headers", () => {
    const verified = persistVerifiedFromSession({
      embed: {
        tenantId: "ten-1",
        workbenchKey: "ops",
        workspaceId: "ws-1",
        capabilities: ["workflow.view"],
      },
    });
    assert.equal(verified?.source, "flowforge");
    assert.deepEqual(verified?.capabilities, ["workflow.view"]);
    const headers = attachEmbedWorkspaceHeaders(
      {
        [FLOWFORGE_TENANT_ID_HEADER]: "host-supplied",
        [FLOWFORGE_WORKBENCH_KEY_HEADER]: "prod",
      },
      "/api/v1/workspace",
    );
    assert.equal(headers[FLOWFORGE_TENANT_ID_HEADER], "ten-1");
    assert.equal(headers[FLOWFORGE_WORKBENCH_KEY_HEADER], "ops");
    const skipped = attachEmbedWorkspaceHeaders(
      { [FLOWFORGE_TENANT_ID_HEADER]: "host-supplied" },
      "/api/v1/embed/exchange",
    );
    assert.equal(skipped[FLOWFORGE_TENANT_ID_HEADER], "host-supplied");
  });
});
