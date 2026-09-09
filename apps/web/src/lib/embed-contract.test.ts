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
  buildEmbedExchangeBody,
  embedApiPath,
  embedAuthFailureMessage,
  embedMountPath,
  embedPostMessageAllowlist,
  forgetEmbedAssertion,
  frameAncestorsForPath,
  isAllowedEmbedMessageOrigin,
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
    assert.equal(hostTenantIsAuthorization("acme"), false);
    const bound = parseSessionEmbedBinding({
      embed: {
        tenantId: "ten-1",
        workbenchKey: "ops",
        workspaceId: "ws-1",
        capabilities: ["workflow.view"],
      },
    });
    assert.equal(bound?.workbenchKey, "ops");
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
});
