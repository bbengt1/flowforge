import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER,
  csrfRequiredFor,
  sameOriginProxyUrl,
  sessionApiPath,
  sessionBrowserPath,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  SESSION_LOGOUT_PATH,
  SESSION_PATH,
  SESSION_REFRESH_PATH,
} from "./session-contract.ts";

describe("session-contract", () => {
  it("matches jonny's #22 cookie names, paths, and CSRF header", () => {
    assert.equal(sessionApiPath(), "/api/v1/session");
    assert.equal(sessionBrowserPath(), "/api/v1/session");
    assert.equal(sessionBrowserPath(SESSION_REFRESH_PATH), "/api/v1/session/refresh");
    assert.equal(sessionBrowserPath(SESSION_LOGOUT_PATH), "/api/v1/session/logout");
    assert.equal(SESSION_PATH, "/session");
    assert.equal(CSRF_HEADER, "X-CSRF-Token");
    assert.equal(SESSION_COOKIE_NAME, "ff_session");
    assert.equal(CSRF_COOKIE_NAME, "ff_csrf");
    assert.equal(SESSION_COOKIE_PATH, "/api/v1");
  });

  it("requires CSRF on mutations except bootstrap POST /session", () => {
    assert.equal(csrfRequiredFor("GET", "/api/v1/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/exchange"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/assertions"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/portal/adapter/assertions"), true);
    assert.equal(csrfRequiredFor("GET", "/api/v1/portal/adapter"), false);
    assert.equal(csrfRequiredFor("POST", "/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/refresh"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/logout"), true);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/session/logout"), true);
    assert.equal(csrfRequiredFor("DELETE", "/api/v1/session"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/tenants"), true);
    assert.equal(csrfRequiredFor("PUT", "/api/v1/workspace/members"), true);
    assert.equal(csrfRequiredFor("GET", "/api/v1/workspaces"), false);
  });

  it("rejects credentialed fetches that are not same-origin /api/v1 paths", () => {
    assert.equal(sameOriginProxyUrl("/tenants"), "/api/v1/tenants");
    assert.equal(sameOriginProxyUrl("/api/v1/session"), "/api/v1/session");
    assert.equal(sameOriginProxyUrl("https://api.example.test/session"), null);
    assert.equal(sameOriginProxyUrl("//evil.test/session"), null);
    assert.equal(sameOriginProxyUrl(""), null);
  });
});
