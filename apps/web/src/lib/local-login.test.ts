import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyBootstrapStatus } from "./first-run-bootstrap.ts";
import {
  LOGIN_CHROME_SOURCE,
  LOGIN_HREF,
  LOGIN_INVALID_CREDENTIALS,
  LOGIN_STORE_UNAVAILABLE,
  LOGIN_SUCCESS_HREF,
  LOCAL_LOGIN,
  LOCAL_LOGIN_SOURCES,
  SIGNED_OUT_GATE_SOURCE,
  V0B_BRIEF,
  V0B_EPIC,
  V0B_HELP,
  V0B_ID,
  V0B_KEEP_STORY_OPEN,
  V0B_STORY,
  clearLoginPassword,
  decideSignedOutChrome,
  embedSourceMountsLogin,
  emptyLoginForm,
  localLoginBody,
  localLoginHoldsHardLines,
  loginFailureMessage,
  loginFormIsSubmittable,
  loginSourceConsumesV1Tokens,
  loginSourceIsProductDoor,
  loginSourceRetainsSecrets,
  signedOutChromeFromBootstrapFetch,
} from "./local-login.ts";
import { LOGIN_RATE_LIMITED_MESSAGE } from "./session-contract.ts";
import { loginWithPassword } from "./session-client.ts";
import { clearSession, getSessionSnapshot } from "./session-store.ts";
import { FF_ACCENT, FF_CANVAS } from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function incompleteBody() {
  return emptyBootstrapStatus();
}

function completeBody() {
  const status = emptyBootstrapStatus();
  status.complete = true;
  status.incomplete = false;
  status.steps.persistence.ready = true;
  status.steps.firstAdmin.ready = true;
  status.steps.publicUrl.ready = true;
  status.steps.tls.ready = true;
  status.steps.tls.mode = "self_signed";
  return status;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("V.0b Login chrome + signed-out gate", () => {
  it("keeps #355 open and cites epic #353 plus the signed north star", () => {
    assert.equal(V0B_STORY, 355);
    assert.equal(V0B_EPIC, 353);
    assert.equal(V0B_KEEP_STORY_OPEN, true);
    assert.equal(V0B_ID, "V.0b-login-chrome-signed-out-gate");
    assert.equal(V0B_BRIEF, "docs/architecture/flowforge-visual-ia-north-star.md");
    assert.equal(LOCAL_LOGIN.keep355Open, true);
    assert.equal(LOCAL_LOGIN.jonnyNoneExpected, true);
    assert.equal(LOCAL_LOGIN.b1GateUnchanged, true);
    assert.equal(localLoginHoldsHardLines(), true);
    assert.match(V0B_HELP, /Keep #355 open/);
    const northStar = readFileSync(
      join(here, "..", "..", "..", "..", V0B_BRIEF),
      "utf8",
    );
    assert.match(northStar, /V\.0b — Login chrome \+ signed-out gate/);
  });

  it("is full-dark Login chrome: identifier, masked password, one Sign in", () => {
    const chrome = source(LOGIN_CHROME_SOURCE);
    assert.equal(loginSourceIsProductDoor(chrome), true);
    assert.match(chrome, /Email or username/);
    assert.match(chrome, /type="password"/);
    assert.match(chrome, /"Sign in"/);
    assert.match(chrome, /Sign in with SSO/);
    assert.match(chrome, /startOidcLogin/);
    assert.doesNotMatch(chrome, /Establish session/);
    assert.doesNotMatch(chrome, /Example context/);
    assert.doesNotMatch(chrome, /trusted-dev/);
    assert.doesNotMatch(chrome, /Sign in with Google|magic.?link|Continue with/i);
    assert.equal(loginSourceConsumesV1Tokens(chrome), true);
    assert.match(chrome, /--ff-canvas/);
    assert.match(chrome, /--ff-accent/);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_ACCENT, "#0f766e");
    assert.equal(chrome.includes("localStorage"), false);
    assert.equal(chrome.includes("sessionStorage"), false);
    assert.equal(loginSourceRetainsSecrets(chrome), false);
  });

  it("sends signed-out standalone routes to Login, not Example-context", () => {
    const signedOut = decideSignedOutChrome({
      embed: false,
      bootstrap: { chrome: "home", reason: "complete" },
      sessionActive: false,
    });
    assert.equal(signedOut.chrome, "login");
    assert.equal(signedOut.reason, "signed-out");

    const gate = source(SIGNED_OUT_GATE_SOURCE);
    assert.match(gate, /LoginChrome/);
    assert.match(gate, /loadCurrentSession/);
    assert.match(gate, /router\.replace/);
    assert.match(gate, /LOGIN_SUCCESS_HREF/);

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.match(shell, /<SignedOutGate>/);
    assert.match(shell, /<BootstrapGate>/);
    const standalone = shell.slice(shell.indexOf(") : ("));
    assert.match(standalone, /SignedOutGate/);
    assert.match(standalone, /BootstrapGate/);
  });

  it("sends complete-install 401 to Login, not the wizard", () => {
    const decision = signedOutChromeFromBootstrapFetch({
      embed: false,
      statusCode: 401,
      body: incompleteBody(),
      sessionActive: false,
    });
    assert.equal(decision.chrome, "login");
    assert.equal(decision.reason, "complete-401");
    assert.notEqual(decision.chrome, "wizard");

    const gate = source("src/components/bootstrap/BootstrapGate.tsx");
    assert.match(gate, /FirstRunWizard/);
    const signedOut = source(SIGNED_OUT_GATE_SOURCE);
    assert.equal(signedOut.includes("FirstRunWizard"), false);
    assert.equal(LOCAL_LOGIN.complete401GoesToLoginNotWizard, true);
  });

  it("keeps incomplete installs on the wizard only", () => {
    const decision = signedOutChromeFromBootstrapFetch({
      embed: false,
      statusCode: 200,
      body: incompleteBody(),
      sessionActive: false,
    });
    assert.equal(decision.chrome, "wizard");
    assert.equal(decision.reason, "incomplete");
    assert.notEqual(decision.chrome, "login");

    const completeSignedIn = signedOutChromeFromBootstrapFetch({
      embed: false,
      statusCode: 200,
      body: completeBody(),
      sessionActive: true,
    });
    assert.equal(completeSignedIn.chrome, "home");
    assert.equal(completeSignedIn.reason, "session");
    assert.equal(LOCAL_LOGIN.incompleteGoesToWizardOnly, true);
    assert.equal(LOCAL_LOGIN.b1GateUnchanged, true);
  });

  it("never mounts Login on embed and leaves ADV-021 on missing session.embed", () => {
    const embed = decideSignedOutChrome({
      embed: true,
      bootstrap: { chrome: "wizard", reason: "incomplete" },
      sessionActive: false,
    });
    assert.equal(embed.chrome, "ignore");
    assert.equal(embed.reason, "embed");

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(embedSourceMountsLogin(embedBranch), false);
    assert.equal(embedBranch.includes("LoginChrome"), false);
    assert.equal(embedBranch.includes("SignedOutGate"), false);
    assert.equal(embedBranch.includes("FirstRunWizard"), false);

    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(embedSourceMountsLogin(embedChrome), false);
    assert.match(embedChrome, /sessionEmbed/);
    assert.match(embedChrome, /hostDisplay/);
    const embedContract = source("src/lib/session-embed-contract.ts");
    assert.match(embedContract, /ADV-021/);
    assert.equal(LOCAL_LOGIN.missingSessionEmbedStillAdv021, true);
    assert.equal(LOCAL_LOGIN.hostQueryDisplayOnly, true);
  });

  it("clears the password after POST and never persists secrets", () => {
    const submitted = { identifier: "admin-1", password: "hunter2" };
    const cleared = clearLoginPassword(submitted);
    assert.equal(cleared.identifier, "admin-1");
    assert.equal(cleared.password, "");
    assert.equal(loginFormIsSubmittable(cleared), false);
    assert.deepEqual(emptyLoginForm(), { identifier: "", password: "" });
    assert.deepEqual(localLoginBody("  Ada  ", "once"), {
      identifier: "Ada",
      password: "once",
    });

    const chrome = source(LOGIN_CHROME_SOURCE);
    assert.match(chrome, /clearLoginPassword/);
    assert.match(chrome, /loginWithPassword/);
    assert.equal(chrome.includes("localStorage"), false);
    assert.equal(chrome.includes("sessionStorage"), false);
    assert.doesNotMatch(chrome, /password_hash|kek|certPem|privateKey/);
    assert.equal(loginSourceRetainsSecrets(chrome), false);

    const client = source("src/lib/session-client.ts");
    assert.match(client, /loginWithPassword/);
    assert.match(client, /SESSION_LOGIN_PATH/);
    assert.equal(client.includes("localStorage"), false);
    assert.doesNotMatch(client, /searchParams.*password|password=.*\?/);
  });

  it("lands on Overview after success and leaves the workspace switcher unchanged", () => {
    assert.equal(LOGIN_SUCCESS_HREF, "/workflows");
    assert.equal(LOGIN_HREF, "/login");
    const chrome = source(LOGIN_CHROME_SOURCE);
    assert.match(chrome, /LOGIN_SUCCESS_HREF/);
    const landing = source("src/components/session/LoginLanding.tsx");
    assert.match(landing, /LOGIN_SUCCESS_HREF/);
    const switcher = source("src/components/shell/WorkspaceSwitcher.tsx");
    assert.equal(switcher.includes("LoginChrome"), false);
    assert.equal(switcher.includes("loginWithPassword"), false);
    assert.equal(LOCAL_LOGIN.workspaceSwitcherUnchanged, true);
    assert.equal(LOCAL_LOGIN.successLandsOverview, true);
    assert.deepEqual(
      [...LOCAL_LOGIN_SOURCES],
      [
        "src/lib/local-login.ts",
        "src/lib/session-client.ts",
        "src/components/session/LoginChrome.tsx",
        "src/components/session/LoginLanding.tsx",
        "src/components/session/SignedOutGate.tsx",
        "src/components/shell/WorkspaceShell.tsx",
        "src/app/login/page.tsx",
      ],
    );
  });

  it("POSTs identifier + password once to /api/v1/login and stores a non-embed session", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-login",
            idle_expires_at: "2026-09-15T21:00:00.000Z",
            absolute_expires_at: "2026-09-16T07:00:00.000Z",
          },
          principal: {
            issuer: "https://flowforge.local",
            external_subject: "admin-1",
            display_name: "Ada",
          },
          csrf_token: "csrf-login",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await loginWithPassword({
      identifier: "admin-1",
      password: "once-only",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/login");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.credentials, "include");
    const body = String(seen.init?.body);
    assert.match(body, /"identifier":"admin-1"/);
    assert.match(body, /"password":"once-only"/);
    assert.doesNotMatch(body, /password_hash|kek|issuer|external_subject/);
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.session.subject, "admin-1");
    assert.equal(snapshot.embedChrome, null);
    assert.equal(JSON.stringify(snapshot).includes("once-only"), false);
    assert.equal(JSON.stringify(snapshot).includes("password"), false);
  });

  it("uses the same 401 Invalid credentials copy and treats 429 / 503 distinctly", async () => {
    assert.equal(loginFailureMessage(401, "Invalid credentials."), LOGIN_INVALID_CREDENTIALS);
    assert.equal(loginFailureMessage(401, "unknown user"), LOGIN_INVALID_CREDENTIALS);
    assert.equal(loginFailureMessage(429, "slow down"), LOGIN_RATE_LIMITED_MESSAGE);
    assert.equal(loginFailureMessage(503, "store down"), LOGIN_STORE_UNAVAILABLE);
    assert.doesNotMatch(loginFailureMessage(401, "bad password hash"), /hash/);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:unauthenticated",
          title: "Unauthenticated",
          status: 401,
          detail: LOGIN_INVALID_CREDENTIALS,
          instance: "/api/v1/login",
          code: "unauthenticated",
          request_id: "login-401",
        }),
        { status: 401, headers: { "Content-Type": "application/problem+json" } },
      )) as typeof fetch;
    const denied = await loginWithPassword({
      identifier: "missing",
      password: "nope",
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.problem.detail, LOGIN_INVALID_CREDENTIALS);
      assert.doesNotMatch(denied.problem.detail, /unknown|password hash/i);
    }
    assert.equal(getSessionSnapshot().active, false);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:rate-limited",
          title: "Rate Limited",
          status: 429,
          detail: "Login rate limit exceeded.",
          instance: "/api/v1/login",
          code: "rate-limited",
          request_id: "login-429",
        }),
        { status: 429, headers: { "Content-Type": "application/problem+json" } },
      )) as typeof fetch;
    const limited = await loginWithPassword({
      identifier: "admin-1",
      password: "once",
    });
    assert.equal(limited.ok, false);
    if (!limited.ok) {
      assert.equal(limited.statusCode, 429);
      assert.notEqual(
        loginFailureMessage(limited.statusCode, limited.problem.detail),
        LOGIN_INVALID_CREDENTIALS,
      );
    }
  });
});
