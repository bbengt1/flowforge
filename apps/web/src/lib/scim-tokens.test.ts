import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { paletteCommands } from "./command-palette.ts";
import { resolveIdentityProxyTarget } from "./identity-proxy.ts";
import type { ProblemDetails } from "./problem.ts";
import { queryKeyHasSecret, scimTokensListQueryKey } from "./query-cache.ts";
import {
  SCIM_TOKEN_ALREADY_REVOKED,
  SCIM_TOKEN_NAME_CONTROL_MESSAGE,
  SCIM_TOKEN_NAME_INVALID_MESSAGE,
  SCIM_TOKEN_NAME_REQUIRED_MESSAGE,
  SCIM_TOKEN_NAME_TOO_LONG_MESSAGE,
  SCIM_TOKEN_NEVER_USED,
  SCIM_TOKEN_REVEAL_WARNING,
  SCIM_TOKEN_REVOKE_DESCRIPTION,
  SCIM_TOKEN_UNKNOWN_CREATOR,
  SCIM_TOKENS_API_PATH,
  SCIM_TOKENS_CREATE_UNAVAILABLE,
  SCIM_TOKENS_FORBIDDEN,
  SCIM_TOKENS_HREF,
  SCIM_TOKENS_MFA_REQUIRED,
  SCIM_TOKENS_NOT_AVAILABLE,
  SCIM_TOKENS_NOT_CONFIGURED,
  SCIM_TOKENS_RETRY_LABEL,
  canManageScimTokens,
  formatScimTokenTime,
  normalizeScimTokenName,
  readScimToken,
  readScimTokenCreated,
  readScimTokenList,
  scimTokenActiveCountLabel,
  scimTokenApiPath,
  scimTokenCreateAvailability,
  scimTokenCreateFailure,
  scimTokenCreatorLabel,
  scimTokenLastUsedLabel,
  scimTokenLimitMessage,
  scimTokenListProblemIsRetryable,
  scimTokenListProblemIsTerminal,
  scimTokenNameClientError,
  scimTokenNameFieldError,
  scimTokenPrefixHint,
  scimTokenProblemKind,
  scimTokenRevokeImpact,
  scimTokensView,
  type ScimTokenList,
} from "./scim-tokens.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(relative: string): string {
  return readFileSync(join(webRoot, relative), "utf8");
}

const ROW_ID = "3f1c2a4e-9d7b-4c1a-8e2f-0a1b2c3d4e5f";
const OTHER_ID = "4a1c2a4e-9d7b-4c1a-8e2f-0a1b2c3d4e5f";
const ADA = "88888888-8888-4888-8888-888888888888";
const PLAINTEXT = `ffscim_${"A".repeat(40)}b-_`;

function problem(
  status: number,
  code: string,
  errors?: ProblemDetails["errors"],
): ProblemDetails {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: "Problem",
    status,
    detail: "server detail",
    instance: "/api/v1/workspace/scim-tokens",
    code,
    request_id: "req-1",
    ...(errors ? { errors } : {}),
  };
}

const wire = {
  id: ROW_ID,
  displayName: "Okta prod",
  prefix: "ffscim_",
  createdBy: { id: ADA, displayName: "Ada" },
  createdAt: "2026-10-07T23:00:00Z",
  lastUsedAt: null,
};

function list(overrides: Partial<ScimTokenList> = {}): ScimTokenList {
  return {
    items: [readScimToken(wire)!],
    maxActive: 2,
    configured: true,
    ...overrides,
  };
}

describe("SCIM tokens gating", () => {
  it("is admin-only, hidden while permissions are unknown, and never in embed", () => {
    assert.equal(canManageScimTokens(["workspace.administer"]), true);
    assert.equal(canManageScimTokens(["workflow.view"]), false);
    assert.equal(canManageScimTokens(null), false);
    assert.equal(canManageScimTokens(undefined), false);
    assert.equal(canManageScimTokens(["workspace.administer"], { embed: true }), false);
  });

  it("the palette offers the page to admins outside embed only", () => {
    const ids = (permissions: string[], embed: boolean) =>
      paletteCommands(permissions, { embed }).map((command) => command.id);
    assert.equal(ids(["workspace.administer"], false).includes("nav-scim-tokens"), true);
    assert.equal(ids(["workspace.administer"], true).includes("nav-scim-tokens"), false);
    assert.equal(ids(["workflow.view"], false).includes("nav-scim-tokens"), false);
    const command = paletteCommands(["workspace.administer"]).find(
      (item) => item.id === "nav-scim-tokens",
    );
    assert.deepEqual(command?.action, { type: "navigate", href: SCIM_TOKENS_HREF });
  });

  it("the proxy allowlist carries the list, create and revoke routes", () => {
    const listTarget = resolveIdentityProxyTarget("GET", ["workspace", "scim-tokens"]);
    assert.equal("apiPath" in listTarget && listTarget.apiPath, "/api/v1/workspace/scim-tokens");
    const createTarget = resolveIdentityProxyTarget("POST", ["workspace", "scim-tokens"]);
    assert.equal("apiPath" in createTarget, true);
    const revokeTarget = resolveIdentityProxyTarget("DELETE", [
      "workspace",
      "scim-tokens",
      ROW_ID,
    ]);
    assert.equal(
      "apiPath" in revokeTarget && revokeTarget.apiPath,
      `/api/v1/workspace/scim-tokens/${ROW_ID}`,
    );
    assert.equal(SCIM_TOKENS_API_PATH, "/workspace/scim-tokens");
    assert.equal(scimTokenApiPath(ROW_ID), `/workspace/scim-tokens/${ROW_ID}`);
  });
});

describe("SCIM tokens reading", () => {
  it("reads records from known fields only and never keeps a token field", () => {
    const record = readScimToken({ ...wire, token: PLAINTEXT, tokenHash: "ab".repeat(32) });
    assert.ok(record);
    assert.equal(record.displayName, "Okta prod");
    assert.equal(record.prefix, "ffscim_");
    assert.deepEqual(record.createdBy, { id: ADA, displayName: "Ada" });
    assert.equal(record.lastUsedAt, null);
    assert.equal("token" in record, false);
    assert.equal("tokenHash" in record, false);
    assert.equal(JSON.stringify(record).includes(PLAINTEXT), false);
  });

  it("drops rows without a UUID id or a name, and reads a missing creator as null", () => {
    assert.equal(readScimToken({ ...wire, id: "nope" }), null);
    assert.equal(readScimToken({ ...wire, displayName: 7 }), null);
    assert.equal(readScimToken(null), null);
    assert.equal(readScimToken({ ...wire, createdBy: null })?.createdBy, null);
    assert.equal(readScimToken({ ...wire, createdBy: { id: "x" } })?.createdBy, null);
  });

  it("reads the list, de-duplicates ids, and trusts only configured: true", () => {
    const read = readScimTokenList({
      items: [wire, { ...wire, token: PLAINTEXT }, { ...wire, id: OTHER_ID }, "junk"],
      maxActive: 2,
      configured: true,
    });
    assert.deepEqual(
      read.items.map((item) => item.id),
      [ROW_ID, OTHER_ID],
    );
    assert.equal(read.maxActive, 2);
    assert.equal(read.configured, true);
    assert.equal(JSON.stringify(read).includes(PLAINTEXT), false);
    assert.equal(readScimTokenList({ items: [] }).configured, false);
    assert.equal(readScimTokenList({ items: [], configured: "true" }).configured, false);
    assert.equal(readScimTokenList({ items: [], maxActive: 0 }).maxActive, 2);
    assert.equal(readScimTokenList(null).items.length, 0);
  });

  it("splits a create response into a cacheable record and the plaintext", () => {
    const created = readScimTokenCreated({ ...wire, token: PLAINTEXT });
    assert.equal(created.plaintext, PLAINTEXT);
    assert.ok(created.record);
    assert.equal("token" in created.record, false);
    assert.equal(JSON.stringify(created.record).includes(PLAINTEXT), false);
  });

  it("does not show a plaintext that isn't token-shaped", () => {
    assert.equal(readScimTokenCreated({ ...wire, token: "secret" }).plaintext, null);
    assert.equal(readScimTokenCreated({ ...wire, token: `${PLAINTEXT}x` }).plaintext, null);
    assert.equal(readScimTokenCreated({ ...wire, token: ` ${PLAINTEXT}` }).plaintext, null);
    assert.equal(readScimTokenCreated({ ...wire }).plaintext, null);
  });
});

describe("SCIM token names", () => {
  it("trims and validates on the client as a hint only", () => {
    assert.equal(normalizeScimTokenName("  Okta  "), "Okta");
    assert.equal(scimTokenNameClientError("   "), SCIM_TOKEN_NAME_REQUIRED_MESSAGE);
    assert.equal(scimTokenNameClientError(""), SCIM_TOKEN_NAME_REQUIRED_MESSAGE);
    assert.equal(scimTokenNameClientError(" Okta "), null);
    assert.equal(scimTokenNameClientError("é".repeat(128)), null);
    assert.equal(scimTokenNameClientError("a".repeat(129)), SCIM_TOKEN_NAME_TOO_LONG_MESSAGE);
  });

  it("refuses control characters inside the name, like the API", () => {
    assert.equal(scimTokenNameClientError("Okta\tprod"), SCIM_TOKEN_NAME_CONTROL_MESSAGE);
    assert.equal(scimTokenNameClientError("Okta\nprod"), SCIM_TOKEN_NAME_CONTROL_MESSAGE);
    assert.equal(scimTokenNameClientError("Okta\u007fprod"), SCIM_TOKEN_NAME_CONTROL_MESSAGE);
    assert.equal(scimTokenNameClientError("Okta\u0085prod"), SCIM_TOKEN_NAME_CONTROL_MESSAGE);
    // Surrounding whitespace is trimmed first, as on the server.
    assert.equal(scimTokenNameClientError("\tOkta prod\n"), null);
    assert.equal(scimTokenNameClientError("Okta — prod ✓"), null);
  });
});

describe("SCIM token labels", () => {
  it("shows the creator, or Unknown when the creator is gone", () => {
    assert.equal(scimTokenCreatorLabel({ id: ADA, displayName: " Ada " }), "Ada");
    assert.equal(scimTokenCreatorLabel({ id: ADA, displayName: "" }), SCIM_TOKEN_UNKNOWN_CREATOR);
    assert.equal(scimTokenCreatorLabel(null), SCIM_TOKEN_UNKNOWN_CREATOR);
  });

  it("formats times and says Never used for a null lastUsedAt", () => {
    // ICU versions differ on the space before PM, so match loosely.
    assert.match(
      formatScimTokenTime("2026-10-07T23:00:00Z", { timeZone: "UTC" }),
      /^Oct 7, 2026, 11:00\s?PM$/u,
    );
    assert.equal(formatScimTokenTime("not a date"), "");
    assert.equal(formatScimTokenTime(null), "");
    assert.equal(scimTokenLastUsedLabel(null), SCIM_TOKEN_NEVER_USED);
    assert.equal(scimTokenLastUsedLabel("garbage"), SCIM_TOKEN_NEVER_USED);
    assert.match(scimTokenLastUsedLabel("2026-10-07T23:05:00Z", { timeZone: "UTC" }), /11:05/);
  });

  it("hints only the fixed prefix and counts active tokens against the cap", () => {
    assert.equal(scimTokenPrefixHint({ prefix: "ffscim_" }), "ffscim_\u2026");
    assert.equal(scimTokenActiveCountLabel(1, 2), "1 of 2 active");
    assert.equal(scimTokenActiveCountLabel(0, 2), "0 of 2 active");
    assert.equal(scimTokenActiveCountLabel(2, 2), "2 of 2 active");
  });
});

describe("SCIM token problems", () => {
  it("maps each problem to one plain treatment", () => {
    assert.equal(scimTokenProblemKind(problem(403, "mfa-required")), "mfa-required");
    assert.equal(scimTokenProblemKind(problem(403, "forbidden")), "forbidden");
    assert.equal(scimTokenProblemKind(problem(401, "unauthenticated")), "forbidden");
    assert.equal(scimTokenProblemKind(problem(501, "internal-error")), "not-available");
    assert.equal(scimTokenProblemKind(problem(503, "scim_not_configured")), "not-configured");
    assert.equal(scimTokenProblemKind(problem(409, "scim_token_limit")), "limit");
    assert.equal(scimTokenProblemKind(problem(404, "not-found")), "not-found");
    assert.equal(
      scimTokenProblemKind(problem(400, "invalid-request", [{ path: "displayName", code: "invalid-request", message: "m" }])),
      "field",
    );
    assert.equal(
      scimTokenProblemKind(problem(400, "invalid-request", [{ path: "other", code: "invalid-request", message: "m" }])),
      "banner",
    );
    assert.equal(scimTokenProblemKind(problem(503, "dependency-unavailable")), "banner");
    assert.equal(scimTokenProblemKind(null), null);
  });

  it("places a displayName 400 on the field by path, never by message text", () => {
    assert.equal(
      scimTokenNameFieldError(
        problem(400, "invalid-request", [{ path: "displayName", code: "invalid-request", message: "too long" }]),
      ),
      SCIM_TOKEN_NAME_INVALID_MESSAGE,
    );
    assert.equal(scimTokenNameFieldError(problem(400, "invalid-request")), null);
    assert.equal(scimTokenNameFieldError(problem(409, "scim_token_limit")), null);
  });

  it("routes create failures to the field, a plain notice, or the banner", () => {
    assert.deepEqual(
      scimTokenCreateFailure(
        problem(400, "invalid-request", [{ path: "displayName", code: "invalid-request", message: "m" }]),
      ),
      { placement: "field", message: SCIM_TOKEN_NAME_INVALID_MESSAGE },
    );
    assert.deepEqual(scimTokenCreateFailure(problem(409, "scim_token_limit"), 2), {
      placement: "notice",
      kind: "limit",
      message: scimTokenLimitMessage(2),
    });
    assert.deepEqual(scimTokenCreateFailure(problem(503, "scim_not_configured")), {
      placement: "notice",
      kind: "not-configured",
      message: SCIM_TOKENS_NOT_CONFIGURED,
    });
    assert.deepEqual(scimTokenCreateFailure(problem(501, "internal-error")), {
      placement: "notice",
      kind: "not-available",
      message: SCIM_TOKENS_NOT_AVAILABLE,
    });
    assert.deepEqual(scimTokenCreateFailure(problem(403, "mfa-required")), {
      placement: "notice",
      kind: "mfa-required",
      message: SCIM_TOKENS_MFA_REQUIRED,
    });
    const banner = scimTokenCreateFailure(problem(503, "dependency-unavailable"));
    assert.equal(banner.placement, "banner");
  });

  it("keys off code and status, never the title", () => {
    const limit = { ...problem(409, "scim_token_limit"), title: "Conflict" };
    const off = { ...problem(503, "scim_not_configured"), title: "Service Unavailable" };
    const store = { ...problem(503, "dependency-unavailable"), title: "Service Unavailable" };
    assert.equal(scimTokenProblemKind(limit), "limit");
    assert.equal(scimTokenProblemKind(off), "not-configured");
    assert.equal(scimTokenProblemKind(store), "banner");
    const misleading: ProblemDetails = { ...problem(409, "conflict"), title: "scim_token_limit" };
    assert.equal(scimTokenProblemKind(misleading), "banner");
  });

  it("does not retry list problems that retrying can't change", () => {
    assert.equal(scimTokenListProblemIsTerminal(problem(501, "internal-error")), true);
    assert.equal(scimTokenListProblemIsTerminal(problem(403, "mfa-required")), true);
    assert.equal(scimTokenListProblemIsTerminal(problem(503, "dependency-unavailable")), false);
    assert.equal(scimTokenListProblemIsTerminal(null), false);
  });

  it("uses the same sentence for the cap whether the list or a 409 says so", () => {
    const full = list({
      items: [readScimToken(wire)!, readScimToken({ ...wire, id: OTHER_ID })!],
    });
    const availability = scimTokenCreateAvailability(full);
    assert.equal(availability.allowed, false);
    assert.equal(availability.reason, "limit");
    const failure = scimTokenCreateFailure(problem(409, "scim_token_limit"), 2);
    assert.equal(failure.placement === "notice" && failure.message, availability.message);
    assert.match(scimTokenLimitMessage(2), /already has 2 active SCIM tokens/);
  });
});

describe("SCIM tokens page state", () => {
  it("blocks on mfa-required, forbidden and 501 with plain copy, no codes", () => {
    const mfa = scimTokensView({ list: null, problem: problem(403, "mfa-required") });
    assert.deepEqual(mfa, {
      kind: "blocked",
      reason: "mfa-required",
      message: SCIM_TOKENS_MFA_REQUIRED,
    });
    const forbidden = scimTokensView({ list: list(), problem: problem(403, "forbidden") });
    assert.equal(forbidden.kind === "blocked" && forbidden.message, SCIM_TOKENS_FORBIDDEN);
    const stub = scimTokensView({ list: null, problem: problem(501, "internal-error") });
    assert.equal(stub.kind === "blocked" && stub.reason, "not-available");
    assert.equal(stub.kind === "blocked" && stub.message, SCIM_TOKENS_NOT_AVAILABLE);
    assert.equal(stub.kind === "blocked" && /501|internal/.test(stub.message), false);
  });

  it("is loading, error, or ready otherwise", () => {
    assert.deepEqual(scimTokensView({ list: null, problem: null }), { kind: "loading" });
    const error = scimTokensView({ list: null, problem: problem(503, "dependency-unavailable") });
    assert.equal(error.kind, "error");
    const ready = scimTokensView({ list: list(), problem: problem(503, "dependency-unavailable") });
    assert.equal(ready.kind, "ready");
  });

  it("offers create only below the cap on a configured instance", () => {
    assert.deepEqual(scimTokenCreateAvailability(list()), {
      allowed: true,
      reason: null,
      message: null,
    });
    const off = scimTokenCreateAvailability(list({ configured: false }));
    assert.deepEqual(off, {
      allowed: false,
      reason: "not-configured",
      message: SCIM_TOKENS_NOT_CONFIGURED,
    });
  });
});

describe("SCIM turned off on the instance", () => {
  it("uses the agreed sentence and drops the old sign-in wording", () => {
    assert.equal(
      SCIM_TOKENS_NOT_CONFIGURED,
      "SCIM is turned off on this instance. Your identity provider's sync requests are refused until the instance operator turns it back on. Existing tokens are kept and will work again then, so revoke any you no longer need.",
    );
    assert.doesNotMatch(SCIM_TOKENS_NOT_CONFIGURED, /sign in|set up/);
    const page = source("src/lib/scim-tokens.ts");
    assert.equal(page.includes("can't sign in"), false);
  });

  it("keeps listing tokens when configured is false", () => {
    const read = readScimTokenList({ items: [wire], maxActive: 2, configured: false });
    assert.equal(read.configured, false);
    assert.deepEqual(
      read.items.map((item) => item.id),
      [ROW_ID],
    );
  });

  it("turns off create only, with the same sentence a create 503 gets", () => {
    const off = scimTokenCreateAvailability(list({ configured: false }));
    assert.equal(off.allowed, false);
    assert.equal(off.reason, "not-configured");
    const failure = scimTokenCreateFailure(problem(503, "scim_not_configured"));
    assert.equal(failure.placement === "notice" && failure.message, off.message);
    // Even at the cap, SCIM off is the reason shown.
    const full = list({
      configured: false,
      items: [readScimToken(wire)!, readScimToken({ ...wire, id: OTHER_ID })!],
    });
    assert.equal(scimTokenCreateAvailability(full).reason, "not-configured");
  });

  it("never gates Revoke on configured or on a list problem", () => {
    const page = source("src/components/scim-tokens/ScimTokensPage.tsx");
    const start = page.indexOf("function ScimTokenRow");
    assert.ok(start > 0);
    const row = page.slice(start);
    const revoke = row.slice(row.indexOf("data-scim-token-revoke"), row.indexOf("</button>"));
    assert.ok(revoke.includes("onClick={onRevoke}"));
    assert.equal(revoke.includes("disabled"), false);
    assert.equal(row.includes("configured"), false);
    assert.equal(row.includes("availability"), false);
  });
});

describe("SCIM token list retry", () => {
  it("only a banner problem is retryable by hand", () => {
    assert.equal(scimTokenListProblemIsRetryable(problem(503, "dependency-unavailable")), true);
    assert.equal(scimTokenListProblemIsRetryable(problem(500, "internal-error")), true);
    assert.equal(scimTokenListProblemIsRetryable(problem(503, "scim_not_configured")), false);
    assert.equal(scimTokenListProblemIsRetryable(problem(501, "internal-error")), false);
    assert.equal(scimTokenListProblemIsRetryable(problem(403, "mfa-required")), false);
    assert.equal(scimTokenListProblemIsRetryable(null), false);
  });

  it("a failed list keeps create off even over an older list", () => {
    const store = problem(503, "dependency-unavailable");
    assert.deepEqual(scimTokenCreateAvailability(list(), store), {
      allowed: false,
      reason: "unavailable",
      message: SCIM_TOKENS_CREATE_UNAVAILABLE,
    });
    assert.equal(
      scimTokenCreateAvailability(list({ configured: false }), store).reason,
      "unavailable",
    );
    assert.equal(scimTokenCreateAvailability(list(), null).allowed, true);
  });

  it("the page shows the banner with a Retry that refetches the list", () => {
    assert.equal(SCIM_TOKENS_RETRY_LABEL, "Retry");
    const page = source("src/components/scim-tokens/ScimTokensPage.tsx");
    const start = page.indexOf("data-scim-tokens-retry");
    assert.ok(start > 0);
    const retry = page.slice(start, page.indexOf("</button>", start));
    assert.ok(retry.includes("onClick={onRefresh}"));
    assert.equal(/\bdisabled=/.test(retry), false);
    assert.match(page, /scimTokenCreateAvailability\(list, problem\)/);
    const hook = source("src/components/scim-tokens/useScimTokens.ts");
    assert.match(hook, /query\.refetch\(\)/);
  });
});

describe("SCIM token create dialog", () => {
  const dialog = () => source("src/components/scim-tokens/CreateScimTokenDialog.tsx");

  it("the reveal step closes only through Done; the form keeps Escape", () => {
    const text = dialog();
    assert.match(text, /dismissible=\{!revealing\}/);
    // No backdrop handler on the Dialog, so a stray click can't close it.
    const open = text.slice(text.indexOf("<Dialog"), text.indexOf(">", text.indexOf("labelledBy=")));
    assert.equal(open.includes("onClick"), false);
    const done = text.slice(text.indexOf("data-scim-token-done"));
    assert.ok(done.slice(0, done.indexOf("</button>")).includes("onClick={close}"));
  });

  it("moves focus into the reveal step when it opens", () => {
    const text = dialog();
    assert.match(text, /revealFirstRef\.current\?\.focus\(\)/);
    assert.match(text, /ref=\{revealFirstRef\}/);
  });

  it("refreshes the list after every finished create attempt", () => {
    const text = dialog();
    const submit = text.slice(text.indexOf("async function submit"), text.indexOf("async function copyPlaintext"));
    const calls = submit.match(/onChanged\(\)/g) ?? [];
    assert.equal(calls.length, 1);
    const finallyBlock = submit.slice(submit.indexOf("} finally {") + "} finally {".length);
    assert.ok(finallyBlock.indexOf("onChanged()") >= 0);
    assert.ok(finallyBlock.indexOf("onChanged()") < finallyBlock.indexOf("}"));
  });
});

describe("SCIM token revoke", () => {
  it("names the token in the impact with ids that are not secret markers", () => {
    const impact = scimTokenRevokeImpact(readScimToken(wire)!, { timeZone: "UTC" });
    assert.deepEqual(
      impact.map((item) => item.id),
      ["scim-connection", "created", "last-used"],
    );
    assert.equal(impact[0]?.detail, "Okta prod");
    assert.equal(impact[2]?.detail, SCIM_TOKEN_NEVER_USED);
  });

  it("explains that the identity provider stops syncing right away", () => {
    assert.match(SCIM_TOKEN_REVOKE_DESCRIPTION, /stops syncing right away/);
    assert.match(SCIM_TOKEN_ALREADY_REVOKED, /already revoked/);
  });
});

describe("SCIM token plaintext is never persisted", () => {
  it("the list query key carries no secret and no token", () => {
    const key = scimTokensListQueryKey("acme/ops\nhttps://flowforge.local\nadmin");
    assert.ok(key);
    assert.equal(queryKeyHasSecret(key), false);
    assert.equal(JSON.stringify(key).includes("ffscim_"), false);
  });

  it("the create dialog keeps the plaintext in its own state only", () => {
    const dialog = source("src/components/scim-tokens/CreateScimTokenDialog.tsx");
    for (const forbidden of [
      "useMutation",
      "setQueryData",
      "localStorage",
      "sessionStorage",
      "console.",
      "document.cookie",
      "router.push",
      "searchParams",
    ]) {
      assert.equal(dialog.includes(forbidden), false, forbidden);
    }
    assert.match(dialog, /setReveal\(null\)/);
    assert.match(dialog, SCIM_TOKEN_REVEAL_WARNING_RE);
  });

  it("no SCIM tokens source writes the plaintext to storage, logs or the cache", () => {
    for (const relative of [
      "src/components/scim-tokens/ScimTokensPage.tsx",
      "src/components/scim-tokens/useScimTokens.ts",
      "src/lib/scim-tokens.ts",
      "src/lib/scim-tokens-client.ts",
    ]) {
      const text = source(relative);
      assert.equal(text.includes("localStorage"), false, relative);
      assert.equal(text.includes("sessionStorage"), false, relative);
      assert.equal(text.includes("console."), false, relative);
      assert.equal(text.includes("setQueryData"), false, relative);
      assert.equal(text.includes("plaintext") && relative.includes("Page"), false, relative);
    }
  });
});

const SCIM_TOKEN_REVEAL_WARNING_RE = /SCIM_TOKEN_REVEAL_WARNING/;
assert.match(SCIM_TOKEN_REVEAL_WARNING, /won't be shown again/);
