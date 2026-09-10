import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMBED_ALGORITHM,
  EMBED_API_PREFIX,
  EMBED_AUDIENCE,
  EMBED_CLAIM_NAMES,
  EMBED_DEFAULT_TTL_SECONDS,
  EMBED_MAX_OVERLAP_TTL_SECONDS,
  EMBED_EXCHANGE_PATH,
  EMBED_MINT_PATH,
  EMBED_MOUNT_PREFIX,
  EMBED_REQUIRED_CLAIMS,
  EMBED_ROUTES,
  EMBED_CATALOG_MEMBERSHIP_ISOLATION,
  EMBED_CATALOG_MEMBERSHIP_ISOLATION_HELP,
  EMBED_CATALOG_MEMBERSHIP_ISOLATION_RULES,
  catalogRoutesForGrant,
  grantsMembershipIsolationCatalog,
  parseCatalogMembershipIsolationGranted,
  EMBED_SDK,
  EMBED_API_PR,
  EMBED_EPIC,
  EMBED_MOUNT_HEADER,
  EMBED_REJECTED_ASSERTION_HEADER,
  EMBED_ROUTE_MAP_SOURCE,
  EMBED_STORY,
  EMBED_VALIDATION_STORY,
  EMBED_ROTATE_HELP,
  EMBED_ROTATE_PATH,
  EMBED_TENANCY_RULES,
  EMBED_VERIFY_RULES,
  EMBED_HOST_ISSUER_RULES,
  EMBED_HOST_ISSUER_HELP,
  EMBED_HOST_CONTEXT_EMBED,
  EMBED_HOST_CONTEXT_PORTAL,
  FLOWFORGE_HOST_CONTEXT_HEADER,
  FLOWFORGE_HOST_ISSUER_HEADER,
  detectEmbedHostContext,
  embedHostBindingHeaders,
  peekAssertionHostIssuer,
  readConfiguredHostIssuers,
  resolveConfiguredHostIssuer,
  resolveEmbedHostBinding,
  EMBED_JTI_RULES,
  EMBED_RATE_LIMIT_RULES,
  EMBED_RATE_LIMITED_MESSAGE,
  EMBED_CHIPS_RULES,
  EMBED_CHIPS_SET_COOKIE,
  EMBED_COOKIE_CREDENTIALS,
  EMBED_COOKIE_REQUIREMENTS,
  EMBED_CSRF_COOKIE,
  EMBED_SESSION_COOKIE,
  EMBED_STORAGE_ACCESS_API,
  TOPLEVEL_CSRF_COOKIE,
  TOPLEVEL_SESSION_COOKIE,
  assertionFromURL,
  embedHeadersMatchSession,
  embedWorkspaceHeaders,
  hostTenantIsAuthorization,
  parseSessionEmbedBinding,
  parseEmbedChromeFromSession,
  isEmbedBoundSession,
  EMBED_CHROME_FROM_SESSION,
  EMBED_CHROME_FROM_SESSION_RULES,
  EMBED_CHROME_FROM_SESSION_HELP,
  EMBED_CHROME_MISSING_SESSION_MESSAGE,
  buildEmbedExchangeBody,
  embedApiPath,
  embedAuthFailureMessage,
  embedMountPath,
  EMBED_HOST_ALLOWLIST_HELP,
  EMBED_HOST_ALLOWLIST_RULES,
  embedHostAllowlist,
  embedPostMessageAllowlist,
  forgetEmbedAssertion,
  frameAncestorsForPath,
  isAllowedEmbedMessageOrigin,
  parseCatalogFrameAncestors,
  parseCatalogIssuers,
  exchangeHostBindingFromGate,
  isCompactJws,
  isEmbedMountPath,
  isEmbedUiPath,
  parseEmbedAssertionMessage,
  parseEmbedExchangePayload,
  parseEmbedFrameAncestors,
  parseEmbedHostDisplay,
  publicJwksOnly,
  standalonePathFromEmbed,
  stripAssertionParams,
  urlRejectedAssertion,
  validateEmbedAssertion,
} from "./embed-contract.ts";
import { csrfRequiredFor } from "./session-contract.ts";

describe("embed-contract", () => {
  it("matches the E11.1 SDK, audience, and API paths", () => {
    assert.equal(EMBED_SDK, "embed.v1");
    assert.equal(EMBED_AUDIENCE, "flowforge");
    assert.equal(EMBED_ALGORITHM, "EdDSA");
    assert.equal(embedApiPath(EMBED_MINT_PATH), "/api/v1/embed/assertions");
    assert.equal(embedApiPath(EMBED_EXCHANGE_PATH), "/api/v1/embed/exchange");
    assert.equal(embedApiPath(EMBED_ROTATE_PATH), "/api/v1/embed/keys/rotate");
    assert.equal(EMBED_API_PREFIX, "/api/v1");
    assert.equal(EMBED_DEFAULT_TTL_SECONDS, 60);
    assert.equal(EMBED_MAX_OVERLAP_TTL_SECONDS, 4 * 60 * 60);
    assert.match(EMBED_ROTATE_HELP, /overlapUntil is required/);
    assert.match(EMBED_ROTATE_HELP, /max 4h/);
    assert.ok(EMBED_REQUIRED_CLAIMS.includes("jti"));
    assert.ok(EMBED_REQUIRED_CLAIMS.includes("aud"));
    assert.ok(EMBED_CLAIM_NAMES.includes("workspace_id"));
    assert.ok(EMBED_CLAIM_NAMES.includes("ctx"));
  });

  it("maps standalone deep links onto /embed/v1 without changing the href", () => {
    assert.equal(embedMountPath("/"), "/embed/v1");
    assert.equal(embedMountPath("/workflows/{id}"), "/embed/v1/workflows/{id}");
    assert.equal(standalonePathFromEmbed("/embed/v1/executions/abc"), "/executions/abc");
    assert.equal(isEmbedMountPath("/embed/v1/workflows"), true);
    assert.equal(isEmbedMountPath("/workflows"), false);
    const workflow = EMBED_ROUTES.find((r) => r.id === "workflow");
    assert.equal(workflow?.standalone, "/workflows/{id}");
    assert.equal(workflow?.embed, `${EMBED_MOUNT_PREFIX}/workflows/{id}`);
  });

  it("hides membership/isolation catalog routes unless granted", () => {
    assert.equal(grantsMembershipIsolationCatalog(null), false);
    assert.equal(grantsMembershipIsolationCatalog(["workflow.view"]), false);
    assert.equal(
      grantsMembershipIsolationCatalog(["workspace.administer"]),
      true,
    );
    assert.equal(
      parseCatalogMembershipIsolationGranted({
        rules: { membershipIsolationGranted: false },
      }),
      false,
    );
    assert.equal(
      parseCatalogMembershipIsolationGranted({
        rules: { membershipIsolationGranted: true },
      }),
      true,
    );
    const publicRoutes = catalogRoutesForGrant(false).map((r) => r.id);
    assert.equal(publicRoutes.includes("membership"), false);
    assert.equal(publicRoutes.includes("isolation"), false);
    assert.ok(publicRoutes.includes("settings"));
    const granted = catalogRoutesForGrant(true).map((r) => r.id);
    assert.ok(granted.includes("membership"));
    assert.ok(granted.includes("isolation"));
    assert.equal(
      EMBED_CATALOG_MEMBERSHIP_ISOLATION.grantedField,
      "rules.membershipIsolationGranted",
    );
    assert.equal(
      EMBED_CATALOG_MEMBERSHIP_ISOLATION.frameAncestorsAlwaysPublished,
      true,
    );
    assert.equal(
      EMBED_CATALOG_MEMBERSHIP_ISOLATION_RULES.failClosedWithoutGrant,
      true,
    );
    assert.match(EMBED_CATALOG_MEMBERSHIP_ISOLATION_HELP, /workspace.administer/);
  });

  it("never reads an assertion from a URL and strips leaked query keys", () => {
    assert.equal(assertionFromURL("/embed/v1?assertion=eyJ"), null);
    const stripped = stripAssertionParams("?assertion=eyJ&tab=run");
    assert.equal(stripped.rejected, true);
    assert.equal(stripped.clean, "?tab=run");
  });

  it("exempts POST /embed/exchange from CSRF (no session yet)", () => {
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/exchange"), false);
    assert.equal(csrfRequiredFor("POST", "/api/control-plane/embed/exchange"), false);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/assertions"), true);
    assert.equal(csrfRequiredFor("POST", "/api/v1/embed/keys/rotate"), true);
  });

  it("keeps standalone frame-ancestors none and allowlists only embed mounts", () => {
    assert.deepEqual(parseEmbedFrameAncestors("* https://portal.example"), [
      "https://portal.example",
    ]);
    assert.deepEqual(parseEmbedFrameAncestors("'self' https://portal.example"), [
      "'self'",
      "https://portal.example",
    ]);
    assert.equal(frameAncestorsForPath("/workflows", { WEB_EMBED_FRAME_ANCESTORS: "https://portal.example" }), "'none'");
    assert.equal(
      frameAncestorsForPath("/embed/v1/workflows", {
        WEB_EMBED_FRAME_ANCESTORS: "https://portal.example",
      }),
      "https://portal.example",
    );
    assert.equal(frameAncestorsForPath("/embed/v1", {}), "'none'");
  });

  it("uses one host allowlist for CSP frame-ancestors and postMessage", () => {
    const env = {
      WEB_EMBED_FRAME_ANCESTORS: "https://host.example *",
      WEB_PORTAL_FRAME_ANCESTORS: "https://portal.example null",
      PORTAL_FRAME_ANCESTORS: "'self'",
      NEXT_PUBLIC_EMBED_FRAME_ANCESTORS: "https://drift.example",
    };
    const allow = embedHostAllowlist(env);
    assert.deepEqual(allow, [
      "https://host.example",
      "https://portal.example",
      "'self'",
    ]);
    assert.deepEqual(embedPostMessageAllowlist(env), allow);
    assert.equal(
      frameAncestorsForPath("/embed/v1/workflows", env),
      allow.join(" "),
    );
    assert.equal(frameAncestorsForPath("/embed/v1", {}), "'none'");
    assert.deepEqual(embedHostAllowlist({}), []);
    assert.deepEqual(embedPostMessageAllowlist({}), []);
    assert.equal(EMBED_HOST_ALLOWLIST_RULES.sharedList, true);
    assert.equal(EMBED_HOST_ALLOWLIST_RULES.emptyFailsClosed, true);
    assert.equal(EMBED_HOST_ALLOWLIST_RULES.nextPublicIsNotASource, true);
    assert.equal(EMBED_HOST_ALLOWLIST_RULES.catalogField, "frameAncestors");
    assert.match(EMBED_HOST_ALLOWLIST_HELP, /GET \/embed\/catalog/);
  });

  it("rejects postMessage origins that are not on the shared list", () => {
    const allow = embedPostMessageAllowlist({
      WEB_EMBED_FRAME_ANCESTORS: "https://portal.example",
    });
    assert.equal(
      isAllowedEmbedMessageOrigin("https://portal.example", allow),
      true,
    );
    assert.equal(
      isAllowedEmbedMessageOrigin("https://evil.example", allow),
      false,
    );
    assert.equal(isAllowedEmbedMessageOrigin("https://portal.example", []), false);
    assert.equal(isAllowedEmbedMessageOrigin("null", allow), false);
    assert.equal(isAllowedEmbedMessageOrigin("*", allow), false);
    assert.equal(
      isAllowedEmbedMessageOrigin("https://app.example", ["'self'"], {
        selfOrigin: "https://app.example",
      }),
      true,
    );
    assert.equal(
      isAllowedEmbedMessageOrigin("https://evil.example", ["'self'"], {
        selfOrigin: "https://app.example",
      }),
      false,
    );
    assert.equal(
      isAllowedEmbedMessageOrigin("https://app.example", [], {
        selfOrigin: "https://app.example",
      }),
      false,
    );
    assert.deepEqual(
      parseCatalogFrameAncestors({
        frameAncestors: ["https://portal.example", "*", "null", "'self'"],
      }),
      ["https://portal.example", "'self'"],
    );
    assert.deepEqual(parseCatalogFrameAncestors({}), []);
  });

  it("cites #125 / #121 and keeps the published mount map", () => {
    assert.equal(EMBED_STORY, 121);
    assert.equal(EMBED_EPIC, 120);
    assert.equal(EMBED_API_PR, 125);
    assert.equal(EMBED_ROUTE_MAP_SOURCE, "e111-#125");
    assert.equal(EMBED_MOUNT_HEADER, "x-flowforge-embed");
    assert.equal(EMBED_REJECTED_ASSERTION_HEADER, "x-flowforge-embed-rejected");
    assert.equal(isEmbedUiPath("/embed/v1/workflows"), true);
    assert.equal(isEmbedUiPath("/embed"), false);
    assert.equal(isEmbedUiPath(null), false);
  });

  it("validates body-only compact JWS and forgets the holder", () => {
    const sample = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";
    const valid = validateEmbedAssertion(sample);
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.deepEqual(valid.body, { assertion: sample, sdk: EMBED_SDK });
    }
    assert.equal(validateEmbedAssertion("").ok, false);
    assert.equal(validateEmbedAssertion("not-a-jws").ok, false);
    assert.equal(isCompactJws(sample), true);
    const holder = { assertion: sample };
    assert.equal(forgetEmbedAssertion(holder), "");
    assert.equal(holder.assertion, "");
    assert.deepEqual(buildEmbedExchangeBody(` ${sample} `), {
      assertion: sample,
      sdk: "embed.v1",
    });
    assert.deepEqual(
      buildEmbedExchangeBody(sample, {
        hostIssuer: "https://idp.example",
        hostContext: EMBED_HOST_CONTEXT_EMBED,
      }),
      {
        assertion: sample,
        sdk: "embed.v1",
        hostIssuer: "https://idp.example",
        hostContext: "embed",
      },
    );
    assert.deepEqual(
      embedHostBindingHeaders({
        hostIssuer: "https://portal.example",
        hostContext: EMBED_HOST_CONTEXT_PORTAL,
      }),
      {
        [FLOWFORGE_HOST_ISSUER_HEADER]: "https://portal.example",
        [FLOWFORGE_HOST_CONTEXT_HEADER]: "portal",
      },
    );
  });

  it("rejects assertion tokens in query or hash and never reads them", () => {
    assert.equal(urlRejectedAssertion("?tab=run", "#schedules"), false);
    assert.equal(urlRejectedAssertion("?assertion=eyJ"), true);
    assert.equal(urlRejectedAssertion("", "#token=eyJ"), true);
    assert.equal(assertionFromURL("/embed/v1/workflows/abc?assertion=eyJ"), null);
  });

  it("parses #125 exchange metadata and strips a leaked compact JWS", () => {
    const sample = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";
    const parsed = parseEmbedExchangePayload({
      session: { id: "sess-1" },
      principal: { issuer: "https://host", external_subject: "ada" },
      csrf_token: "csrf-1",
      assertion: {
        sdk: "embed.v1",
        tokenId: "jti-1",
        audience: "flowforge",
        tenantId: "ten-1",
        workbenchKey: "ops",
        assertion: sample,
      },
      workspace: {
        id: "ws-1",
        tenant_id: "ten-1",
        workbench_key: "ops",
        name: "Ops",
      },
      tenant: { id: "ten-1", slug: "acme", name: "Acme" },
      capabilities: ["workflow.view"],
    });
    assert.equal(parsed.leaked, true);
    assert.deepEqual(parsed.strippedKeys, ["assertion.assertion"]);
    assert.equal(parsed.context.audience, "flowforge");
    assert.equal(parsed.context.sdk, "embed.v1");
    assert.equal(parsed.context.tenantSlug, "acme");
    assert.equal(parsed.context.workbenchKey, "ops");
    assert.equal(parsed.context.workspaceId, "ws-1");
    assert.deepEqual(parsed.context.capabilities, ["workflow.view"]);
  });

  it("accepts versioned postMessage and public JWKS only", () => {
    const sample = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";
    const message = parseEmbedAssertionMessage({
      type: "flowforge.embed.assertion",
      version: 1,
      assertion: sample,
    });
    assert.equal(message?.assertion, sample);
    assert.equal(
      parseEmbedAssertionMessage({ type: "other", assertion: sample }),
      null,
    );
    assert.equal(
      isAllowedEmbedMessageOrigin("https://portal.example", [
        "https://portal.example",
      ]),
      true,
    );
    assert.equal(
      isAllowedEmbedMessageOrigin("https://portal.example", []),
      false,
    );
    assert.deepEqual(
      embedPostMessageAllowlist({
        WEB_EMBED_FRAME_ANCESTORS: "https://portal.example",
      }),
      ["https://portal.example"],
    );
    const jwks = publicJwksOnly({
      keys: [{ kty: "OKP", crv: "Ed25519", x: "abc", d: "SECRET", seed: "nope" }],
    });
    assert.equal(jwks.leaked, true);
    assert.equal("d" in jwks.keys[0], false);
    assert.equal("seed" in jwks.keys[0], false);
    assert.equal(jwks.keys[0]?.x, "abc");
    const display = parseEmbedHostDisplay(
      new URLSearchParams({ tenant: "acme", workbench: "ops" }),
    );
    assert.equal(display.tenant, "acme");
    assert.equal(display.unverified, true);
    assert.match(embedAuthFailureMessage({ status: 409, code: "replay" }), /single-use/);
  });

  it("honors E11.2 session embed tenancy and never trusts host tenant", () => {
    assert.equal(EMBED_VALIDATION_STORY, 122);
    assert.equal(EMBED_TENANCY_RULES.hostTenantIsNotAuthorization, true);
    assert.equal(EMBED_TENANCY_RULES.chromeFromGetSession, true);
    assert.equal(hostTenantIsAuthorization("acme"), false);
    const bound = parseSessionEmbedBinding({
      embed: {
        mode: "embed",
        sdk: "embed.v1",
        tenantId: "ten-1",
        tenantSlug: "acme",
        tenantName: "Acme",
        workbenchKey: "ops",
        workspaceId: "ws-1",
        workspaceName: "Ops",
        capabilities: ["workflow.view"],
      },
    });
    assert.equal(bound?.workbenchKey, "ops");
    assert.equal(bound?.mode, "embed");
    assert.equal(bound?.tenantSlug, "acme");
    assert.equal(bound?.workspaceName, "Ops");
    assert.equal(embedHeadersMatchSession({ tenantId: "ten-1", workbenchKey: "ops" }, bound!), true);
    assert.equal(embedHeadersMatchSession({ tenantId: "ten-1", workbenchKey: "other" }, bound!), false);
    const headers = embedWorkspaceHeaders({
      audience: "flowforge",
      sdk: "embed.v1",
      tenantId: "ten-1",
      tenantSlug: "acme",
      workbenchKey: "ops",
      workspaceId: "ws-1",
      workspaceName: "Ops",
      capabilities: ["workflow.view"],
      tokenId: "jti-1",
    });
    assert.deepEqual(headers, { tenantId: "ten-1", workbenchKey: "ops" });
  });

  it("documents CHIPS embed cookies without weakening top-level SameSite", () => {
    assert.equal(EMBED_SESSION_COOKIE.sameSite, "None");
    assert.equal(EMBED_SESSION_COOKIE.secure, true);
    assert.equal(EMBED_SESSION_COOKIE.partitioned, true);
    assert.equal(EMBED_CSRF_COOKIE.sameSite, "None");
    assert.equal(EMBED_CSRF_COOKIE.partitioned, true);
    assert.equal(TOPLEVEL_SESSION_COOKIE.sameSite, "Lax");
    assert.equal(TOPLEVEL_SESSION_COOKIE.partitioned, false);
    assert.equal(TOPLEVEL_CSRF_COOKIE.sameSite, "Strict");
    assert.equal(EMBED_COOKIE_CREDENTIALS, "include");
    assert.equal(EMBED_STORAGE_ACCESS_API.required, false);
    assert.equal(EMBED_STORAGE_ACCESS_API.requestUnpartitioned, false);
    assert.equal(EMBED_COOKIE_REQUIREMENTS.https, true);
    assert.equal(EMBED_CHIPS_SET_COOKIE, "SameSite=None; Secure; Partitioned");
    assert.equal(EMBED_CHIPS_RULES.neverDropSecure, true);
    assert.equal(EMBED_CHIPS_RULES.neverSameSiteNoneWithoutPartitioned, true);
    assert.equal(EMBED_CHIPS_RULES.neverWeakenTopLevelSameSite, true);
    assert.equal(EMBED_VERIFY_RULES.verifyBeforeWorkspaceLookup, true);
    assert.equal(EMBED_VERIFY_RULES.noWorkspaceOracleOnInvalidAssertion, true);
    assert.equal(EMBED_VERIFY_RULES.jtiConsumeAfterVerify, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.bindIssToMintingHost, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.signedCtxSelectsPathAllowlist, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.headersAreOptionalConsistency, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.neverPeekIssFromAssertion, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.wrongIssuerForHostIs403, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.nextPublicIsNotASource, true);
    assert.equal(EMBED_HOST_ISSUER_RULES.header, "X-FlowForge-Host-Issuer");
    assert.match(EMBED_HOST_ISSUER_HELP, /signed ctx/);
    assert.deepEqual(parseCatalogIssuers({ issuers: ["https://idp.example", ""] }), [
      "https://idp.example",
    ]);
    assert.deepEqual(
      exchangeHostBindingFromGate({
        receivedVia: "postMessage",
        portalIssuers: ["https://portal.example"],
      }),
      { hostContext: "portal", hostIssuer: "https://portal.example" },
    );
    assert.deepEqual(
      exchangeHostBindingFromGate({
        receivedVia: "form",
        embedIssuers: ["https://idp.example"],
      }),
      { hostContext: "embed", hostIssuer: "https://idp.example" },
    );
    assert.equal(EMBED_JTI_RULES.atomicSingleStatementConsume, true);
    assert.equal(EMBED_JTI_RULES.retainUsedIdsPastExpiry, true);
    assert.equal(EMBED_JTI_RULES.retention, "24h");
    assert.equal(EMBED_JTI_RULES.replayIs409, true);
    assert.equal(EMBED_RATE_LIMIT_RULES.exchangeRateLimited, true);
    assert.equal(EMBED_RATE_LIMIT_RULES.status, 429);
    assert.equal(EMBED_RATE_LIMIT_RULES.treatAsBackoff, true);
    assert.equal(EMBED_RATE_LIMIT_RULES.noUiChangeBeyondBackoff, true);
    assert.match(
      embedAuthFailureMessage({ status: 401, code: "unauthenticated" }),
      /Partitioned/,
    );
    assert.match(
      embedAuthFailureMessage({ status: 429, code: "rate-limited" }),
      /Back off/,
    );
    assert.match(EMBED_RATE_LIMITED_MESSAGE, /429/);
  });

  it("resolves host-issuer binding from configured sources and never peeks the JWS", () => {
    const hostile = compactJwsWithIss("https://evil.example");
    assert.equal(peekAssertionHostIssuer(hostile), undefined);
    assert.equal(peekAssertionHostIssuer("not-a-jws"), undefined);

    assert.deepEqual(
      parseCatalogIssuers({
        issuers: ["https://portal.cp-ops.example", hostile, ""],
        iss: "https://evil.example",
        host: "https://evil.example",
        assertion: hostile,
      }),
      ["https://portal.cp-ops.example"],
    );
    assert.deepEqual(parseCatalogIssuers({ issuer: "https://idp.example" }), [
      "https://idp.example",
    ]);
    assert.deepEqual(parseCatalogIssuers({ issuer: hostile }), []);

    assert.equal(
      resolveConfiguredHostIssuer({
        issuers: ["https://portal.a", "https://portal.b"],
        primaryIssuer: "https://portal.cp-ops.example",
      }),
      "https://portal.cp-ops.example",
    );
    assert.equal(
      resolveConfiguredHostIssuer({ issuers: ["https://idp.example"] }),
      "https://idp.example",
    );
    assert.equal(
      resolveConfiguredHostIssuer({
        issuers: ["https://portal.a", "https://portal.b"],
      }),
      "",
    );

    const fromEnv = readConfiguredHostIssuers({
      PORTAL_ISSUER: "https://portal.cp-ops.example",
      EMBED_ISSUER: "https://idp.example",
      WEB_PORTAL_FRAME_ANCESTORS: "https://portal.test:8443",
      NEXT_PUBLIC_PORTAL_ISSUER: "https://drift.example",
      NEXT_PUBLIC_EMBED_ISSUER: "https://drift-embed.example",
    });
    assert.equal(fromEnv.portalIssuer, "https://portal.cp-ops.example");
    assert.equal(fromEnv.embedIssuer, "https://idp.example");
    assert.deepEqual(fromEnv.portalReferrerAllowlist, [
      "https://portal.test:8443",
    ]);
    assert.equal(
      readConfiguredHostIssuers({
        NEXT_PUBLIC_PORTAL_ISSUER: "https://drift.example",
      }).portalIssuer,
      "",
    );

    assert.equal(
      detectEmbedHostContext({ hostContext: "portal" }),
      EMBED_HOST_CONTEXT_PORTAL,
    );
    assert.equal(
      detectEmbedHostContext({
        referrer: "https://app.example/portal/workflows",
        selfOrigin: "https://app.example",
      }),
      EMBED_HOST_CONTEXT_PORTAL,
    );
    assert.equal(
      detectEmbedHostContext({
        referrer: "https://portal.test:8443/workflows",
        portalReferrerAllowlist: ["https://portal.test:8443"],
      }),
      EMBED_HOST_CONTEXT_PORTAL,
    );
    assert.equal(
      detectEmbedHostContext({
        referrer: "https://host.example/embed",
        portalReferrerAllowlist: ["https://portal.test:8443"],
      }),
      EMBED_HOST_CONTEXT_EMBED,
    );

    const portalBinding = resolveEmbedHostBinding({
      hostContext: "portal",
      portalIssuers: ["https://portal.a", "https://portal.b"],
      portalIssuer: "https://portal.cp-ops.example",
      embedIssuer: "https://idp.example",
    });
    assert.deepEqual(portalBinding, {
      hostContext: "portal",
      hostIssuer: "https://portal.cp-ops.example",
    });
    assert.notEqual(portalBinding.hostIssuer, "https://evil.example");
    assert.deepEqual(
      embedHostBindingHeaders(portalBinding),
      {
        [FLOWFORGE_HOST_ISSUER_HEADER]: "https://portal.cp-ops.example",
        [FLOWFORGE_HOST_CONTEXT_HEADER]: "portal",
      },
    );

    const standalone = resolveEmbedHostBinding({
      embedIssuer: "https://idp.example",
    });
    assert.deepEqual(standalone, {
      hostContext: "embed",
      hostIssuer: "https://idp.example",
    });

    const ambiguous = resolveEmbedHostBinding({
      hostContext: "portal",
      portalIssuers: ["https://portal.a", "https://portal.b"],
    });
    assert.deepEqual(ambiguous, { hostContext: "portal" });
    assert.equal("hostIssuer" in ambiguous, false);
  });

  it("drives embed chrome from GET /session and fail-closes without a bind", () => {
    assert.equal(EMBED_CHROME_FROM_SESSION.path, "GET /session");
    assert.equal(EMBED_CHROME_FROM_SESSION.source, "session.embed");
    assert.equal(EMBED_CHROME_FROM_SESSION.embedModeValue, "embed");
    assert.equal(EMBED_CHROME_FROM_SESSION_RULES.sessionIsAuthority, true);
    assert.equal(EMBED_CHROME_FROM_SESSION_RULES.failClosedWithoutEmbedBinding, true);
    assert.equal(EMBED_CHROME_FROM_SESSION_RULES.noSecrets, true);
    assert.equal(EMBED_CHROME_FROM_SESSION_RULES.noProductShellRewrite, true);
    assert.match(EMBED_CHROME_FROM_SESSION_HELP, /GET \/session/);
    assert.ok(EMBED_CHROME_FROM_SESSION.refetch.includes(
      "on /embed/v1 mount when ff_session may exist",
    ));
    assert.ok(
      EMBED_CHROME_FROM_SESSION.doNotUse.some((item) =>
        item.includes("catalog"),
      ),
    );

    const sample = "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJmbG93Zm9yZ2UifQ.signature";
    const parsed = parseEmbedChromeFromSession({
      session: {
        id: "sess-1",
        embed: {
          mode: "embed",
          sdk: "embed.v1",
          tenantId: "ten-1",
          tenantSlug: "acme",
          tenantName: "Acme",
          workbenchKey: "ops",
          workspaceId: "ws-1",
          workspaceName: "Ops",
          capabilities: ["workflow.view"],
        },
      },
      principal: {
        issuer: "https://idp.example",
        external_subject: "ada",
        display_name: "Ada",
      },
      csrf_token: "csrf-1",
      assertion: sample,
      jti: "leak",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.leaked, true);
    assert.ok(parsed.strippedKeys.includes("assertion"));
    assert.ok(parsed.strippedKeys.includes("jti"));
    assert.equal(parsed.chrome.mode, "embed");
    assert.equal(parsed.chrome.tenantSlug, "acme");
    assert.equal(parsed.chrome.tenantName, "Acme");
    assert.equal(parsed.chrome.workbenchKey, "ops");
    assert.equal(parsed.chrome.workspaceName, "Ops");
    assert.equal(parsed.chrome.displayName, "Ada");
    assert.deepEqual(parsed.chrome.capabilities, ["workflow.view"]);
    assert.equal("assertion" in parsed.chrome, false);
    assert.equal(isEmbedBoundSession({
      embed: { tenantId: "ten-1", workbenchKey: "ops" },
    }), true);

    const standalone = parseEmbedChromeFromSession({
      session: {
        id: "sess-standalone",
        created_at: "2026-09-10T00:00:00Z",
      },
      principal: { display_name: "Admin" },
    });
    assert.equal(standalone.ok, false);
    if (standalone.ok) {
      return;
    }
    assert.equal(standalone.reason, "missing-embed-binding");
    assert.match(standalone.message, /session\.embed/);
    assert.match(EMBED_CHROME_MISSING_SESSION_MESSAGE, /not chrome authority/);
    assert.equal(isEmbedBoundSession({ id: "sess-standalone" }), false);
    assert.equal(
      parseSessionEmbedBinding({ embed: { mode: "standalone", tenantId: "ten-1", workbenchKey: "ops" } }),
      null,
    );
  });
});

function compactJwsWithIss(iss: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA" })}.${encode({ iss, aud: "flowforge" })}.sig`;
}
