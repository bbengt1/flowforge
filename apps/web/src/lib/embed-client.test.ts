import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  exchangeEmbedAssertion,
  fetchEmbedCatalog,
  fetchEmbedJwks,
} from "./embed-client.ts";
import { clearDevIdentity, loadDevIdentity } from "./dev-identity.ts";
import { clearEmbedVerified, loadEmbedVerified } from "./embed-tenancy-client.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, getSessionSnapshot } from "./session-store.ts";

const originalFetch = globalThis.fetch;
const SAMPLE_JWS = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";

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
  globalThis.fetch = originalFetch;
  clearSession();
  memory.clear();
  clearDevIdentity();
  clearEmbedVerified();
});

describe("embed client", () => {
  it("POSTs {assertion,sdk} to /api/v1/embed/exchange and forgets the JWS", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-embed",
            idle_expires_at: "2026-09-09T21:00:00.000Z",
            absolute_expires_at: "2026-09-10T07:00:00.000Z",
            embed: {
              tenantId: "ten-1",
              workbenchKey: "ops",
              workspaceId: "ws-1",
              capabilities: ["workflow.view"],
            },
          },
          principal: {
            issuer: "https://portal.example.test",
            external_subject: "ada",
            display_name: "Ada",
          },
          csrf_token: "csrf-embed",
          assertion: {
            sdk: "embed.v1",
            tokenId: "jti-1",
            audience: "flowforge",
            tenantId: "ten-1",
            workbenchKey: "ops",
          },
          workspace: {
            id: "ws-1",
            tenant_id: "ten-1",
            workbench_key: "ops",
            name: "Ops",
            status: "active",
          },
          tenant: { id: "ten-1", slug: "acme", name: "Acme", status: "active" },
          capabilities: ["workflow.view"],
        }),
        {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            [CSRF_HEADER]: "csrf-header",
          },
        },
      );
    }) as typeof fetch;

    const holder = { assertion: SAMPLE_JWS };
    const result = await exchangeEmbedAssertion(holder);
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/embed/exchange");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.credentials, "include");
    const body = JSON.parse(String(seen.init?.body));
    assert.equal(body.assertion, SAMPLE_JWS);
    assert.equal(body.sdk, "embed.v1");
    assert.equal("workspaceId" in body, false);
    assert.equal(holder.assertion, "");
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.session.subject, "ada");
    assert.equal(snapshot.session.csrfToken, "csrf-header");
    if (result.ok) {
      assert.equal(result.context.audience, "flowforge");
      assert.equal(result.context.tenantSlug, "acme");
      assert.equal(result.context.workbenchKey, "ops");
      assert.deepEqual(result.context.capabilities, ["workflow.view"]);
      assert.match(result.message, /ff_session/);
    }
    const identity = loadDevIdentity();
    assert.equal(identity.tenantSlug, "acme");
    assert.equal(identity.workbenchKey, "ops");
    assert.equal(identity.tenantId, "ten-1");
    const verified = loadEmbedVerified();
    assert.equal(verified?.source, "flowforge");
    assert.equal(verified?.tenantId, "ten-1");
    assert.equal(verified?.workbenchKey, "ops");
    assert.deepEqual(verified?.capabilities, ["workflow.view"]);
  });

  it("rejects a non-JWS locally and never fetches", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const holder = { assertion: "not-a-jws" };
    const result = await exchangeEmbedAssertion(holder);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
    }
    assert.equal(called, false);
    assert.equal(holder.assertion, "");
  });

  it("fail-closes on replay 409 and still forgets the assertion", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:conflict",
          title: "Conflict",
          status: 409,
          detail: "replayed",
          instance: "/embed/exchange",
          code: "replay",
          request_id: "r-replay",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    }) as typeof fetch;
    const holder = { assertion: SAMPLE_JWS };
    const result = await exchangeEmbedAssertion(holder);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 409);
      assert.match(result.problem.detail, /single-use/);
    }
    assert.equal(holder.assertion, "");
    assert.equal(getSessionSnapshot().active, false);
  });

  it("GETs catalog and strips private JWKS fields", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/embed/catalog")) {
        return new Response(
          JSON.stringify({ sdk: "embed.v1", mountPrefix: "/embed/v1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          keys: [{ kty: "OKP", crv: "Ed25519", x: "abc", d: "SECRET" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const catalog = await fetchEmbedCatalog();
    assert.equal(catalog.ok, true);
    if (catalog.ok) {
      assert.equal((catalog.data as { sdk: string }).sdk, "embed.v1");
    }
    const jwks = await fetchEmbedJwks();
    assert.equal(jwks.ok, true);
    if (jwks.ok) {
      assert.equal(jwks.leaked, true);
      assert.equal("d" in (jwks.keys[0] ?? {}), false);
      assert.equal(jwks.keys[0]?.x, "abc");
    }
  });
});
