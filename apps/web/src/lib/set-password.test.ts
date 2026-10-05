import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchSameOriginProxy } from "./identity-client.ts";
import { ONE_TIME_BOOTSTRAP_PASSWORD } from "./change-password.ts";
import { CHANGE_PASSWORD_HREF } from "./change-password.ts";
import { setAdminPassword } from "./session-client.ts";
import { csrfRequiredFor } from "./session-contract.ts";
import {
  clearSession,
  getSessionSnapshot,
  setActiveSession,
} from "./session-store.ts";
import type { BrowserSession } from "./session.ts";
import {
  SET_PASSWORD,
  SET_PASSWORD_API_PATH,
  SET_PASSWORD_API_PR,
  SET_PASSWORD_CHROME_SOURCE,
  SET_PASSWORD_CHANGE_REQUIRED,
  SET_PASSWORD_CSRF,
  SET_PASSWORD_EMBED_FORBIDDEN,
  SET_PASSWORD_EMPTY,
  SET_PASSWORD_FAILED,
  SET_PASSWORD_HREF,
  SET_PASSWORD_ID,
  SET_PASSWORD_MISMATCH,
  SET_PASSWORD_ONE_TIME_REUSE,
  SET_PASSWORD_QUERY_REJECTED,
  SET_PASSWORD_RATE_LIMITED,
  SET_PASSWORD_SOURCES,
  SET_PASSWORD_STORY,
  SET_PASSWORD_SUCCESS_HREF,
  SET_PASSWORD_TOKEN_CONSUMED,
  SET_PASSWORD_TOKEN_INVALID,
  SET_PASSWORD_TOKEN_REJECTED,
  SET_PASSWORD_TOO_SHORT,
  SET_PASSWORD_UNAVAILABLE,
  adminPasswordBody,
  afterAdminPasswordHref,
  clearSetPasswordForm,
  decideSetPasswordChrome,
  embedSourceMountsSetPassword,
  emptySetPasswordForm,
  isSetPasswordPath,
  locationCarriesSetupSecret,
  parseAdminPasswordSet,
  setPasswordClientError,
  setPasswordFailureAction,
  setPasswordFailureMessage,
  setPasswordFormIsSubmittable,
  setPasswordHoldsHardLines,
  setPasswordProxyStripsStaleCookie,
  setPasswordSourceConsumesV1Tokens,
  setPasswordSourceHasBypass,
  setPasswordSourceReadsQuerySecret,
  setPasswordSourceRetainsSecrets,
} from "./set-password.ts";

const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

const FIXTURE_TOKEN = "setup-token-fixture";
const FIXTURE_PASSWORD = "correct-horse";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

const active: BrowserSession = {
  issuer: "local",
  subject: "admin",
  displayName: "Admin",
  sessionId: "sess-1",
  idleExpiresAt: "2026-09-15T21:00:00.000Z",
  absoluteExpiresAt: "2026-09-16T07:00:00.000Z",
  csrfToken: "csrf-ok",
  mustChangePassword: false,
};

function problem(status: number, code: string, detail: string): string {
  return JSON.stringify({
    type: `urn:flowforge:problem:${code}`,
    title: "Problem",
    status,
    detail,
    instance: SET_PASSWORD_API_PATH,
    code,
    request_id: "req-set-password",
  });
}

function createdBody(extra: Record<string, unknown> = {}) {
  return {
    adminPasswordSet: true,
    mustChangePassword: false,
    loginReady: true,
    identifier: "admin",
    bootstrap: {
      complete: true,
      incomplete: false,
      skipped: true,
      standaloneOnly: true,
    },
    ...extra,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("#572 set-password chrome", () => {
  it("cites the setup-token contract and holds hard lines", () => {
    assert.equal(SET_PASSWORD_STORY, 572);
    assert.equal(SET_PASSWORD_API_PR, 580);
    assert.equal(SET_PASSWORD_ID, "set-password-setup-token");
    assert.equal(setPasswordHoldsHardLines(), true);
    assert.equal(SET_PASSWORD.successOpensLogin, true);
    assert.equal(SET_PASSWORD.doesNotMintSession, true);
    assert.equal(SET_PASSWORD.tokenNeverInUrl, true);
    assert.equal(SET_PASSWORD.tokenNeverInStorage, true);
    assert.equal(SET_PASSWORD_HREF, "/set-password");
    assert.equal(SET_PASSWORD_SUCCESS_HREF, "/login");
    assert.equal(afterAdminPasswordHref(), "/login");
    assert.equal(SET_PASSWORD_API_PATH, "/api/v1/bootstrap/admin-password");
    assert.equal(setPasswordProxyStripsStaleCookie(), true);
    assert.equal(csrfRequiredFor("POST", SET_PASSWORD_API_PATH), false);
    assert.equal(
      csrfRequiredFor("POST", "/api/control-plane/bootstrap/admin-password"),
      false,
    );
    assert.deepEqual(
      [...SET_PASSWORD_SOURCES],
      [
        "src/lib/set-password.ts",
        "src/lib/session-client.ts",
        "src/lib/session-contract.ts",
        "src/lib/identity-client.ts",
        "src/lib/session-store.ts",
        "src/components/session/SetPasswordChrome.tsx",
        "src/components/session/SetPasswordLanding.tsx",
        "src/components/session/SignedOutGate.tsx",
        "src/components/session/LoginChrome.tsx",
        "src/app/set-password/page.tsx",
      ],
    );
  });

  it("is full-dark set-password chrome: masked token and password, one submit", () => {
    const chrome = source(SET_PASSWORD_CHROME_SOURCE);
    assert.match(chrome, /Set admin password/);
    assert.match(chrome, /Setup token/);
    assert.match(chrome, /New password/);
    assert.match(chrome, /Confirm password/);
    assert.match(chrome, /Set password/);
    assert.equal((chrome.match(/type="password"/g) ?? []).length, 3);
    assert.match(chrome, /method="post"/);
    assert.match(chrome, /setAdminPassword/);
    assert.match(chrome, /clearSetPasswordForm/);
    assert.match(chrome, /locationCarriesSetupSecret/);
    assert.match(chrome, /afterAdminPasswordHref/);
    assert.match(chrome, /SET_PASSWORD_QUERY_REJECTED/);
    assert.equal(setPasswordSourceConsumesV1Tokens(chrome), true);
    assert.equal(setPasswordSourceRetainsSecrets(chrome), false);
    assert.equal(setPasswordSourceReadsQuerySecret(chrome), false);
    assert.equal(setPasswordSourceHasBypass(chrome), false);
    assert.equal(chrome.includes("localStorage"), false);
    assert.equal(chrome.includes("sessionStorage"), false);
    assert.doesNotMatch(chrome, /searchParams\.get/);
    const gate = source("src/components/session/SignedOutGate.tsx");
    assert.match(gate, /SetPasswordChrome/);
    assert.match(gate, /decideSetPasswordChrome/);
    const login = source("src/components/session/LoginChrome.tsx");
    assert.match(login, /SET_PASSWORD_HREF/);
    assert.match(login, /Set the admin password/);
  });

  it("shows the screen only when signed out on /set-password, never on embed", () => {
    assert.equal(isSetPasswordPath("/set-password"), true);
    assert.equal(isSetPasswordPath("/set-password?setup_token=1"), true);
    assert.equal(isSetPasswordPath("/login"), false);
    assert.equal(
      decideSetPasswordChrome({
        embed: false,
        pathname: "/set-password",
        sessionActive: false,
      }),
      "set-password",
    );
    assert.equal(
      decideSetPasswordChrome({
        embed: false,
        pathname: "/workflows",
        sessionActive: false,
      }),
      "login",
    );
    assert.equal(
      decideSetPasswordChrome({
        embed: true,
        pathname: "/set-password",
        sessionActive: false,
      }),
      "ignore",
    );
    assert.equal(
      decideSetPasswordChrome({
        embed: false,
        pathname: "/set-password",
        sessionActive: true,
      }),
      "ignore",
    );

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(embedSourceMountsSetPassword(embedBranch), false);
    assert.equal(embedBranch.includes("SetPasswordChrome"), false);
    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(embedSourceMountsSetPassword(embedChrome), false);
  });

  it("rejects a query-string token without returning the value", () => {
    const planted = "query-token-value";
    assert.equal(locationCarriesSetupSecret(`?setup_token=${planted}`), true);
    assert.equal(locationCarriesSetupSecret("?setup-token=abc"), true);
    assert.equal(locationCarriesSetupSecret("?password=abc"), true);
    assert.equal(locationCarriesSetupSecret("", "#setup_token=abc"), true);
    assert.equal(locationCarriesSetupSecret("?next=/workflows"), false);
    assert.equal(SET_PASSWORD_QUERY_REJECTED.includes(planted), false);
    const chrome = source(SET_PASSWORD_CHROME_SOURCE);
    assert.equal(chrome.includes(planted), false);
    assert.equal(chrome.includes("localStorage.setItem"), false);
  });

  it("checks the token and password before POST and clears both fields", () => {
    const form = {
      setupToken: `  ${FIXTURE_TOKEN}  `,
      password: FIXTURE_PASSWORD,
      confirm: FIXTURE_PASSWORD,
    };
    assert.equal(setPasswordClientError(form), null);
    assert.deepEqual(adminPasswordBody(form.setupToken, form.password), {
      setup_token: FIXTURE_TOKEN,
      password: FIXTURE_PASSWORD,
    });
    assert.deepEqual(Object.keys(adminPasswordBody(form.setupToken, form.password)), [
      "setup_token",
      "password",
    ]);
    assert.equal(setPasswordFormIsSubmittable(clearSetPasswordForm()), false);
    assert.deepEqual(emptySetPasswordForm(), {
      setupToken: "",
      password: "",
      confirm: "",
    });
    assert.equal(
      setPasswordClientError({ setupToken: "", password: "", confirm: "" }),
      SET_PASSWORD_EMPTY,
    );
    assert.equal(
      setPasswordClientError({
        setupToken: FIXTURE_TOKEN,
        password: FIXTURE_PASSWORD,
        confirm: "other-horse",
      }),
      SET_PASSWORD_MISMATCH,
    );
    assert.equal(
      setPasswordClientError({
        setupToken: "short",
        password: FIXTURE_PASSWORD,
        confirm: FIXTURE_PASSWORD,
      }),
      SET_PASSWORD_TOKEN_INVALID,
    );
    assert.equal(
      setPasswordClientError({
        setupToken: "token with spaces!!",
        password: FIXTURE_PASSWORD,
        confirm: FIXTURE_PASSWORD,
      }),
      SET_PASSWORD_TOKEN_INVALID,
    );
    assert.equal(
      setPasswordClientError({
        setupToken: FIXTURE_TOKEN,
        password: ONE_TIME_BOOTSTRAP_PASSWORD,
        confirm: ONE_TIME_BOOTSTRAP_PASSWORD,
      }),
      SET_PASSWORD_ONE_TIME_REUSE,
    );
    assert.equal(
      setPasswordClientError({
        setupToken: FIXTURE_TOKEN,
        password: FIXTURE_TOKEN,
        confirm: FIXTURE_TOKEN,
      }),
      SET_PASSWORD_ONE_TIME_REUSE,
    );
    assert.equal(
      setPasswordClientError({
        setupToken: FIXTURE_TOKEN,
        password: "short",
        confirm: "short",
      }),
      SET_PASSWORD_TOO_SHORT,
    );
  });

  it("POSTs setup_token and password once and opens Login without a session", async () => {
    const seen: { url?: string; method?: string; body?: string; headers?: Headers } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      seen.body = String(init?.body ?? "");
      seen.headers = new Headers(init?.headers);
      return new Response(JSON.stringify(createdBody({ password: FIXTURE_PASSWORD, setup_token: FIXTURE_TOKEN })), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await setAdminPassword({
      setupToken: FIXTURE_TOKEN,
      password: FIXTURE_PASSWORD,
    });
    assert.equal(result.ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/v1/bootstrap/admin-password");
    assert.equal(
      seen.body,
      JSON.stringify({ setup_token: FIXTURE_TOKEN, password: FIXTURE_PASSWORD }),
    );
    assert.equal(seen.headers?.has("X-CSRF-Token"), false);
    assert.equal(result.ok && parseAdminPasswordSet(result.data)?.loginReady, true);
    const parsed = result.ok ? parseAdminPasswordSet(result.data) : null;
    assert.equal(JSON.stringify(parsed).includes(FIXTURE_PASSWORD), false);
    assert.equal(JSON.stringify(parsed).includes(FIXTURE_TOKEN), false);
    assert.equal(getSessionSnapshot().active, false);
    assert.equal(JSON.stringify(getSessionSnapshot()).includes(FIXTURE_PASSWORD), false);
    assert.equal(JSON.stringify(getSessionSnapshot()).includes(FIXTURE_TOKEN), false);
    assert.equal(afterAdminPasswordHref(), "/login");
  });

  it("drops echoed secrets from a 201 body and rejects a must-change flag", () => {
    const planted = "echoed-secret-value";
    const parsed = parseAdminPasswordSet(
      createdBody({ password: planted, setup_token: planted }),
    );
    assert.equal(parsed?.loginReady, true);
    assert.equal(JSON.stringify(parsed).includes(planted), false);
    assert.equal(
      parseAdminPasswordSet({
        adminPasswordSet: true,
        mustChangePassword: true,
        loginReady: true,
        identifier: "admin",
      }),
      null,
    );
    assert.equal(parseAdminPasswordSet(createdBody())?.identifier, "admin");
  });

  it("maps 401, 409, 429, 400, 403, and 503 without echoing the token", () => {
    const planted = FIXTURE_TOKEN;
    assert.equal(
      setPasswordFailureMessage(401, `rejected ${planted}`),
      SET_PASSWORD_TOKEN_REJECTED,
    );
    assert.equal(setPasswordFailureMessage(401, planted).includes(planted), false);
    assert.equal(setPasswordFailureMessage(409, planted), SET_PASSWORD_TOKEN_CONSUMED);
    assert.equal(setPasswordFailureMessage(429, planted), SET_PASSWORD_RATE_LIMITED);
    assert.equal(
      setPasswordFailureMessage(429, planted, 12),
      `${SET_PASSWORD_RATE_LIMITED} Retry after 12 seconds.`,
    );
    assert.equal(
      setPasswordFailureMessage(400, SET_PASSWORD_TOO_SHORT),
      SET_PASSWORD_TOO_SHORT,
    );
    assert.equal(
      setPasswordFailureMessage(400, `bad ${planted}`),
      SET_PASSWORD_FAILED,
    );
    assert.equal(setPasswordFailureMessage(400, planted).includes(planted), false);
    assert.equal(setPasswordFailureMessage(403, "CSRF validation failed."), SET_PASSWORD_CSRF);
    assert.equal(setPasswordFailureMessage(403, "embed"), SET_PASSWORD_EMBED_FORBIDDEN);
    assert.equal(setPasswordFailureMessage(503, planted), SET_PASSWORD_UNAVAILABLE);
    assert.equal(setPasswordFailureMessage(404, planted), SET_PASSWORD_FAILED);
    assert.equal(
      setPasswordFailureAction(403, "password_change_required"),
      "change-password",
    );
    assert.equal(setPasswordFailureAction(403, "forbidden"), "message");
    assert.equal(SET_PASSWORD_CHANGE_REQUIRED.includes(planted), false);
    assert.equal(CHANGE_PASSWORD_HREF, "/change-password");
  });

  it("opens change-password when an authenticated call returns password_change_required", async () => {
    setActiveSession(active);
    globalThis.fetch = (async () =>
      new Response(
        problem(403, "password_change_required", "Password change is required."),
        {
          status: 403,
          headers: { "Content-Type": "application/problem+json" },
        },
      )) as typeof fetch;

    const result = await fetchSameOriginProxy({
      instance: "/api/v1/workflows",
      method: "GET",
      headers: { Accept: "application/json" },
      requestId: "req-gate",
    });
    assert.equal(result.ok, false);
    assert.equal(getSessionSnapshot().active, true);
    assert.equal(getSessionSnapshot().session.mustChangePassword, true);
    assert.equal(
      JSON.stringify(getSessionSnapshot()).includes(FIXTURE_TOKEN),
      false,
    );
  });

  it("does not mark an embed session as must-change", async () => {
    setActiveSession(active, {
      source: "get-session",
      mode: "embed",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      tenantName: "Acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view"],
      displayName: "Admin",
    });
    globalThis.fetch = (async () =>
      new Response(
        problem(403, "password_change_required", "Password change is required."),
        {
          status: 403,
          headers: { "Content-Type": "application/problem+json" },
        },
      )) as typeof fetch;
    await fetchSameOriginProxy({
      instance: "/api/v1/workflows",
      method: "GET",
      headers: { Accept: "application/json" },
      requestId: "req-embed",
    });
    assert.equal(getSessionSnapshot().session.mustChangePassword, false);
  });

  it("reads Retry-After on 429 and attaches CSRF only when a token is already in memory", async () => {
    setActiveSession(active);
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-CSRF-Token"), "csrf-ok");
      return new Response(problem(429, "rate-limited", SET_PASSWORD_RATE_LIMITED), {
        status: 429,
        headers: {
          "Content-Type": "application/problem+json",
          "Retry-After": "9",
        },
      });
    }) as typeof fetch;

    const result = await setAdminPassword({
      setupToken: FIXTURE_TOKEN,
      password: FIXTURE_PASSWORD,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.retryAfterSeconds, 9);
      assert.equal(
        setPasswordFailureMessage(result.statusCode, result.problem.detail, result.retryAfterSeconds),
        `${SET_PASSWORD_RATE_LIMITED} Retry after 9 seconds.`,
      );
      assert.equal(result.problem.detail.includes(FIXTURE_TOKEN), false);
    }
    assert.equal(getSessionSnapshot().session.mustChangePassword, false);
  });
});
