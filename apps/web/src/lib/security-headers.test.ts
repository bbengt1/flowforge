import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HSTS_VALUE,
  applySecurityHeaders,
  buildContentSecurityPolicy,
  embedFramingAllowed,
  getApiConnectOrigins,
  sessionConnectSrc,
  shouldSendHsts,
  staticSecurityHeaders,
} from "./security-headers.ts";

describe("getApiConnectOrigins", () => {
  it("defaults to the same local API origin as config.ts", () => {
    assert.deepEqual(getApiConnectOrigins({}), [
      "'self'",
      "http://localhost:8080",
    ]);
  });

  it("always includes self and the public API origin", () => {
    assert.deepEqual(
      getApiConnectOrigins({
        NEXT_PUBLIC_API_URL: "http://localhost:8080/",
      }),
      ["'self'", "http://localhost:8080"],
    );
  });

  it("appends extra connect-src origins from WEB_CSP_CONNECT_SRC", () => {
    const origins = getApiConnectOrigins({
      NEXT_PUBLIC_API_URL: "https://api.example.test",
      WEB_CSP_CONNECT_SRC: "https://extra.example.test wss://extra.example.test",
    });
    assert.ok(origins.includes("'self'"));
    assert.ok(origins.includes("https://api.example.test"));
    assert.ok(origins.includes("https://extra.example.test"));
    assert.ok(origins.includes("wss://extra.example.test"));
  });
});

describe("sessionConnectSrc", () => {
  it("keeps credentialed session fetches on same-origin only", () => {
    assert.deepEqual(sessionConnectSrc(), ["'self'"]);
    const csp = buildContentSecurityPolicy({
      development: false,
      connectSrc: sessionConnectSrc(),
    });
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /connect-src [^;]*\*/);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("uses a production script-src without eval and denies framing", () => {
    const csp = buildContentSecurityPolicy({
      development: false,
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8080" },
    });
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self' http:\/\/localhost:8080/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  });

  it("allows eval and inline scripts only in development without a nonce", () => {
    const csp = buildContentSecurityPolicy({
      development: true,
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8080" },
    });
    assert.match(csp, /script-src 'self' 'unsafe-eval' 'unsafe-inline'/);
  });

  it("authorizes Next.js inline scripts with a per-request nonce", () => {
    const csp = buildContentSecurityPolicy({
      development: false,
      nonce: "test-nonce",
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8080" },
    });
    assert.match(
      csp,
      /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/,
    );
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /script-src [^;]*unsafe-inline/);
  });
});

describe("shouldSendHsts", () => {
  it("is off for local HTTP so localhost:3000 stays usable", () => {
    assert.equal(shouldSendHsts({ protocol: "http:" }), false);
    assert.equal(shouldSendHsts({ forwardedProto: "http" }), false);
    assert.equal(shouldSendHsts({}), false);
  });

  it("is on for HTTPS, forwarded proto, or WEB_HSTS=1", () => {
    assert.equal(shouldSendHsts({ protocol: "https:" }), true);
    assert.equal(shouldSendHsts({ forwardedProto: "https" }), true);
    assert.equal(shouldSendHsts({ forwardedProto: "https,http" }), true);
    assert.equal(shouldSendHsts({ force: true, protocol: "http:" }), true);
  });
});

describe("embed framing", () => {
  it("keeps standalone clickjacking defaults and allowlists only /embed/v1", () => {
    const standalone = buildContentSecurityPolicy({
      development: false,
      pathname: "/workflows",
      env: { WEB_EMBED_FRAME_ANCESTORS: "https://portal.example" },
    });
    assert.match(standalone, /frame-ancestors 'none'/);
    const embedded = buildContentSecurityPolicy({
      development: false,
      pathname: "/embed/v1/workflows",
      env: { WEB_EMBED_FRAME_ANCESTORS: "https://portal.example" },
    });
    assert.match(embedded, /frame-ancestors https:\/\/portal\.example/);
    assert.equal(
      embedFramingAllowed("/embed/v1", {
        WEB_EMBED_FRAME_ANCESTORS: "https://portal.example",
      }),
      true,
    );
    const headers = staticSecurityHeaders({
      pathname: "/embed/v1/workflows",
      env: { WEB_EMBED_FRAME_ANCESTORS: "https://portal.example" },
    }).map((header) => header.key);
    assert.equal(headers.includes("X-Frame-Options"), false);
    const portalOnly = buildContentSecurityPolicy({
      development: false,
      pathname: "/embed/v1",
      env: { WEB_PORTAL_FRAME_ANCESTORS: "https://portal.cp-ops.example" },
    });
    assert.match(portalOnly, /frame-ancestors https:\/\/portal\.cp-ops\.example/);
    assert.equal(
      embedFramingAllowed("/embed/v1", {
        WEB_PORTAL_FRAME_ANCESTORS: "https://portal.cp-ops.example",
      }),
      true,
    );
  });
});

describe("staticSecurityHeaders", () => {
  it("emits the documented baseline without HSTS", () => {
    const keys = staticSecurityHeaders({
      development: false,
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8080" },
    }).map((header) => header.key);
    assert.deepEqual(keys, [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "X-Frame-Options",
      "X-DNS-Prefetch-Control",
      "Cross-Origin-Opener-Policy",
      "X-Permitted-Cross-Domain-Policies",
    ]);
    assert.equal(keys.includes("Strict-Transport-Security"), false);
  });
});

describe("applySecurityHeaders", () => {
  it("adds HSTS only when TLS is indicated", () => {
    const httpHeaders = new Map<string, string>();
    applySecurityHeaders(
      { set: (key, value) => httpHeaders.set(key, value) },
      { env: { NODE_ENV: "production" }, protocol: "http:" },
    );
    assert.equal(httpHeaders.has("Strict-Transport-Security"), false);
    assert.equal(httpHeaders.get("X-Content-Type-Options"), "nosniff");
    assert.equal(httpHeaders.get("X-Frame-Options"), "DENY");
    assert.equal(
      httpHeaders.get("Referrer-Policy"),
      "strict-origin-when-cross-origin",
    );

    const httpsHeaders = new Map<string, string>();
    applySecurityHeaders(
      { set: (key, value) => httpsHeaders.set(key, value) },
      {
        env: { NODE_ENV: "production", WEB_HSTS: "1" },
        protocol: "http:",
      },
    );
    assert.equal(httpsHeaders.get("Strict-Transport-Security"), HSTS_VALUE);
  });

  it("exposes the nonce on x-nonce and in CSP", () => {
    const headers = new Map<string, string>();
    applySecurityHeaders(
      { set: (key, value) => headers.set(key, value) },
      { env: { NODE_ENV: "production" }, nonce: "abc123" },
    );
    assert.equal(headers.get("x-nonce"), "abc123");
    assert.match(headers.get("Content-Security-Policy") ?? "", /nonce-abc123/);
  });
});
