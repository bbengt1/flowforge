import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER,
  csrfRequiredFor,
  LOGIN_RATE_LIMIT_RULES,
  LOGIN_RATE_LIMITED_MESSAGE,
  sameOriginProxyUrl,
  sessionApiPath,
  sessionAuditEventLabel,
  sessionBrowserPath,
  SESSION_AUDIT_ADMIN_PASSWORD_SET,
  SESSION_AUDIT_ADMIN_PASSWORD_SET_LABEL,
  SESSION_AUDIT_MFA_BYPASSED,
  SESSION_AUDIT_MFA_BYPASSED_LABEL,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  SESSION_LOGIN_PATH,
  SESSION_LOGOUT_PATH,
  SESSION_PASSWORD_PATH,
  SESSION_PATH,
  SESSION_REFRESH_PATH,
} from "./session-contract.ts";
import { sessionEmbedGetPath } from "./session-embed-contract.ts";

describe("session-contract", () => {
  it("matches jonny's #22 cookie names, paths, and CSRF header", () => {
    assert.equal(sessionApiPath(), "/api/v1/session");
    assert.equal(sessionEmbedGetPath(), "/api/v1/session");
    assert.equal(sessionBrowserPath(), "/api/v1/session");
    assert.equal(sessionBrowserPath(SESSION_REFRESH_PATH), "/api/v1/session/refresh");
    assert.equal(sessionBrowserPath(SESSION_LOGOUT_PATH), "/api/v1/session/logout");
    assert.equal(sessionBrowserPath(SESSION_PASSWORD_PATH), "/api/v1/session/password");
    assert.equal(sessionBrowserPath(SESSION_LOGIN_PATH), "/api/v1/login");
    assert.equal(SESSION_PATH, "/session");
    assert.equal(SESSION_LOGIN_PATH, "/login");
    assert.equal(CSRF_HEADER, "X-CSRF-Token");
    assert.equal(SESSION_COOKIE_NAME, "ff_session");
    assert.equal(CSRF_COOKIE_NAME, "ff_csrf");
    assert.equal(SESSION_COOKIE_PATH, "/api/v1");
  });

  it("treats POST /login 429 as backoff, not invalid credentials", () => {
    assert.equal(LOGIN_RATE_LIMIT_RULES.loginRateLimited, true);
    assert.equal(LOGIN_RATE_LIMIT_RULES.status, 429);
    assert.equal(LOGIN_RATE_LIMIT_RULES.code, "rate-limited");
    assert.equal(LOGIN_RATE_LIMIT_RULES.treatAsBackoff, true);
    assert.match(LOGIN_RATE_LIMITED_MESSAGE, /429/);
    assert.match(LOGIN_RATE_LIMITED_MESSAGE, /invalid credentials/i);
  });

  it("requires CSRF on mutations except bootstrap POST /session", () => {
    assert.equal(csrfRequiredFor("GET", "/api/v1/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/login"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/login"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/oidc/start"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/oidc/callback"), false);
    assert.equal(csrfRequiredFor("GET", "/api/v1/session/mfa"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/mfa/enroll"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/mfa/verify"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/exchange"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/bootstrap/persistence"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/bootstrap/admins"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/bootstrap/admin-password"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/bootstrap/admin-password"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/bootstrap/public-url"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/bootstrap/tls"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/assertions"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/portal/adapter/assertions"), true);
    assert.equal(csrfRequiredFor("GET", "/api/v1/portal/adapter"), false);
    assert.equal(csrfRequiredFor("POST", "/session"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/refresh"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/logout"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/session/password"), true);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/session/password"), true);
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

  it("labels session.mfa_bypassed and bootstrap.admin_password_set", () => {
    assert.equal(
      sessionAuditEventLabel(SESSION_AUDIT_MFA_BYPASSED),
      SESSION_AUDIT_MFA_BYPASSED_LABEL,
    );
    assert.equal(
      sessionAuditEventLabel("session.mfa_bypassed"),
      "MFA step-up bypassed (dev)",
    );
    assert.equal(
      sessionAuditEventLabel(SESSION_AUDIT_ADMIN_PASSWORD_SET),
      SESSION_AUDIT_ADMIN_PASSWORD_SET_LABEL,
    );
    assert.equal(
      sessionAuditEventLabel("bootstrap.admin_password_set"),
      "Admin password set",
    );
    assert.equal(sessionAuditEventLabel("session.created"), "Session started");
    assert.equal(sessionAuditEventLabel("session.unknown"), "session.unknown");
    assert.equal(sessionAuditEventLabel("session.privilege_denied"), "Privilege denied");
    const panel = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../components/session/SessionPanel.tsx",
      ),
      "utf8",
    );
    assert.match(panel, /sessionAuditEventLabel\(item\.event_type\)/);
    assert.match(
      panel,
      /\{sessionAuditEventLabel\(item\.event_type\)\} · \{item\.outcome\}/,
    );
  });
});
