import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHANGE_PASSWORD,
  CHANGE_PASSWORD_API_PR,
  CHANGE_PASSWORD_CHROME_SOURCE,
  CHANGE_PASSWORD_EMPTY,
  CHANGE_PASSWORD_EMBED_FORBIDDEN,
  CHANGE_PASSWORD_FAILED,
  CHANGE_PASSWORD_HREF,
  CHANGE_PASSWORD_ID,
  CHANGE_PASSWORD_MIN_LENGTH,
  CHANGE_PASSWORD_MISMATCH,
  CHANGE_PASSWORD_ONE_TIME_REUSE,
  CHANGE_PASSWORD_SOURCES,
  CHANGE_PASSWORD_STORY,
  CHANGE_PASSWORD_SUCCESS_HREF,
  CHANGE_PASSWORD_TOO_SHORT,
  CHANGE_PASSWORD_UNAUTHENTICATED,
  CHANGE_PASSWORD_UNAVAILABLE,
  MUST_CHANGE_GATE_SOURCE,
  ONE_TIME_BOOTSTRAP_PASSWORD,
  afterLocalLoginHref,
  changePasswordClientError,
  changePasswordFailureMessage,
  changePasswordFormIsSubmittable,
  changePasswordHoldsHardLines,
  changePasswordSourceConsumesV1Tokens,
  changePasswordSourceHasBypass,
  changePasswordSourceRetainsSecrets,
  clearChangePasswordForm,
  decideMustChangeChrome,
  embedSourceMountsChangePassword,
  emptyChangePasswordForm,
  isChangePasswordPath,
  mustChangePasswordBlocksProduct,
} from "./change-password.ts";
import { LOGIN_SUCCESS_HREF } from "./local-login.ts";
import { changeLocalPassword } from "./session-client.ts";
import { clearSession, getSessionSnapshot, setActiveSession } from "./session-store.ts";
import type { BrowserSession } from "./session.ts";
import { FF_ACCENT, FF_CANVAS } from "./visual-tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

/** Test-local rotated secret. Not a room-visible smoke password. */
const FIXTURE_ROTATED = "correct-horse";

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function frontendUi(): string {
  return readFileSync(
    join(here, "..", "..", "..", "..", "docs/reference/frontend-ui.md"),
    "utf8",
  );
}

const active: BrowserSession = {
  issuer: "local",
  subject: "admin",
  displayName: "Admin",
  sessionId: "sess-1",
  idleExpiresAt: "2026-09-15T21:00:00.000Z",
  absoluteExpiresAt: "2026-09-16T07:00:00.000Z",
  csrfToken: "csrf-ok",
  mustChangePassword: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("#376 Change-password chrome", () => {
  it("cites #376 chrome on the shipped #377 API and holds hard lines", () => {
    assert.equal(CHANGE_PASSWORD_STORY, 376);
    assert.equal(CHANGE_PASSWORD_API_PR, 377);
    assert.equal(CHANGE_PASSWORD_ID, "change-password-chrome-must-change-gate");
    assert.equal(CHANGE_PASSWORD.apiAlreadyOnMain, true);
    assert.equal(CHANGE_PASSWORD.incompleteWizardWins, true);
    assert.equal(CHANGE_PASSWORD.embedNeverMountsDoor, true);
    assert.equal(changePasswordHoldsHardLines(), true);
    assert.equal(CHANGE_PASSWORD_HREF, "/change-password");
    assert.equal(CHANGE_PASSWORD_SUCCESS_HREF, "/workflows");
    assert.equal(CHANGE_PASSWORD_SUCCESS_HREF, LOGIN_SUCCESS_HREF);
    assert.match(frontendUi(), /#376/);
    assert.match(frontendUi(), /change-password/);
    assert.match(frontendUi(), /must_change_password/);
    assert.deepEqual(
      [...CHANGE_PASSWORD_SOURCES],
      [
        "src/lib/change-password.ts",
        "src/lib/session-client.ts",
        "src/components/session/ChangePasswordChrome.tsx",
        "src/components/session/ChangePasswordLanding.tsx",
        "src/components/session/MustChangePasswordGate.tsx",
        "src/components/session/LoginChrome.tsx",
        "src/components/session/LoginLanding.tsx",
        "src/components/session/SignedOutGate.tsx",
        "src/components/shell/WorkspaceShell.tsx",
        "src/app/change-password/page.tsx",
      ],
    );
  });

  it("is full-dark change-password chrome: masked pair, one submit, no skip", () => {
    const chrome = source(CHANGE_PASSWORD_CHROME_SOURCE);
    assert.match(chrome, /Change password/);
    assert.match(chrome, /New password/);
    assert.match(chrome, /Confirm password/);
    assert.match(chrome, /one-time bootstrap/);
    assert.match(chrome, /cannot be skipped/);
    assert.equal((chrome.match(/type="password"/g) ?? []).length, 2);
    assert.match(chrome, /changeLocalPassword/);
    assert.match(chrome, /clearChangePasswordForm/);
    assert.match(chrome, /CHANGE_PASSWORD_SUCCESS_HREF/);
    assert.equal(changePasswordSourceHasBypass(chrome), false);
    assert.equal(changePasswordSourceConsumesV1Tokens(chrome), true);
    assert.match(chrome, /--ff-canvas/);
    assert.match(chrome, /--ff-accent/);
    assert.equal(FF_CANVAS, "#0f1218");
    assert.equal(FF_ACCENT, "#0f766e");
    assert.equal(chrome.includes("localStorage"), false);
    assert.equal(chrome.includes("sessionStorage"), false);
    assert.equal(changePasswordSourceRetainsSecrets(chrome), false);
    assert.doesNotMatch(chrome, /password_hash|kek|certPem|privateKey/);
    assert.doesNotMatch(chrome, /Establish session/);
    assert.doesNotMatch(chrome, /trusted-dev/);
    assert.doesNotMatch(chrome, /SSO|OIDC/i);
    assert.doesNotMatch(chrome, new RegExp(`value=["']${ONE_TIME_BOOTSTRAP_PASSWORD}["']`));
  });

  it("rejects empty, mismatch, and one-time reuse before POST", () => {
    assert.deepEqual(emptyChangePasswordForm(), { password: "", confirm: "" });
    assert.deepEqual(clearChangePasswordForm(), { password: "", confirm: "" });
    assert.equal(changePasswordFormIsSubmittable(emptyChangePasswordForm()), false);
    assert.equal(
      changePasswordFormIsSubmittable({ password: FIXTURE_ROTATED, confirm: "" }),
      false,
    );
    assert.equal(
      changePasswordClientError({ password: "", confirm: "" }),
      CHANGE_PASSWORD_EMPTY,
    );
    assert.equal(
      changePasswordClientError({ password: FIXTURE_ROTATED, confirm: "other-horse" }),
      CHANGE_PASSWORD_MISMATCH,
    );
    assert.equal(
      changePasswordClientError({
        password: ONE_TIME_BOOTSTRAP_PASSWORD,
        confirm: ONE_TIME_BOOTSTRAP_PASSWORD,
      }),
      CHANGE_PASSWORD_ONE_TIME_REUSE,
    );
    assert.equal(CHANGE_PASSWORD_MIN_LENGTH, 8);
    assert.equal(
      changePasswordClientError({ password: "shortpw", confirm: "shortpw" }),
      CHANGE_PASSWORD_TOO_SHORT,
    );
    assert.equal(
      changePasswordClientError({ password: FIXTURE_ROTATED, confirm: FIXTURE_ROTATED }),
      null,
    );
  });

  it("honors server 4xx copy without echoing secrets", () => {
    assert.equal(
      changePasswordFailureMessage(401, "anything"),
      CHANGE_PASSWORD_UNAUTHENTICATED,
    );
    assert.equal(
      changePasswordFailureMessage(403, "Embed sessions cannot change a local password."),
      CHANGE_PASSWORD_EMBED_FORBIDDEN,
    );
    assert.equal(
      changePasswordFailureMessage(503, "store down"),
      CHANGE_PASSWORD_UNAVAILABLE,
    );
    assert.equal(
      changePasswordFailureMessage(
        400,
        "Choose a new password that is not the one-time default and is not the current password.",
      ),
      "Choose a new password that is not the one-time default and is not the current password.",
    );
    assert.equal(
      changePasswordFailureMessage(400, "Password does not meet the required length."),
      CHANGE_PASSWORD_TOO_SHORT,
    );
    assert.equal(
      changePasswordFailureMessage(400, "bcrypt password_hash leaked"),
      CHANGE_PASSWORD_FAILED,
    );
    assert.doesNotMatch(
      changePasswordFailureMessage(400, "bad password hash"),
      /hash/,
    );
  });

  it("gates product chrome when must_change_password is true and fail-closes deep links", () => {
    const forced = decideMustChangeChrome({
      embed: false,
      sessionActive: true,
      mustChangePassword: true,
    });
    assert.equal(forced.chrome, "change-password");
    assert.equal(forced.reason, "must-change");
    assert.equal(
      mustChangePasswordBlocksProduct({
        embed: false,
        sessionActive: true,
        mustChangePassword: true,
      }),
      true,
    );
    assert.equal(isChangePasswordPath("/workflows"), false);
    assert.equal(isChangePasswordPath("/settings"), false);
    assert.equal(isChangePasswordPath("/change-password"), true);
    assert.equal(isChangePasswordPath("/change-password?x=1"), true);

    const signedIn = decideMustChangeChrome({
      embed: false,
      sessionActive: true,
      mustChangePassword: false,
    });
    assert.equal(signedIn.chrome, "home");
    assert.equal(signedIn.reason, "session");
    assert.equal(
      mustChangePasswordBlocksProduct({
        embed: false,
        sessionActive: true,
        mustChangePassword: false,
      }),
      false,
    );

    const signedOut = decideMustChangeChrome({
      embed: false,
      sessionActive: false,
      mustChangePassword: true,
    });
    assert.equal(signedOut.chrome, "ignore");
    assert.equal(signedOut.reason, "signed-out");

    const gate = source(MUST_CHANGE_GATE_SOURCE);
    assert.match(gate, /ChangePasswordChrome/);
    assert.match(gate, /router\.replace/);
    assert.match(gate, /CHANGE_PASSWORD_HREF/);
    assert.match(gate, /decideMustChangeChrome/);
  });

  it("sends Login success to Change-password when the session flag is set", () => {
    assert.equal(afterLocalLoginHref(true), CHANGE_PASSWORD_HREF);
    assert.equal(afterLocalLoginHref(false), LOGIN_SUCCESS_HREF);
    const chrome = source("src/components/session/LoginChrome.tsx");
    assert.match(chrome, /afterLocalLoginHref/);
    assert.match(chrome, /LOGIN_SUCCESS_HREF/);
    assert.match(chrome, /mustChangePassword/);
    const landing = source("src/components/session/LoginLanding.tsx");
    assert.match(landing, /afterLocalLoginHref/);
    assert.match(landing, /LOGIN_SUCCESS_HREF/);
    const successLanding = source("src/components/session/ChangePasswordLanding.tsx");
    assert.match(successLanding, /CHANGE_PASSWORD_SUCCESS_HREF/);
    assert.match(successLanding, /mustChangePassword/);
  });

  it("mounts the gate after the wizard and signed-out doors, never on embed", () => {
    const embed = decideMustChangeChrome({
      embed: true,
      sessionActive: true,
      mustChangePassword: true,
    });
    assert.equal(embed.chrome, "ignore");
    assert.equal(embed.reason, "embed");
    assert.equal(
      mustChangePasswordBlocksProduct({
        embed: true,
        sessionActive: true,
        mustChangePassword: true,
      }),
      false,
    );

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.match(shell, /<BootstrapGate>/);
    assert.match(shell, /<SignedOutGate>/);
    assert.match(shell, /<MustChangePasswordGate>/);
    const standalone = shell.slice(shell.indexOf(") : ("));
    const bootstrapIdx = standalone.indexOf("BootstrapGate");
    const signedOutIdx = standalone.indexOf("SignedOutGate");
    const mustChangeIdx = standalone.indexOf("MustChangePasswordGate");
    assert.ok(bootstrapIdx >= 0 && signedOutIdx > bootstrapIdx);
    assert.ok(mustChangeIdx > signedOutIdx);

    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(embedSourceMountsChangePassword(embedBranch), false);
    assert.equal(embedBranch.includes("ChangePasswordChrome"), false);
    assert.equal(embedBranch.includes("MustChangePasswordGate"), false);

    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(embedSourceMountsChangePassword(embedChrome), false);
    const embedGate = source("src/components/embed/EmbedExchangeGate.tsx");
    assert.equal(embedSourceMountsChangePassword(embedGate), false);
    assert.equal(CHANGE_PASSWORD.incompleteWizardWins, true);
    assert.equal(CHANGE_PASSWORD.trustedDevStaysSeparate, true);
  });

  it("POSTs the new password once and lands Overview after the flag clears", async () => {
    setActiveSession(active);
    const seen: { url?: string; method?: string; body?: string } = {};
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.method = init?.method;
      seen.body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          session: {
            id: "sess-1",
            must_change_password: false,
          },
          principal: {
            issuer: "local",
            external_subject: "admin",
          },
          csrf_token: "csrf-ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await changeLocalPassword(FIXTURE_ROTATED);
    assert.equal(result.ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/v1/session/password");
    assert.equal(seen.body, JSON.stringify({ password: FIXTURE_ROTATED }));
    const snapshot = getSessionSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.session.mustChangePassword, false);
    assert.equal(JSON.stringify(snapshot).includes(FIXTURE_ROTATED), false);
    assert.equal(afterLocalLoginHref(snapshot.session.mustChangePassword), "/workflows");
    const client = source("src/lib/session-client.ts");
    assert.match(client, /changeLocalPassword/);
    assert.match(client, /SESSION_PASSWORD_PATH/);
    assert.equal(client.includes("localStorage"), false);
    assert.doesNotMatch(client, /searchParams.*password|password=.*\?/);
  });
});
