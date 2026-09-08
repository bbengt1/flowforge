import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cookieHasSession,
  proxyCsrfDenial,
  readCsrfCookie,
} from "./csrf.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./session-contract.ts";

describe("CSRF cookie helpers", () => {
  it("reads the double-submit CSRF cookie and detects a session cookie", () => {
    assert.equal(
      readCsrfCookie(`${SESSION_COOKIE_NAME}=opaque; ${CSRF_COOKIE_NAME}=token%2D1`),
      "token-1",
    );
    assert.equal(cookieHasSession(`${SESSION_COOKIE_NAME}=opaque`), true);
    assert.equal(cookieHasSession("other=1"), false);
  });
});

describe("proxy CSRF fail-closed", () => {
  it("rejects state-changing requests that have a session cookie but no CSRF header", () => {
    const denied = proxyCsrfDenial({
      method: "POST",
      proxyPath: "/api/control-plane/tenants",
      cookieHeader: `${SESSION_COOKIE_NAME}=opaque`,
      csrfHeader: null,
      requestId: "req-id-16charsxxx",
    });
    assert.ok(denied);
    assert.equal(denied?.code, "csrf-required");
    assert.equal(denied?.status, 403);
  });

  it("allows bootstrap POST /session, safe methods, and requests with CSRF", () => {
    assert.equal(
      proxyCsrfDenial({
        method: "POST",
        proxyPath: "/api/control-plane/session",
        cookieHeader: `${SESSION_COOKIE_NAME}=opaque`,
        csrfHeader: null,
        requestId: "req-id-16charsxxx",
      }),
      null,
    );
    assert.equal(
      proxyCsrfDenial({
        method: "GET",
        proxyPath: "/api/control-plane/workspaces",
        cookieHeader: `${SESSION_COOKIE_NAME}=opaque`,
        csrfHeader: null,
        requestId: "req-id-16charsxxx",
      }),
      null,
    );
    assert.equal(
      proxyCsrfDenial({
        method: "DELETE",
        proxyPath: "/api/control-plane/session",
        cookieHeader: `${SESSION_COOKIE_NAME}=opaque`,
        csrfHeader: "csrf-token",
        requestId: "req-id-16charsxxx",
      }),
      null,
    );
    assert.equal(
      proxyCsrfDenial({
        method: "POST",
        proxyPath: "/api/control-plane/tenants",
        cookieHeader: null,
        csrfHeader: null,
        requestId: "req-id-16charsxxx",
      }),
      null,
    );
  });
});
