import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  B6_EPIC,
  B6_KEEP_STORY_OPEN,
  B6_STORY,
  B7_EPIC,
  B7_KEEP_STORY_OPEN,
  B7_STORY,
  BOOTSTRAP_STEPS,
  BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER,
  BOOTSTRAP_TLS_SKIP_LABEL,
  BOOTSTRAP_TLS_SKIP_SETTINGS_COPY,
  BOOTSTRAP_TLS_SKIP_WARNING,
  DEFAULT_BOOTSTRAP_TLS_ACTION,
  FIRST_RUN_BOOTSTRAP,
  FIRST_RUN_BOOTSTRAP_SOURCES,
  FIRST_RUN_WIZARD_COMPLETE_HREF,
  SETTINGS_BOOTSTRAP_HREF,
  SETTINGS_TLS_HREF,
  SETTINGS_USERS_HANDOFF_HREF,
  bootstrapAdminBody,
  bootstrapProblemMessage,
  bootstrapStatusRetainsSecrets,
  bootstrapStepIsAhead,
  bootstrapTlsSkipBody,
  canOpenBootstrapStep,
  collectForbiddenKeys,
  currentBootstrapStep,
  decideBootstrapChrome,
  emptyBootstrapStatus,
  emptyTlsUploadDraft,
  firstRunBootstrapHoldsHardLines,
  isBootstrapWizardMutation,
  mutationConflictIsComplete,
  normalizePublicBaseUrl,
  parseBootstrapStatus,
  settingsHandoffAfterComplete,
  settingsSourceRemountsWizard,
  shouldExpireStaleWizardCookies,
  shouldFetchBootstrapGate,
  shouldRemountWizard,
  tlsSettingsDescription,
  tlsSkipBodyIsActionOnly,
  tlsStepIsSkipped,
  wizardMutation401IsStaleSession,
  wizardSourceHasPasswordField,
  wizardSourceRetainsSecrets,
  wizardTlsInput,
  WIZARD_STALE_SESSION_HELP,
  type BootstrapStatus,
} from "./first-run-bootstrap.ts";
import {
  confirmBootstrapPersistence,
  createBootstrapAdmin,
  loadBootstrapGate,
  setBootstrapPublicUrl,
  setBootstrapTls,
} from "./first-run-bootstrap-client.ts";
import { emptyDevIdentity } from "./identity-headers.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { clearSession, setActiveSession } from "./session-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const originalFetch = globalThis.fetch;

function source(relative: string): string {
  return readFileSync(join(here, "..", "..", relative), "utf8");
}

function incompleteStatus(
  ready: Partial<Record<(typeof BOOTSTRAP_STEPS)[number], boolean>> = {},
): BootstrapStatus {
  const status = emptyBootstrapStatus();
  for (const step of BOOTSTRAP_STEPS) {
    status.steps[step].ready = Boolean(ready[step]);
  }
  return status;
}

function completeStatus(): BootstrapStatus {
  return {
    complete: true,
    incomplete: false,
    skipped: true,
    standaloneOnly: true,
    steps: {
      persistence: { ready: true },
      firstAdmin: { ready: true },
      publicUrl: { ready: true },
      tls: { ready: false, mode: "local_http" },
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
});

describe("B.6 first-run wizard chrome + Settings handoff", () => {
  it("keeps #339 open and cites epic #333", () => {
    assert.equal(B6_STORY, 339);
    assert.equal(B6_EPIC, 333);
    assert.equal(B6_KEEP_STORY_OPEN, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.noNewApi, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.neverInventSecondGate, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.mutation401ClearsStaleSession, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.mutation401DoesNotSkipWizard, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.wizardPostCsrfExemptAtProxy, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.staleWizardCookiesExpireWithoutHydratedCsrf, true);
    assert.equal(firstRunBootstrapHoldsHardLines(), true);
    assert.ok(FIRST_RUN_BOOTSTRAP_SOURCES.includes("src/components/bootstrap/FirstRunWizard.tsx"));
  });

  it("routes incomplete to the wizard and complete or 401 to home", () => {
    const incomplete = decideBootstrapChrome({
      embed: false,
      statusCode: 200,
      body: incompleteStatus(),
    });
    assert.equal(incomplete.chrome, "wizard");
    assert.equal(incomplete.reason, "incomplete");

    const complete = decideBootstrapChrome({
      embed: false,
      statusCode: 200,
      body: completeStatus(),
    });
    assert.equal(complete.chrome, "home");
    assert.equal(complete.reason, "complete");
    assert.equal(settingsHandoffAfterComplete(complete.status!), true);

    const unauthenticated = decideBootstrapChrome({
      embed: false,
      statusCode: 401,
      body: incompleteStatus(),
    });
    assert.equal(unauthenticated.chrome, "home");
    assert.equal(unauthenticated.reason, "unauthenticated");
    assert.equal(unauthenticated.status, null);
    assert.equal(FIRST_RUN_WIZARD_COMPLETE_HREF, "/workflows");
  });

  it("never mounts the wizard on embed even when the payload is incomplete", () => {
    const embedIncomplete = decideBootstrapChrome({
      embed: true,
      statusCode: 200,
      body: incompleteStatus(),
    });
    assert.equal(embedIncomplete.chrome, "ignore");
    assert.equal(embedIncomplete.reason, "embed");
    assert.equal(shouldFetchBootstrapGate(true), false);
    assert.equal(shouldFetchBootstrapGate(false), true);
    assert.equal(
      shouldRemountWizard({
        embed: true,
        complete: false,
        settingsSurface: false,
      }),
      false,
    );

    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(embedChrome.includes("FirstRunWizard"), false);
    assert.equal(embedChrome.includes("loadBootstrapGate"), false);

    const shell = source("src/components/shell/WorkspaceShell.tsx");
    assert.match(shell, /embed \? \(/);
    assert.match(shell, /<BootstrapGate>/);
    const embedBranch = shell.slice(
      shell.indexOf("const shell = embed ? ("),
      shell.indexOf(") : ("),
    );
    assert.equal(embedBranch.includes("BootstrapGate"), false);
    assert.equal(embedBranch.includes("FirstRunWizard"), false);
    assert.equal(embedBranch.includes("loadBootstrapGate"), false);
  });

  it("fails closed on step order and does not skip ahead", () => {
    const fresh = incompleteStatus();
    assert.equal(currentBootstrapStep(fresh), "persistence");
    assert.equal(canOpenBootstrapStep(fresh, "persistence"), true);
    assert.equal(canOpenBootstrapStep(fresh, "firstAdmin"), false);
    assert.equal(bootstrapStepIsAhead(fresh, "tls"), true);

    const afterPersistence = incompleteStatus({ persistence: true });
    assert.equal(currentBootstrapStep(afterPersistence), "firstAdmin");
    assert.equal(canOpenBootstrapStep(afterPersistence, "publicUrl"), false);

    const afterAdmin = incompleteStatus({
      persistence: true,
      firstAdmin: true,
    });
    assert.equal(currentBootstrapStep(afterAdmin), "publicUrl");

    const afterUrl = incompleteStatus({
      persistence: true,
      firstAdmin: true,
      publicUrl: true,
    });
    assert.equal(currentBootstrapStep(afterUrl), "tls");
    assert.equal(canOpenBootstrapStep(afterUrl, "persistence"), false);

    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    assert.match(wizard, /canOpenBootstrapStep/);
    assert.match(wizard, /bootstrapStepIsAhead/);
    assert.match(wizard, /Confirm persistence/);
    assert.match(wizard, /Create first admin/);
    assert.match(wizard, /Save public URL/);
    assert.match(wizard, /Enable TLS and finish/);
  });

  it("does not retain secrets, passwords, PEMs, or KEK in browser storage", () => {
    const dirty = {
      complete: false,
      incomplete: true,
      skipped: false,
      standaloneOnly: true,
      password: "hunter2",
      publicBaseUrl: "https://secret.example",
      steps: {
        persistence: { ready: false },
        firstAdmin: { ready: false },
        publicUrl: { ready: false },
        tls: { ready: false, certPem: "PEM", keyPem: "KEY", kek: "nope" },
      },
    };
    const stripped = parseBootstrapStatus(dirty);
    assert.ok(stripped);
    assert.equal(bootstrapStatusRetainsSecrets(stripped), false);
    assert.equal(bootstrapStatusRetainsSecrets(dirty), true);
    assert.ok(collectForbiddenKeys(dirty).includes("password"));
    assert.ok(collectForbiddenKeys(dirty).includes("publicBaseUrl"));
    assert.ok(collectForbiddenKeys(dirty).includes("certPem"));

    const parsed = parseBootstrapStatus(incompleteStatus());
    assert.ok(parsed);
    assert.equal(bootstrapStatusRetainsSecrets(parsed), false);
    assert.deepEqual(emptyTlsUploadDraft(), { certPem: "", keyPem: "" });
    assert.deepEqual(bootstrapAdminBody({
      issuer: " https://idp.example ",
      external_subject: " admin-1 ",
      display_name: " Operator ",
    }), {
      issuer: "https://idp.example",
      external_subject: "admin-1",
      display_name: "Operator",
    });

    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    assert.equal(wizardSourceRetainsSecrets(wizard), false);
    assert.equal(wizardSourceHasPasswordField(wizard), false);
    assert.equal(wizard.includes("localStorage"), false);
    assert.equal(wizard.includes("sessionStorage"), false);
    assert.match(wizard, /forgetTlsUploadDraft/);
    assert.match(wizard, /BOOTSTRAP_STEP_HELP.firstAdmin/);
    assert.match(
      source("src/lib/first-run-bootstrap.ts"),
      /optional password may be POSTed once on the API/,
    );
    assert.match(
      source("src/lib/first-run-bootstrap.ts"),
      /create-or-binds workspace admin on localseed `local` \/ `default`/,
    );
    assert.doesNotMatch(wizard, /password\?:/);

    const client = source("src/lib/first-run-bootstrap-client.ts");
    assert.equal(client.includes("localStorage"), false);
    assert.match(client, /bootstrapAdminBody/);
  });

  it("hands off to Settings after complete and does not remount the wizard", () => {
    assert.equal(SETTINGS_BOOTSTRAP_HREF, "/settings#bootstrap");
    assert.equal(SETTINGS_USERS_HANDOFF_HREF, "/membership");
    assert.equal(
      shouldRemountWizard({
        embed: false,
        complete: true,
        settingsSurface: true,
      }),
      false,
    );

    const settingsPage = source("src/app/settings/page.tsx");
    assert.match(settingsPage, /BootstrapSettings/);
    assert.equal(settingsPage.includes("FirstRunWizard"), false);

    const settings = source("src/components/settings/BootstrapSettings.tsx");
    assert.equal(settingsSourceRemountsWizard(settings), false);
    assert.match(settings, /settingsHandoffAfterComplete/);
    assert.match(settings, /SETTINGS_USERS_HANDOFF_HREF/);
    assert.match(settings, /Workspace members/);
    assert.match(settings, /id="persistence"/);
    assert.match(settings, /id="public-url"/);
    assert.match(settings, /id="tls"/);
    assert.match(settings, /The URL is not echoed here/);
    assert.match(settings, /useEmbedMode/);
    assert.match(settings, /if \(embed\) \{/);
  });

  it("surfaces 409 / 403 / 400 / 503 without inventing a second gate", () => {
    assert.match(
      bootstrapProblemMessage(409, {
        detail: "Persistence must be ready before creating the first admin.",
        title: "Conflict",
        code: "conflict",
      }),
      /Persistence must be ready/,
    );
    assert.match(bootstrapProblemMessage(403), /standalone only/);
    assert.match(bootstrapProblemMessage(400), /credentials are never echoed/);
    assert.match(bootstrapProblemMessage(503), /PostgreSQL/);
    assert.equal(bootstrapProblemMessage(401), WIZARD_STALE_SESSION_HELP);
    assert.equal(wizardMutation401IsStaleSession(401, { code: "unauthenticated", status: 401 }), true);
    assert.equal(wizardMutation401IsStaleSession(409, { code: "conflict", status: 409 }), false);
    assert.equal(FIRST_RUN_BOOTSTRAP.mutation401DoesNotSkipWizard, true);
    assert.equal(
      mutationConflictIsComplete(409, {
        detail: "Bootstrap is already complete. TLS is edited in Settings.",
      }),
      true,
    );
    assert.equal(
      mutationConflictIsComplete(409, {
        detail: "First admin must be ready before setting the public URL.",
      }),
      false,
    );

    const blocked = decideBootstrapChrome({
      embed: false,
      statusCode: 503,
      body: incompleteStatus(),
    });
    assert.equal(blocked.chrome, "blocked");
    assert.equal(blocked.reason, "blocked");
  });

  it("accepts origin-only public URLs and rejects userinfo, query, path, and fragments", () => {
    assert.equal(
      normalizePublicBaseUrl("https://flows.example.com/"),
      "https://flows.example.com",
    );
    assert.equal(
      normalizePublicBaseUrl("http://localhost:3000"),
      "http://localhost:3000",
    );
    assert.equal(normalizePublicBaseUrl("https://user:secret@example.com"), null);
    assert.equal(normalizePublicBaseUrl("https://flows.example.com/path"), null);
    assert.equal(normalizePublicBaseUrl("https://flows.example.com?q=1"), null);
    assert.equal(normalizePublicBaseUrl("https://flows.example.com#frag"), null);
    assert.equal(normalizePublicBaseUrl("ftp://flows.example.com"), null);
  });

  it("loads the standalone gate and refuses embed fetches", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(JSON.stringify(incompleteStatus()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const ignored = await loadBootstrapGate({
      embed: true,
      identity: emptyDevIdentity(),
    });
    assert.equal(ignored.ok, true);
    assert.equal(ignored.decision.chrome, "ignore");
    assert.equal(fetched, false);

    const loaded = await loadBootstrapGate({
      embed: false,
      identity: emptyDevIdentity(),
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.decision.chrome, "wizard");
    assert.equal(fetched, true);

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          type: "urn:flowforge:problem:unauthenticated",
          title: "Unauthenticated",
          status: 401,
          detail: "Authentication is required.",
          instance: "/api/v1/bootstrap",
          code: "unauthenticated",
          request_id: "req-401",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    }) as typeof fetch;
    const home = await loadBootstrapGate({
      embed: false,
      identity: emptyDevIdentity(),
    });
    assert.equal(home.ok, false);
    assert.equal(home.decision.chrome, "home");
    assert.equal(home.decision.reason, "unauthenticated");
  });

  it("POSTs wizard mutations through the same-origin proxy and strips secret fields", async () => {
    const seen: { url?: string; body?: string; csrf?: string | null } = {};
    setActiveSession({
      issuer: "https://idp.example",
      subject: "admin-1",
      displayName: "Operator",
      sessionId: "sess-1",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "csrf-wizard",
    });
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      seen.csrf = new Headers(init?.headers).get(CSRF_HEADER);
      const after = incompleteStatus({ persistence: true });
      return new Response(
        JSON.stringify({
          ...after,
          password: "should-strip",
          publicBaseUrl: "https://should-not-echo.example",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const denied = await confirmBootstrapPersistence({ embed: true });
    assert.equal(denied.ok, false);
    assert.equal(denied.statusCode, 403);

    const persistence = await confirmBootstrapPersistence({ embed: false });
    assert.equal(persistence.ok, true);
    assert.ok(persistence.strippedKeys.includes("password"));
    assert.equal("password" in persistence.status, false);
    assert.equal("publicBaseUrl" in persistence.status, false);
    assert.equal(seen.url, "/api/v1/bootstrap/persistence");
    assert.equal(seen.body, JSON.stringify({ confirm: true }));
    assert.equal(seen.csrf, "csrf-wizard");
    assert.equal(seen.body?.includes("DATABASE_URL"), false);

    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      const after = incompleteStatus({ persistence: true, firstAdmin: true });
      return new Response(JSON.stringify(after), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const admin = await createBootstrapAdmin({
      embed: false,
      admin: {
        issuer: "https://idp.example",
        external_subject: "admin-1",
      },
    });
    assert.equal(admin.ok, true);
    assert.equal(seen.url, "/api/v1/bootstrap/admins");
    assert.equal(JSON.parse(seen.body ?? "{}").password, undefined);

    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify(
          incompleteStatus({
            persistence: true,
            firstAdmin: true,
            publicUrl: true,
          }),
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    const url = await setBootstrapPublicUrl({
      embed: false,
      publicBaseUrl: "https://flows.example.com",
    });
    assert.equal(url.ok, true);
    assert.equal(seen.url, "/api/v1/bootstrap/public-url");
    assert.equal(
      (url.ok ? url.status : null)?.steps.publicUrl &&
        "publicBaseUrl" in (url.ok ? url.status : {}),
      false,
    );

    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify(completeStatus()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const tls = await setBootstrapTls({
      embed: false,
      tls: {
        action: "upload",
        certPem: "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----",
        keyPem: "-----BEGIN PRIVATE KEY-----\nB\n-----END PRIVATE KEY-----",
      },
    });
    assert.equal(tls.ok, true);
    assert.equal(seen.url, "/api/v1/bootstrap/tls");
    assert.match(seen.body ?? "", /certPem/);
    assert.equal(tls.ok && bootstrapStatusRetainsSecrets(tls.status), false);

    const skippedStatus: BootstrapStatus = {
      complete: true,
      incomplete: false,
      skipped: false,
      standaloneOnly: true,
      steps: {
        persistence: { ready: true },
        firstAdmin: { ready: true },
        publicUrl: { ready: true },
        tls: { ready: true, mode: "skipped" },
      },
    };
    assert.deepEqual(parseBootstrapStatus(skippedStatus)?.steps.tls, {
      ready: true,
      mode: "skipped",
    });
    globalThis.fetch = (async (input, init) => {
      seen.url = String(input);
      seen.body = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify(skippedStatus), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const skipped = await setBootstrapTls({
      embed: false,
      tls: bootstrapTlsSkipBody(),
    });
    assert.equal(skipped.ok, true);
    assert.equal(seen.url, "/api/v1/bootstrap/tls");
    assert.equal(seen.body, JSON.stringify({ action: "skip" }));
    assert.equal(skipped.ok && skipped.status.steps.tls.mode, "skipped");
    assert.equal(skipped.ok && bootstrapStatusRetainsSecrets(skipped.status), false);
    assert.equal(tlsSkipBodyIsActionOnly(JSON.parse(seen.body ?? "{}")), true);
    assert.equal(seen.body?.includes("certPem"), false);
    assert.equal(seen.body?.includes("keyPem"), false);
  });

  it("retries a wizard mutation 401 without logout CSRF and expires stale cookies at the proxy", async () => {
    let persistenceCalls = 0;
    setActiveSession({
      issuer: "https://idp.example",
      subject: "admin-1",
      displayName: "Operator",
      sessionId: "sess-stale",
      idleExpiresAt: null,
      absoluteExpiresAt: null,
      csrfToken: "csrf-stale",
    });
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/session/logout")) {
        return new Response("logout must not be required", { status: 500 });
      }
      if (url.includes("/bootstrap/persistence")) {
        persistenceCalls += 1;
        if (persistenceCalls === 1) {
          return new Response(
            JSON.stringify({
              type: "urn:flowforge:problem:unauthenticated",
              title: "Unauthenticated",
              status: 401,
              detail: "Authentication is required.",
              instance: "/api/v1/bootstrap/persistence",
              code: "unauthenticated",
              request_id: "req-stale",
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/problem+json" },
            },
          );
        }
        return new Response(JSON.stringify(incompleteStatus({ persistence: true })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await confirmBootstrapPersistence({ embed: false });
    assert.equal(result.ok, true);
    assert.equal(persistenceCalls, 2);
    assert.equal(result.ok && result.status.steps.persistence.ready, true);
    assert.equal(
      decideBootstrapChrome({
        embed: false,
        statusCode: 200,
        body: result.ok ? result.status : null,
      }).chrome,
      "wizard",
    );

    const client = source("src/lib/first-run-bootstrap-client.ts");
    assert.equal(client.includes("endSession"), false);
    assert.match(client, /wizardMutation401IsStaleSession/);
    const forward = source("src/app/api/control-plane/identity-forward.ts");
    assert.match(forward, /headersWithoutSessionCookies/);
    assert.match(forward, /expireSessionCookies/);
    assert.match(forward, /shouldExpireStaleWizardCookies/);
    assert.equal(
      isBootstrapWizardMutation("POST", "/api/v1/bootstrap/persistence"),
      true,
    );
    assert.equal(
      shouldExpireStaleWizardCookies({
        method: "POST",
        path: "/api/control-plane/bootstrap/tls",
        statusCode: 200,
        strippedUnhydratedCookie: true,
      }),
      true,
    );
    assert.equal(
      shouldExpireStaleWizardCookies({
        method: "POST",
        path: "/api/v1/tenants",
        statusCode: 401,
      }),
      false,
    );
    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    assert.doesNotMatch(wizard, /onComplete\(\);\s*\n\s*return;[\s\S]*401/);
    const brief = readFileSync(
      join(here, "../../../../docs/architecture/flowforge-first-run-bootstrap.md"),
      "utf8",
    );
    assert.match(brief, /Wizard POSTs are CSRF-exempt at the proxy/);
    assert.doesNotMatch(
      brief,
      /clear the cookie \(`POST \/session\/logout`\)/,
    );
  });
});

describe("B.7 skip TLS wizard chrome", () => {
  it("keeps #347 open and cites epic #333", () => {
    assert.equal(B7_STORY, 347);
    assert.equal(B7_EPIC, 333);
    assert.equal(B7_KEEP_STORY_OPEN, true);
    assert.equal(B6_STORY, 339);
    assert.equal(B6_KEEP_STORY_OPEN, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.skipTlsPostsActionOnly, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.skipTlsNeverIncludesPem, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.skipTlsIsFirstClassExit, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.skipTlsNotSilentDefault, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.httpUntilTlsInSettings, true);
    assert.equal(FIRST_RUN_BOOTSTRAP.settingsSurfacesSkippedTls, true);
    assert.equal(firstRunBootstrapHoldsHardLines(), true);
    assert.equal(DEFAULT_BOOTSTRAP_TLS_ACTION, "create-self-signed");
  });

  it("offers Skip for now with loud HTTP-until-Settings copy and no silent default", () => {
    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    assert.match(wizard, /Skip for now/);
    assert.match(wizard, /BOOTSTRAP_TLS_SKIP_LABEL/);
    assert.match(wizard, /BOOTSTRAP_TLS_SKIP_WARNING/);
    assert.match(wizard, /DEFAULT_BOOTSTRAP_TLS_ACTION/);
    assert.match(wizard, /data-bootstrap-tls-action="skip"/);
    assert.match(wizard, /data-bootstrap-tls-skip-warning/);
    assert.match(wizard, /Skip for now and finish/);
    assert.match(wizard, /HTTP until Settings/);
    assert.doesNotMatch(wizard, /Steps cannot be skipped\./);
    assert.equal(wizard.includes(BOOTSTRAP_TLS_SKIP_LABEL), true);
    assert.equal(BOOTSTRAP_TLS_SKIP_WARNING.includes("HTTP until you enable TLS in Settings"), true);
    assert.equal(BOOTSTRAP_STEP_HELP_HAS_SKIP(), true);

    assert.equal(canOpenBootstrapStep(incompleteStatus(), "tls"), false);
    const afterUrl = incompleteStatus({
      persistence: true,
      firstAdmin: true,
      publicUrl: true,
    });
    assert.equal(currentBootstrapStep(afterUrl), "tls");
    assert.equal(canOpenBootstrapStep(afterUrl, "tls"), true);
    assert.equal(FIRST_RUN_BOOTSTRAP.skipTlsOnlyWhenPublicUrlReady, true);
  });

  it("POSTs skip as {action:\"skip\"} only and never retains PEM or localStorage secrets", () => {
    const skip = wizardTlsInput("skip", {
      certPem: "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----",
      keyPem: "-----BEGIN PRIVATE KEY-----\nB\n-----END PRIVATE KEY-----",
    });
    assert.deepEqual(skip, { action: "skip" });
    assert.equal(tlsSkipBodyIsActionOnly(skip), true);
    assert.equal(tlsSkipBodyIsActionOnly(bootstrapTlsSkipBody()), true);
    assert.equal("certPem" in (skip ?? {}), false);
    assert.equal("keyPem" in (skip ?? {}), false);
    assert.equal(bootstrapStatusRetainsSecrets(skip), false);

    const wizard = source("src/components/bootstrap/FirstRunWizard.tsx");
    assert.equal(wizardSourceRetainsSecrets(wizard), false);
    assert.equal(wizard.includes("localStorage"), false);
    assert.equal(wizard.includes("sessionStorage"), false);
    assert.match(wizard, /wizardTlsInput/);
    assert.match(wizard, /forgetTlsUploadDraft/);
    assert.match(wizard, /setTlsDraft\(emptyTlsUploadDraft\(\)\)/);

    const client = source("src/lib/first-run-bootstrap-client.ts");
    assert.equal(client.includes("localStorage"), false);
    assert.match(client, /wizardTlsInput/);
    assert.match(client, /action:"skip"/);
  });

  it("surfaces skipped TLS on Settings #bootstrap / #tls and does not remount the wizard", () => {
    const skipped: BootstrapStatus = {
      complete: true,
      incomplete: false,
      skipped: false,
      standaloneOnly: true,
      steps: {
        persistence: { ready: true },
        firstAdmin: { ready: true },
        publicUrl: { ready: true },
        tls: { ready: true, mode: "skipped" },
      },
    };
    assert.equal(tlsStepIsSkipped(skipped.steps.tls), true);
    assert.equal(tlsSettingsDescription(skipped.steps.tls), BOOTSTRAP_TLS_SKIP_SETTINGS_COPY);
    assert.match(BOOTSTRAP_TLS_SKIP_SETTINGS_COPY, /HTTP until you enable TLS here/);
    assert.match(BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER, /TLS was skipped/);
    assert.equal(settingsHandoffAfterComplete(skipped), true);
    assert.equal(
      shouldRemountWizard({
        embed: false,
        complete: true,
        settingsSurface: true,
      }),
      false,
    );
    assert.equal(FIRST_RUN_WIZARD_COMPLETE_HREF, "/workflows");
    assert.equal(SETTINGS_TLS_HREF, "/settings#tls");

    const settings = source("src/components/settings/BootstrapSettings.tsx");
    assert.equal(settingsSourceRemountsWizard(settings), false);
    assert.match(settings, /tlsStepIsSkipped/);
    assert.match(settings, /tlsSettingsDescription/);
    assert.match(settings, /BOOTSTRAP_TLS_SKIP_BOOTSTRAP_BANNER/);
    assert.match(settings, /data-bootstrap-tls-skipped/);
    assert.match(settings, /id="tls"/);
    assert.match(settings, /SETTINGS_TLS_HREF/);
    assert.match(settings, /Enable TLS later/);

    const parsedNullMode = parseBootstrapStatus({
      ...skipped,
      steps: {
        ...skipped.steps,
        tls: { ready: false },
      },
    });
    assert.equal(parsedNullMode?.steps.tls.mode, undefined);
    assert.equal(tlsStepIsSkipped(parsedNullMode!.steps.tls), false);
  });

  it("never mounts skip chrome on embed", () => {
    const embed = decideBootstrapChrome({
      embed: true,
      statusCode: 200,
      body: incompleteStatus({
        persistence: true,
        firstAdmin: true,
        publicUrl: true,
      }),
    });
    assert.equal(embed.chrome, "ignore");
    assert.equal(shouldFetchBootstrapGate(true), false);
    const embedChrome = source("src/components/embed/EmbedChrome.tsx");
    assert.equal(embedChrome.includes("FirstRunWizard"), false);
    assert.equal(embedChrome.includes("Skip for now"), false);
    assert.equal(embedChrome.includes("setBootstrapTls"), false);
  });
});

function BOOTSTRAP_STEP_HELP_HAS_SKIP(): boolean {
  const adapter = source("src/lib/first-run-bootstrap.ts");
  return (
    adapter.includes("Skip for now") &&
    adapter.includes("HTTP until you enable TLS in Settings")
  );
}
