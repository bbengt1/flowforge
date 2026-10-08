import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { expectNoSecretsInBrowserStorage, installOperatorApi } from "./operator-api";
import {
  SCIM_TOKEN_ALREADY_REVOKED,
  SCIM_TOKEN_NAME_CONTROL_MESSAGE,
  SCIM_TOKEN_NAME_INVALID_MESSAGE,
  SCIM_TOKEN_NAME_REQUIRED_MESSAGE,
  SCIM_TOKEN_NEVER_USED,
  SCIM_TOKEN_PREFIX,
  SCIM_TOKEN_REVEAL_WARNING,
  SCIM_TOKEN_UNKNOWN_CREATOR,
  SCIM_TOKENS_EMBED_UNAVAILABLE,
  SCIM_TOKENS_EMPTY_HEADING,
  SCIM_TOKENS_FORBIDDEN,
  SCIM_TOKENS_MFA_REQUIRED,
  SCIM_TOKENS_NOT_AVAILABLE,
  SCIM_TOKENS_NOT_CONFIGURED,
  scimTokenLimitMessage,
} from "../src/lib/scim-tokens.ts";

/**
 * SCIM tokens admin against an in-memory stand-in for
 * /api/v1/workspace/scim-tokens. The plaintext exists only in the
 * create response and must leave the page when the dialog closes.
 */

const OPERATOR_PERMISSIONS = [
  "workflow.view",
  "workflow.edit",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "approval.view",
] as const;
const ADMIN_PERMISSIONS = [...OPERATOR_PERMISSIONS, "workspace.administer"] as const;

const OKTA_ID = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
const ENTRA_ID = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
const NEW_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const ADA = "88888888-8888-4888-8888-888888888888";
// Built at runtime so the repository never holds a token-shaped literal
// (the secret scan matches the prefix plus 43 base64url characters).
const PLAINTEXT = `${SCIM_TOKEN_PREFIX}${"Zk9-_".repeat(8)}abc`;

type StoredToken = {
  id: string;
  displayName: string;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type Mode =
  | "ok"
  | "stub"
  | "mfa"
  | "store-down"
  | "limit-race"
  | "create-unconfigured"
  | "revoke-gone";

type TokensApi = {
  tokens: StoredToken[];
  calls: string[];
};

const OKTA: StoredToken = {
  id: OKTA_ID,
  displayName: "Okta production",
  createdBy: { id: ADA, displayName: "Ada Admin" },
  createdAt: "2026-10-01T12:00:00Z",
  lastUsedAt: "2026-10-07T09:30:00Z",
};

const ENTRA: StoredToken = {
  id: ENTRA_ID,
  displayName: "Entra staging",
  createdBy: null,
  createdAt: "2026-09-20T08:00:00Z",
  lastUsedAt: null,
};

// Titles match the live API. The web must key off `code`, never these.
const TITLES: Record<number, string> = {
  400: "Invalid Request",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  501: "Not Implemented",
  503: "Service Unavailable",
};

function problem(path: string, status: number, code: string, errorPath?: string) {
  return {
    type: `urn:flowforge:problem:${code}`,
    title: TITLES[status] ?? "Problem",
    status,
    detail: "raw server detail",
    instance: `/api/v1${path}`,
    code,
    request_id: "e2e-scim",
    ...(errorPath ? { errors: [{ path: errorPath, code, message: "server message" }] } : {}),
  };
}

function apiPath(url: string): string {
  return new URL(url).pathname.replace(/^\/api\/(?:v1|control-plane)/, "");
}

async function send(route: Route, status: number, body?: unknown, noStore = false): Promise<void> {
  if (status === 204) {
    await route.fulfill({ status: 204, body: "" });
    return;
  }
  await route.fulfill({
    status,
    contentType: status >= 400 ? "application/problem+json" : "application/json",
    headers: noStore ? { "Cache-Control": "no-store" } : {},
    body: JSON.stringify(body),
  });
}

function record(token: StoredToken) {
  return { ...token, prefix: "ffscim_" };
}

async function installScimTokensApi(
  page: Page,
  options: {
    seed?: StoredToken[];
    permissions?: readonly string[];
    embed?: boolean;
    configured?: boolean;
    mode?: Mode;
  } = {},
): Promise<TokensApi> {
  await installOperatorApi(page, {
    permissions: options.permissions ?? ADMIN_PERMISSIONS,
    embed: options.embed,
  });
  const api: TokensApi = { tokens: [...(options.seed ?? [])], calls: [] };
  const mode = options.mode ?? "ok";
  const configured = options.configured ?? true;
  await page.route(/\/api\/(?:v1|control-plane)\/workspace\/scim-tokens/, async (route) => {
    const method = route.request().method();
    const path = apiPath(route.request().url());
    api.calls.push(`${method} ${path}`);
    if (mode === "stub") {
      await send(route, 501, problem(path, 501, "internal-error"));
      return;
    }
    if (mode === "store-down" && method === "GET") {
      await send(route, 503, problem(path, 503, "dependency-unavailable"));
      return;
    }
    if (mode === "mfa") {
      await send(route, 403, {
        ...problem(path, 403, "mfa-required"),
        detail: "Verify MFA before using this permission.",
      });
      return;
    }
    if (path === "/workspace/scim-tokens" && method === "GET") {
      await send(route, 200, {
        items: api.tokens.map(record),
        maxActive: 2,
        configured,
      });
      return;
    }
    if (path === "/workspace/scim-tokens" && method === "POST") {
      const raw = route.request().postData();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const name = String(body.displayName ?? "").trim();
      if (mode === "create-unconfigured") {
        await send(route, 503, problem(path, 503, "scim_not_configured"));
        return;
      }
      if (mode === "limit-race") {
        // Another admin took the last slot after the list loaded.
        api.tokens.push({ ...ENTRA, id: NEW_ID, displayName: "Taken elsewhere" });
        await send(route, 409, problem(path, 409, "scim_token_limit"));
        return;
      }
      // The live API ignores extra fields; the web must not send any.
      if (Object.keys(body).some((key) => key !== "displayName")) {
        await send(route, 500, problem(path, 500, "internal-error"));
        return;
      }
      if (name.toLowerCase() === "bad name") {
        await send(route, 400, problem(path, 400, "invalid-request", "displayName"));
        return;
      }
      const created: StoredToken = {
        id: NEW_ID,
        displayName: name,
        createdBy: { id: ADA, displayName: "Ada Admin" },
        createdAt: "2026-10-07T23:59:00Z",
        lastUsedAt: null,
      };
      api.tokens.unshift(created);
      await send(route, 201, { ...record(created), token: PLAINTEXT }, true);
      return;
    }
    const match = path.match(/^\/workspace\/scim-tokens\/([^/]+)$/);
    if (match && method === "DELETE") {
      const id = match[1] ?? "";
      const known = api.tokens.some((token) => token.id === id);
      api.tokens = api.tokens.filter((token) => token.id !== id);
      if (mode === "revoke-gone" || !known) {
        await send(route, 404, problem(path, 404, "not-found"));
        return;
      }
      await send(route, 204);
      return;
    }
    await send(route, 405, problem(path, 405, "invalid-request"));
  });
  return api;
}

test.describe("SCIM tokens admin", () => {
  test("empty list teaches the model and is axe-clean", async ({ page }) => {
    await installScimTokensApi(page);
    await page.goto("/scim-tokens");
    await expect(page.getByRole("heading", { level: 1, name: "SCIM tokens" })).toBeVisible();
    await expect(page.getByRole("heading", { name: SCIM_TOKENS_EMPTY_HEADING })).toBeVisible();
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("0 of 2 active");
    await expect(page.getByRole("button", { name: "Create token" })).toBeEnabled();
    await expect(page.locator("main")).toHaveCount(1);
    await expectNoBlockingAxeViolations(page);
  });

  test("lists name, prefix hint, creator, created and last used", async ({ page }) => {
    await installScimTokensApi(page, { seed: [OKTA] });
    await page.goto("/scim-tokens");
    const okta = page.locator(`[data-scim-token-row='${OKTA_ID}']`);
    await expect(okta).toContainText("Okta production");
    await expect(okta.locator("[data-scim-token-prefix]")).toHaveText("ffscim_\u2026");
    await expect(okta.locator("[data-scim-token-creator]")).toHaveText("Ada Admin");
    await expect(okta).toContainText("Oct 1, 2026");
    await expect(okta.locator("[data-scim-token-last-used]")).toContainText("Oct 7, 2026");
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("1 of 2 active");
    await expectNoBlockingAxeViolations(page);
  });

  test("create validates, places the field error, then reveals the token once", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const api = await installScimTokensApi(page, { seed: [ENTRA] });
    await page.goto("/scim-tokens");
    const entra = page.locator(`[data-scim-token-row='${ENTRA_ID}']`);
    await expect(entra.locator("[data-scim-token-creator]")).toHaveText(SCIM_TOKEN_UNKNOWN_CREATOR);
    await expect(entra.locator("[data-scim-token-last-used]")).toHaveText(SCIM_TOKEN_NEVER_USED);

    await page.getByRole("button", { name: "Create token" }).click();
    const dialog = page.getByRole("dialog", { name: "Create SCIM token" });
    await expect(dialog).toBeVisible();
    const name = dialog.getByLabel("Token name");
    await expect(name).toBeFocused();
    await name.fill("   ");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(page.locator("#scim-token-name-error")).toHaveText(
      SCIM_TOKEN_NAME_REQUIRED_MESSAGE,
    );
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);

    await name.fill("Okta\tproduction");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(page.locator("#scim-token-name-error")).toHaveText(
      SCIM_TOKEN_NAME_CONTROL_MESSAGE,
    );
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);

    // The server stays the authority: a 400 on displayName lands on the field.
    await name.fill("bad name");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(page.locator("#scim-token-name-error")).toHaveText(
      SCIM_TOKEN_NAME_INVALID_MESSAGE,
    );
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("raw server detail")).toHaveCount(0);
    await expectNoBlockingAxeViolations(page);

    await name.fill("  Okta production  ");
    await expect(page.locator("#scim-token-name-error")).toHaveCount(0);
    const posted = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().includes("/workspace/scim-tokens"),
    );
    await dialog.getByRole("button", { name: "Create token" }).click();
    expect((await posted).postDataJSON()).toEqual({ displayName: "Okta production" });

    const reveal = page.getByRole("dialog", { name: "Token created" });
    await expect(reveal).toBeVisible();
    await expect(reveal).toContainText(SCIM_TOKEN_REVEAL_WARNING);
    const field = reveal.getByLabel("New SCIM token");
    await expect(field).toHaveValue(PLAINTEXT);
    await expect(field).toHaveAttribute("readonly", "");
    await expectNoBlockingAxeViolations(page);

    await reveal.getByRole("button", { name: "Copy token" }).click();
    await expect(reveal.getByRole("status")).toHaveText("Copied to the clipboard.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PLAINTEXT);

    // The list behind refreshes with the new record and no plaintext.
    await expect(page.locator(`[data-scim-token-row='${NEW_ID}']`)).toContainText(
      "Okta production",
    );
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("2 of 2 active");
    await expectNoSecretsInBrowserStorage(page);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage.includes("ffscim_")).toBe(false);
    expect(page.url().includes("ffscim_")).toBe(false);

    await reveal.getByRole("button", { name: "Done" }).click();
    await expect(reveal).toHaveCount(0);
    expect(await page.content()).not.toContain(PLAINTEXT);
    // At the cap now: the create button is off with the plain sentence.
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
    await expect(page.locator("[data-scim-tokens-create-blocked='limit']")).toHaveText(
      scimTokenLimitMessage(2),
    );
  });

  test("at two active tokens create is off; a lost race says the same", async ({ page }) => {
    await installScimTokensApi(page, { seed: [OKTA, ENTRA] });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("2 of 2 active");
    const create = page.getByRole("button", { name: "Create token" });
    await expect(create).toBeDisabled();
    await expect(create).toHaveAccessibleDescription(scimTokenLimitMessage(2));

    const racePage = await page.context().newPage();
    const api = await installScimTokensApi(racePage, { seed: [OKTA], mode: "limit-race" });
    await racePage.goto("/scim-tokens");
    await racePage.getByRole("button", { name: "Create token" }).click();
    const dialog = racePage.getByRole("dialog", { name: "Create SCIM token" });
    await dialog.getByLabel("Token name").fill("Okta staging");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(dialog.locator("[data-scim-token-create-notice='limit']")).toHaveText(
      scimTokenLimitMessage(2),
    );
    await expect(dialog.getByRole("button", { name: "Create token" })).toBeDisabled();
    await expect(racePage.getByText("scim_token_limit")).toHaveCount(0);
    expect(api.calls).toContain("POST /workspace/scim-tokens");
    await racePage.close();
  });

  test("SCIM not configured: plain sentence and no create", async ({ page }) => {
    await installScimTokensApi(page, { seed: [OKTA], configured: false });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-create-blocked='not-configured']")).toHaveText(
      SCIM_TOKENS_NOT_CONFIGURED,
    );
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
    // Existing tokens still list and can be revoked.
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toBeVisible();

    const second = await page.context().newPage();
    await installScimTokensApi(second, { mode: "create-unconfigured" });
    await second.goto("/scim-tokens");
    await second.getByRole("button", { name: "Create token" }).click();
    const dialog = second.getByRole("dialog", { name: "Create SCIM token" });
    await dialog.getByLabel("Token name").fill("Okta");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(dialog.locator("[data-scim-token-create-notice='not-configured']")).toHaveText(
      SCIM_TOKENS_NOT_CONFIGURED,
    );
    await expect(second.getByText("scim_not_configured")).toHaveCount(0);
    await second.close();
  });

  test("a 501 from an older server says not available yet, with no raw codes", async ({
    page,
  }) => {
    const api = await installScimTokensApi(page, { mode: "stub" });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-state='not-available']")).toHaveText(
      SCIM_TOKENS_NOT_AVAILABLE,
    );
    await expect(page.getByText("501")).toHaveCount(0);
    await expect(page.getByText("internal-error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create token" })).toHaveCount(0);
    // Not retried: a 501 does not change on a second ask.
    expect(api.calls).toEqual(["GET /workspace/scim-tokens"]);
  });

  test("a store outage on the list shows the banner and keeps create off", async ({ page }) => {
    await installScimTokensApi(page, { mode: "store-down" });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText(
      "SCIM tokens could not be loaded.",
    );
    await expect(page.locator("main").getByRole("alert")).toContainText("Service Unavailable");
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
  });

  test("mfa-required shows the plain step-up line and opens step-up", async ({ page }) => {
    await installScimTokensApi(page, { mode: "mfa" });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-state='mfa-required']")).toContainText(
      SCIM_TOKENS_MFA_REQUIRED,
    );
    await expect(
      page.getByRole("dialog", { name: "Multi-factor authentication" }),
    ).toBeVisible();
  });

  test("revoke confirms as irreversible and drops the row", async ({ page }) => {
    const api = await installScimTokensApi(page, { seed: [OKTA, ENTRA] });
    await page.goto("/scim-tokens");
    await page.getByRole("button", { name: "Revoke Okta production" }).click();
    const confirm = page.getByRole("dialog", { name: "Revoke this SCIM token?" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("stops syncing right away");
    await expect(confirm).toContainText("This cannot be undone.");
    await expect(confirm).toContainText("Okta production");
    await expectNoBlockingAxeViolations(page);
    await confirm.getByRole("button", { name: "Revoke token" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toHaveCount(0);
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("1 of 2 active");
    await expect(page.getByRole("button", { name: "Create token" })).toBeEnabled();
    expect(api.calls).toContain(`DELETE /workspace/scim-tokens/${OKTA_ID}`);
  });

  test("a 404 on revoke reads as already gone and refreshes", async ({ page }) => {
    await installScimTokensApi(page, { seed: [OKTA], mode: "revoke-gone" });
    await page.goto("/scim-tokens");
    await page.getByRole("button", { name: "Revoke Okta production" }).click();
    await page
      .getByRole("dialog", { name: "Revoke this SCIM token?" })
      .getByRole("button", { name: "Revoke token" })
      .click();
    await expect(page.locator("[data-scim-tokens-note='status']")).toHaveText(
      SCIM_TOKEN_ALREADY_REVOKED,
    );
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toHaveCount(0);
    await expect(page.getByText("not-found")).toHaveCount(0);
  });

  test("non-admins get the forbidden note and no token calls", async ({ page }) => {
    const api = await installScimTokensApi(page, {
      seed: [OKTA],
      permissions: OPERATOR_PERMISSIONS,
    });
    await page.goto("/scim-tokens");
    await expect(page.getByText(SCIM_TOKENS_FORBIDDEN)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create token" })).toHaveCount(0);
    expect(api.calls).toEqual([]);
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "SCIM tokens" })).toHaveCount(0);
  });

  test("admins find SCIM tokens from Settings", async ({ page }) => {
    await installScimTokensApi(page);
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "SCIM tokens" })).toHaveAttribute(
      "href",
      "/scim-tokens",
    );
  });

  test("embed never shows or calls SCIM tokens", async ({ page }) => {
    const api = await installScimTokensApi(page, { seed: [OKTA], embed: true });
    await page.goto("/embed/v1/scim-tokens");
    await expect(page.getByText(SCIM_TOKENS_EMBED_UNAVAILABLE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create token" })).toHaveCount(0);
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toHaveCount(0);
    await page.goto("/embed/v1/settings");
    await expect(page.getByRole("link", { name: "SCIM tokens" })).toHaveCount(0);
    expect(api.calls).toEqual([]);
  });
});
