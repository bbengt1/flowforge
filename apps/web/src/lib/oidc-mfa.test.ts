import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchSameOriginProxy } from "./identity-client.ts";
import { resolveIdentityProxyTarget } from "./identity-proxy.ts";
import { LOGIN_INVALID_CREDENTIALS } from "./local-login.ts";
import {
  G21_API_PR,
  G21_ID,
  G21_KEEP_STORY_OPEN,
  G21_STORY,
  MFA_ACCOUNT_PATH,
  MFA_ALREADY_ENROLLED,
  MFA_ENROLL_REQUIRED,
  MFA_NOT_APPLICABLE,
  MFA_NOT_CONFIGURED,
  MFA_PRIVILEGED_LOUD,
  MFA_RATE_LIMITED,
  MFA_REQUIRED_CODE,
  MFA_SETUP_ONCE,
  MFA_VERIFY_REQUIRED,
  OIDC_CALLBACK_PATH,
  OIDC_NOT_CONFIGURED_DETAIL,
  OIDC_RATE_LIMITED,
  OIDC_TEMPORARILY_UNAVAILABLE,
  OIDC_UNAVAILABLE,
  decideMfaChrome,
  isMfaAccountPath,
  isMfaRequiredProblem,
  isOidcCallbackPath,
  isSafeAuthorizationUrl,
  mfaCodeIsSubmittable,
  mfaEnrollBody,
  mfaFailureMessage,
  mfaRequiredKind,
  mfaRequiredMessage,
  mfaVerifyBody,
  noteMfaRequiredProblem,
  oidcCallbackBody,
  oidcCallbackParams,
  oidcFailureMessage,
  oidcIsUnconfigured,
  oidcMfaHoldsHardLines,
  oidcStartBody,
  parseMfaStatus,
  parseOidcStart,
  subscribeMfaRequired,
  takeOtpauthUri,
} from "./oidc-mfa.ts";
import {
  completeOidcCallback,
  completeOidcCallbackOnce,
  enrollMfa,
  resetOidcCallbackFlightForTests,
  startOidcLogin,
  verifyMfa,
} from "./oidc-mfa-client.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, getSessionSnapshot, rememberCsrfToken } from "./session-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
  resetOidcCallbackFlightForTests();
});

describe("G.2.1 OIDC + MFA login chrome", () => {
  it("keeps #446 open and points at API #466", () => {
    assert.equal(G21_STORY, 446);
    assert.equal(G21_API_PR, 466);
    assert.equal(G21_KEEP_STORY_OPEN, true);
    assert.equal(G21_ID, "G.2.1-oidc-mfa-login-chrome");
    assert.equal(oidcMfaHoldsHardLines(), true);
    const contract = source("src/lib/oidc-mfa.ts");
    assert.match(contract, /Keep #446 open/);
    assert.doesNotMatch(contract, /Fixes #446|Closes #446/);
    assert.match(contract, /#466/);
  });

  it("posts an empty OIDC start and redirects only to a safe authorize URL", async () => {
    assert.deepEqual(oidcStartBody(), {});
    assert.equal(
      isSafeAuthorizationUrl(
        "https://idp.example/authorize?response_type=code&code_challenge=abc&code_challenge_method=S256",
      ),
      true,
    );
    assert.equal(
      isSafeAuthorizationUrl("https://idp.example/authorize?code_verifier=secret"),
      false,
    );
    assert.equal(isSafeAuthorizationUrl("javascript:alert(1)"), false);
    assert.equal(
      isSafeAuthorizationUrl("http://idp.example/authorize"),
      false,
    );
    assert.equal(
      isSafeAuthorizationUrl("http://localhost:8080/authorize?state=s"),
      true,
    );
    assert.equal(
      parseOidcStart({
        authorization_url: "https://idp.example/authorize?code_verifier=nope",
        state: "s",
        expires_at: "2026-09-22T22:00:00Z",
      }),
      null,
    );
    assert.equal(
      parseOidcStart({
        authorization_url: "https://idp.example/authorize",
        state: "s",
        expires_at: "2026-09-22T22:00:00Z",
        client_secret: "nope",
      }),
      null,
    );

    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({
          authorization_url: "https://idp.example/authorize?state=abc",
          state: "abc",
          expires_at: "2026-09-22T22:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const started = await startOidcLogin();
    assert.equal(started.ok, true);
    assert.equal(seen.url, "/api/v1/oidc/start");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.credentials, "include");
    assert.equal(String(seen.init?.body), "{}");
    const headers = new Headers(seen.init?.headers);
    assert.equal(headers.get(CSRF_HEADER), null);
    if (started.ok) {
      assert.equal(started.data.state, "abc");
      assert.equal(JSON.stringify(started.data).includes("code_verifier"), false);
    }
  });

  it("maps OIDC 503 / 401 / 429 to fixed copy and disables only when unconfigured", () => {
    assert.equal(oidcIsUnconfigured(503, OIDC_NOT_CONFIGURED_DETAIL), true);
    assert.equal(oidcIsUnconfigured(503, "Identity provider is not available."), false);
    assert.equal(
      oidcFailureMessage(503, OIDC_NOT_CONFIGURED_DETAIL),
      OIDC_UNAVAILABLE,
    );
    assert.equal(
      oidcFailureMessage(503, "OIDC_CLIENT_SECRET missing"),
      OIDC_TEMPORARILY_UNAVAILABLE,
    );
    assert.doesNotMatch(
      oidcFailureMessage(503, "OIDC_CLIENT_SECRET missing"),
      /OIDC_/,
    );
    assert.equal(oidcFailureMessage(401, "bad signature"), LOGIN_INVALID_CREDENTIALS);
    assert.equal(oidcFailureMessage(429, "slow down"), OIDC_RATE_LIMITED);
  });

  it("posts only code and state on the callback and keeps them out of the session", async () => {
    assert.deepEqual(oidcCallbackParams("?code=c1&state=s1&id_token=nope"), {
      code: "c1",
      state: "s1",
    });
    assert.equal(oidcCallbackParams("?state=only"), null);
    assert.deepEqual(oidcCallbackBody(" c1 ", " s1 "), { code: "c1", state: "s1" });
    assert.equal(isOidcCallbackPath("/login/oidc/callback"), true);
    assert.equal(isOidcCallbackPath("/login/oidc/callback/"), true);
    assert.equal(isOidcCallbackPath("/embed/v1/login/oidc/callback"), false);
    assert.equal(OIDC_CALLBACK_PATH, "/login/oidc/callback");
    assert.equal(MFA_ACCOUNT_PATH, "/account/mfa");
    assert.equal(isMfaAccountPath("/account/mfa"), true);
    assert.equal(isMfaAccountPath("/settings"), false);

    const seen: { url?: string; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = String(init?.body);
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-oidc",
            idle_expires_at: "2026-09-22T23:00:00.000Z",
            absolute_expires_at: "2026-09-23T08:00:00.000Z",
            must_change_password: false,
          },
          principal: {
            issuer: "https://idp.example",
            external_subject: "sub-1",
            display_name: "Ada",
          },
          csrf_token: "csrf-oidc",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await completeOidcCallback({ code: "auth-code", state: "state-1" });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "/api/v1/oidc/callback");
    assert.equal(seen.body, JSON.stringify({ code: "auth-code", state: "state-1" }));
    assert.doesNotMatch(seen.body ?? "", /code_verifier|client_secret|id_token/);
    const snapshot = JSON.stringify(getSessionSnapshot());
    assert.match(snapshot, /sub-1/);
    assert.equal(snapshot.includes("auth-code"), false);
    assert.equal(snapshot.includes("state-1"), false);
    assert.equal(getSessionSnapshot().session.mustChangePassword, false);
    assert.equal(getSessionSnapshot().embedChrome, null);

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          session: { id: "sess-2" },
          principal: { issuer: "https://idp.example", external_subject: "sub-2" },
          csrf_token: "csrf-2",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    resetOidcCallbackFlightForTests();
    const first = completeOidcCallbackOnce({ code: "once", state: "st" });
    const second = completeOidcCallbackOnce({ code: "other", state: "st" });
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  });

  it("enrolls and verifies MFA without keeping the setup URI or the code", async () => {
    rememberCsrfToken("csrf-mfa");
    const bodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            method: "totp",
            enrolled: true,
            satisfied: true,
            applicable: true,
            privileged_permissions: ["platform.administer"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(init?.body).includes("654321")) {
        return new Response(
          JSON.stringify({
            method: "totp",
            enrolled: true,
            satisfied: true,
            applicable: true,
            privileged_permissions: ["credential.use"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          method: "totp",
          enrolled: false,
          satisfied: false,
          applicable: true,
          privileged_permissions: ["platform.administer", "credential.view"],
          otpauth_uri: "otpauth://totp/FlowForge:ada?secret=JBSWY3DPEHPK3PXP&issuer=FlowForge",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    assert.deepEqual(mfaEnrollBody(), {});
    assert.deepEqual(mfaVerifyBody(" 654321 "), { code: "654321" });
    assert.equal(mfaCodeIsSubmittable("12345"), false);
    assert.equal(mfaCodeIsSubmittable("otpauth://totp/secret"), false);

    const enrolled = await enrollMfa();
    assert.equal(enrolled.ok, true);
    if (enrolled.ok) {
      assert.match(enrolled.otpauthUri ?? "", /^otpauth:\/\/totp\//);
      assert.equal("otpauth_uri" in enrolled.status, false);
    }
    assert.equal(JSON.stringify(getSessionSnapshot()).includes("JBSWY3DPEHPK3PXP"), false);
    assert.equal(bodies[0], "{}");

    const verified = await verifyMfa("654321");
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.data.satisfied, true);
      assert.equal(JSON.stringify(verified.data).includes("654321"), false);
    }
    assert.equal(JSON.stringify(getSessionSnapshot()).includes("654321"), false);
    assert.equal(JSON.stringify(getSessionSnapshot()).includes("otpauth"), false);

    const rejected = await verifyMfa("not-a-code");
    assert.equal(rejected.ok, false);
  });

  it("does not force MFA when it does not apply, and uses fixed step-up copy", () => {
    assert.equal(
      decideMfaChrome({ embed: true, sessionActive: true, applicable: true }),
      "ignore",
    );
    assert.equal(
      decideMfaChrome({ embed: false, sessionActive: true, applicable: false }),
      "ignore",
    );
    assert.equal(
      decideMfaChrome({ embed: false, sessionActive: false, applicable: true }),
      "ignore",
    );
    assert.equal(
      decideMfaChrome({ embed: false, sessionActive: true, applicable: true }),
      "mfa",
    );
    assert.equal(MFA_NOT_APPLICABLE.includes("does not apply"), true);
    assert.equal(mfaRequiredKind(MFA_ENROLL_REQUIRED), "enroll");
    assert.equal(mfaRequiredKind(MFA_VERIFY_REQUIRED), "verify");
    assert.equal(mfaRequiredKind("otpauth://totp/leak"), "unknown");
    assert.equal(mfaRequiredMessage(MFA_ENROLL_REQUIRED), MFA_ENROLL_REQUIRED);
    assert.equal(mfaRequiredMessage("secret=ABC otpauth://totp/x"), MFA_PRIVILEGED_LOUD);
    assert.doesNotMatch(mfaRequiredMessage("secret=ABC"), /secret/);
    assert.equal(mfaFailureMessage(401, "bad code 000000"), LOGIN_INVALID_CREDENTIALS);
    assert.equal(mfaFailureMessage(409, MFA_ALREADY_ENROLLED), MFA_ALREADY_ENROLLED);
    assert.equal(mfaFailureMessage(429, "slow"), MFA_RATE_LIMITED);
    assert.equal(mfaFailureMessage(503, "MFA_SECRET_KEY"), MFA_NOT_CONFIGURED);
    assert.doesNotMatch(mfaFailureMessage(503, "MFA_SECRET_KEY"), /MFA_SECRET_KEY/);
    assert.equal(
      takeOtpauthUri({ otpauth_uri: "javascript:alert(1)" }),
      null,
    );
    assert.equal(
      takeOtpauthUri({
        otpauth_uri: "otpauth://totp/FlowForge:ada?secret=JBSWY3DPEHPK3PXP&issuer=FlowForge",
      }),
      "otpauth://totp/FlowForge:ada?secret=JBSWY3DPEHPK3PXP&issuer=FlowForge",
    );
    const parsed = parseMfaStatus({
      method: "totp",
      enrolled: false,
      satisfied: true,
      applicable: false,
      privileged_permissions: ["credential.manage"],
      otpauth_uri: "otpauth://totp/FlowForge:ada?secret=LEAK",
    });
    assert.equal(parsed?.applicable, false);
    assert.equal(JSON.stringify(parsed).includes("otpauth"), false);
    assert.equal(
      isMfaRequiredProblem({ code: MFA_REQUIRED_CODE, status: 403 }),
      true,
    );
  });

  it("publishes mfa-required from the session client without echoing secrets", async () => {
    const seen: string[] = [];
    const stop = subscribeMfaRequired((notice) => {
      seen.push(`${notice.kind}:${notice.message}`);
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:mfa-required",
          title: "MFA Required",
          status: 403,
          detail: "otpauth://totp/FlowForge:ada?secret=LEAKED",
          instance: "/api/v1/credentials",
          code: MFA_REQUIRED_CODE,
          request_id: "mfa-403",
        }),
        { status: 403, headers: { "Content-Type": "application/problem+json" } },
      )) as typeof fetch;
    const denied = await fetchSameOriginProxy({
      instance: "/api/v1/credentials",
      method: "POST",
      headers: { Accept: "application/problem+json" },
      body: "{}",
      requestId: "mfa-403",
    });
    assert.equal(denied.ok, false);
    assert.deepEqual(seen, [`unknown:${MFA_PRIVILEGED_LOUD}`]);
    assert.equal(seen.join("").includes("LEAKED"), false);

    seen.length = 0;
    noteMfaRequiredProblem("/api/v1/session/mfa/enroll", {
      type: "urn:flowforge:problem:mfa-required",
      title: "MFA Required",
      status: 403,
      detail: MFA_ENROLL_REQUIRED,
      instance: "/api/v1/session/mfa/enroll",
      code: MFA_REQUIRED_CODE,
      request_id: "self",
    });
    assert.deepEqual(seen, []);
    stop();
  });

  it("allowlists the OIDC and MFA proxy routes and keeps callback reachable signed-out", () => {
    for (const [method, segments, path] of [
      ["POST", ["oidc", "start"], "/api/v1/oidc/start"],
      ["POST", ["oidc", "callback"], "/api/v1/oidc/callback"],
      ["GET", ["session", "mfa"], "/api/v1/session/mfa"],
      ["POST", ["session", "mfa", "enroll"], "/api/v1/session/mfa/enroll"],
      ["POST", ["session", "mfa", "verify"], "/api/v1/session/mfa/verify"],
    ] as const) {
      const target = resolveIdentityProxyTarget(method, [...segments]);
      assert.equal("apiPath" in target, true);
      if ("apiPath" in target) {
        assert.equal(target.apiPath, path);
      }
    }
    const postStatus = resolveIdentityProxyTarget("POST", ["session", "mfa"]);
    assert.equal("status" in postStatus && postStatus.status, 405);

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    const callbackIdx = shell.indexOf("if (!embed && isOidcCallbackPath");
    const signedOutIdx = shell.indexOf("<SignedOutGate>");
    assert.ok(callbackIdx >= 0 && signedOutIdx > callbackIdx);
    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(embedBranch.includes("MfaStepUpHost"), false);
    assert.equal(embedBranch.includes("MfaChrome"), false);
    assert.equal(embedBranch.includes("OidcCallbackChrome"), false);
    assert.equal(embedBranch.includes("LoginChrome"), false);
    assert.match(shell, /<MfaStepUpHost \/>/);

    const callback = source("src/components/session/OidcCallbackChrome.tsx");
    assert.match(callback, /if \(embed\)/);
    assert.match(callback, /return null/);
    assert.ok(
      callback.indexOf("if (embed)") < callback.indexOf("completeOidcCallbackOnce("),
    );
    assert.match(callback, /history\.replaceState/);
    assert.match(callback, /afterLocalLoginHref/);
    assert.match(callback, /mustChangePassword/);
    assert.equal(callback.includes("localStorage"), false);
    assert.equal(callback.includes("sessionStorage"), false);

    const login = source("src/components/session/LoginChrome.tsx");
    assert.match(login, /type="password"/);
    assert.match(login, /Sign in with SSO/);
    assert.match(login, /oidcIsUnconfigured/);
    assert.equal(login.includes("localStorage"), false);
    assert.equal(login.includes("code_verifier"), false);

    const mfa = source("src/components/session/MfaChrome.tsx");
    assert.match(mfa, /if \(embed\)/);
    assert.match(mfa, /return null/);
    assert.match(mfa, /MFA_SETUP_ONCE/);
    assert.equal(mfa.includes("localStorage"), false);
    assert.equal(mfa.includes("sessionStorage"), false);
    assert.match(source("src/components/session/MfaAccountPanel.tsx"), /if \(embed\)/);
    assert.match(source("src/components/session/MfaStepUpHost.tsx"), /if \(embed\)/);
    assert.match(source("src/app/settings/page.tsx"), /MfaAccountPanel/);
    assert.match(source("src/app/login/oidc/callback/page.tsx"), /OidcCallbackChrome/);
    assert.match(source("src/app/account/mfa/page.tsx"), /MfaAccountPanel/);
    assert.match(source("src/lib/oidc-mfa-client.ts"), /ff_oidc_state/);
    assert.doesNotMatch(source("src/lib/oidc-mfa-client.ts"), /document\.cookie/);
    assert.equal(MFA_SETUP_ONCE.includes("does not store"), true);
  });
});
