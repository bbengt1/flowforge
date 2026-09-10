import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  bindEmbedExchangeHost,
  exchangeEmbedAssertion,
  fetchEmbedCatalog,
  fetchEmbedJwks,
  fetchPortalAdapterCatalog,
  loadEmbedHostIssuerSources,
} from "./embed-client.ts";
import {
  FLOWFORGE_HOST_CONTEXT_HEADER,
  FLOWFORGE_HOST_ISSUER_HEADER,
  peekAssertionHostIssuer,
} from "./embed-contract.ts";
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
    let exchangeInit: RequestInit | undefined;
    const sessionBody = {
      session: {
        id: "sess-embed",
        idle_expires_at: "2026-09-09T21:00:00.000Z",
        absolute_expires_at: "2026-09-10T07:00:00.000Z",
        embed: {
          mode: "embed",
          sdk: "embed.v1",
          tenantId: "ten-1",
          tenantSlug: "acme",
          tenantName: "Acme",
          workbenchKey: "ops",
          workspaceId: "ws-1",
          workspaceName: "Ops",
          capabilities: ["workflow.view"],
        },
      },
      principal: {
        issuer: "https://portal.example.test",
        external_subject: "ada",
        display_name: "Ada",
      },
      csrf_token: "csrf-embed",
    };
    const exchangeBody = {
      ...sessionBody,
      assertion: {
        sdk: "embed.v1",
        tokenId: "jti-1",
        audience: "flowforge",
        tenantId: "ten-1",
        workbenchKey: "ops",
        display_name: "Hostile leftover",
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
    };
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      seenUrls.push(url);
      seen.url = url;
      seen.init = init;
      if (url.endsWith("/embed/exchange")) {
        exchangeInit = init;
      }
      if (url.endsWith("/session") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(sessionBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(exchangeBody), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          [CSRF_HEADER]: "csrf-header",
        },
      });
    }) as typeof fetch;

    const holder = { assertion: SAMPLE_JWS };
    const result = await exchangeEmbedAssertion(holder, {
      hostIssuer: "https://idp.example",
      hostContext: "embed",
    });
    assert.equal(result.ok, true);
    assert.ok(seenUrls.includes("/api/v1/embed/exchange"));
    assert.ok(seenUrls.includes("/api/v1/session"));
    assert.equal(seenUrls[0], "/api/v1/embed/exchange");
    assert.equal(exchangeInit?.method, "POST");
    assert.equal(exchangeInit?.credentials, "include");
    const body = JSON.parse(String(exchangeInit?.body));
    assert.equal(body.assertion, SAMPLE_JWS);
    assert.equal(body.sdk, "embed.v1");
    assert.equal(body.hostIssuer, "https://idp.example");
    assert.equal(body.hostContext, "embed");
    assert.equal("workspaceId" in body, false);
    const headers = new Headers(exchangeInit?.headers);
    assert.equal(headers.get("X-FlowForge-Host-Issuer"), "https://idp.example");
    assert.equal(headers.get("X-FlowForge-Host-Context"), "embed");
    assert.equal(holder.assertion, "");
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.session.subject, "ada");
    assert.equal(snapshot.session.csrfToken, "csrf-embed");
    assert.equal(snapshot.embedChrome?.source, "get-session");
    assert.equal(snapshot.embedChrome?.mode, "embed");
    assert.equal(snapshot.embedChrome?.tenantId, "ten-1");
    assert.equal(snapshot.embedChrome?.tenantSlug, "acme");
    assert.equal(snapshot.embedChrome?.tenantName, "Acme");
    assert.equal(snapshot.embedChrome?.workbenchKey, "ops");
    assert.equal(snapshot.embedChrome?.workspaceName, "Ops");
    assert.equal(snapshot.embedChrome?.displayName, "Ada");
    assert.deepEqual(snapshot.embedChrome?.capabilities, ["workflow.view"]);
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

  it("treats 429 rate-limited as backoff, not forbidden", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:rate-limited",
          title: "Rate Limited",
          status: 429,
          detail: "Embed exchange rate limit exceeded.",
          instance: "/embed/exchange",
          code: "rate-limited",
          request_id: "r-429",
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    }) as typeof fetch;
    const holder = { assertion: SAMPLE_JWS };
    const result = await exchangeEmbedAssertion(holder);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 429);
      assert.equal(result.forbidden, false);
      assert.match(result.problem.detail, /Back off/);
    }
    assert.equal(holder.assertion, "");
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

  it("loads catalog issuers and exchanges with configured binding, never iss from the JWS", async () => {
    const hostileIss = "https://evil.example";
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({ iss: hostileIss, aud: "flowforge", host: hostileIss }),
    ).toString("base64url");
    const hostileJws = `${header}.${payload}.sig`;
    assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).iss, hostileIss);
    assert.equal(peekAssertionHostIssuer(hostileJws), undefined);

    const seenUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.endsWith("/embed/catalog")) {
        return new Response(
          JSON.stringify({
            sdk: "embed.v1",
            issuers: ["https://idp.example"],
            iss: hostileIss,
            assertion: hostileJws,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/portal/adapter")) {
        return new Response(
          JSON.stringify({
            adapter: "portal.v1",
            issuers: [
              "https://portal.a.example",
              "https://portal.cp-ops.example",
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const adapter = await fetchPortalAdapterCatalog();
    assert.equal(adapter.ok, true);
    const sources = await loadEmbedHostIssuerSources();
    assert.deepEqual(sources.embedIssuers, ["https://idp.example"]);
    assert.deepEqual(sources.portalIssuers, [
      "https://portal.a.example",
      "https://portal.cp-ops.example",
    ]);
    assert.ok(seenUrls.some((url) => url.endsWith("/portal/adapter")));

    const portalBinding = bindEmbedExchangeHost({
      hostContext: "portal",
      portalIssuers: sources.portalIssuers,
      portalIssuer: "https://portal.cp-ops.example",
    });
    assert.equal(portalBinding.hostIssuer, "https://portal.cp-ops.example");
    assert.notEqual(portalBinding.hostIssuer, hostileIss);

    const standaloneBinding = bindEmbedExchangeHost({
      embedIssuers: sources.embedIssuers,
    });
    assert.deepEqual(standaloneBinding, {
      hostContext: "embed",
      hostIssuer: "https://idp.example",
    });

    const seen: { url?: string; init?: RequestInit } = {};
    const bindBody = {
      session: {
        id: "sess-bind",
        idle_expires_at: "2026-09-09T21:00:00.000Z",
        absolute_expires_at: "2026-09-10T07:00:00.000Z",
        embed: {
          mode: "embed",
          sdk: "embed.v1",
          tenantId: "ten-1",
          tenantSlug: "acme",
          tenantName: "Acme",
          workbenchKey: "ops",
          workspaceId: "ws-1",
          workspaceName: "Ops",
          capabilities: ["workflow.view"],
        },
      },
      principal: {
        issuer: "https://idp.example",
        external_subject: "ada",
        display_name: "Ada",
      },
      workspace: {
        id: "ws-1",
        tenant_id: "ten-1",
        workbench_key: "ops",
        name: "Ops",
      },
      tenant: { id: "ten-1", slug: "acme" },
      capabilities: ["workflow.view"],
    };
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/embed/exchange")) {
        seen.url = url;
        seen.init = init;
        return new Response(JSON.stringify(bindBody), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(bindBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const holder = { assertion: hostileJws };
    const result = await exchangeEmbedAssertion(holder, standaloneBinding);
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/embed/exchange");
    assert.equal(seen.init?.credentials, "include");
    const body = JSON.parse(String(seen.init?.body));
    assert.equal(body.assertion, hostileJws);
    assert.equal(body.hostIssuer, "https://idp.example");
    assert.equal(body.hostContext, "embed");
    assert.notEqual(body.hostIssuer, hostileIss);
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(FLOWFORGE_HOST_ISSUER_HEADER), "https://idp.example");
    assert.equal(headers.get(FLOWFORGE_HOST_CONTEXT_HEADER), "embed");
    assert.notEqual(headers.get(FLOWFORGE_HOST_ISSUER_HEADER), hostileIss);
    assert.equal(holder.assertion, "");
  });
});
