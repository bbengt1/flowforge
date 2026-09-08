import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CSRF_HEADER,
  csrfRequiredFor,
  sameOriginProxyUrl,
  sessionApiPath,
  sessionProxyPath,
  SESSION_COOKIE_NAME,
  SESSION_PATH,
} from "./session-contract.ts";

describe("session-contract", () => {
  it("keeps session routes and CSRF header in one adapter", () => {
    assert.equal(sessionApiPath(), "/api/v1/session");
    assert.equal(sessionProxyPath(), "/api/control-plane/session");
    assert.equal(SESSION_PATH, "/session");
    assert.equal(CSRF_HEADER, "X-CSRF-Token");
    assert.equal(SESSION_COOKIE_NAME, "flowforge_session");
  });

  it("requires CSRF on mutations except bootstrap POST /session", () => {
    assert.equal(csrfRequiredFor("GET", "/api/control-plane/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/session"), false);
    assert.equal(csrfRequiredFor("POST", "/session"), false);
    assert.equal(csrfRequiredFor("DELETE", "/api/control-plane/session"), true);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/tenants"), true);
    assert.equal(csrfRequiredFor("PUT", "/api/control-plane/workspace/members"), true);
    assert.equal(csrfRequiredFor("GET", "/api/control-plane/workspaces"), false);
  });

  it("rejects credentialed fetches that are not same-origin proxy paths", () => {
    assert.equal(sameOriginProxyUrl("/tenants"), "/api/control-plane/tenants");
    assert.equal(sameOriginProxyUrl("https://api.example.test/session"), null);
    assert.equal(sameOriginProxyUrl("//evil.test/session"), null);
    assert.equal(sameOriginProxyUrl(""), null);
  });
});
