import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { expectNoSecretsInBrowserStorage, installOperatorApi } from "./operator-api";
import { QUERY_MAX_RETRIES } from "../src/lib/query-cache.ts";
import {
  SCIM_GROUPS_MODE_GROUPS_LINE,
  SCIM_GROUPS_MODE_WORKSPACES_LINE,
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
  SCIM_TOKENS_RETRY_LABEL,
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
// The list query retries a 503 on its own, so one load or one Retry press
// reaches the mock 1 + QUERY_MAX_RETRIES times before the banner settles.
const LIST_ATTEMPTS = 1 + QUERY_MAX_RETRIES;
const LIST_CALL = "GET /workspace/scim-tokens";

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
  | "create-network"
  | "revoke-gone";

type TokensApi = {
  tokens: StoredToken[];
  calls: string[];
  /** Switchable mid-test, for example to bring the store back. */
  mode: Mode;
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
    groupsMode?: "workspaces" | "groups";
  } = {},
): Promise<TokensApi> {
  await installOperatorApi(page, {
    permissions: options.permissions ?? ADMIN_PERMISSIONS,
    embed: options.embed,
  });
  const api: TokensApi = {
    tokens: [...(options.seed ?? [])],
    calls: [],
    mode: options.mode ?? "ok",
  };
  const configured = options.configured ?? true;
  await page.route(/\/api\/(?:v1|control-plane)\/workspace\/scim-tokens/, async (route) => {
    const mode = api.mode;
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
        groupsMode: options.groupsMode ?? "workspaces",
      });
      return;
    }
    if (path === "/workspace/scim-tokens" && method === "POST") {
      const raw = route.request().postData();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const name = String(body.displayName ?? "").trim();
      if (mode === "create-network") {
        // The connection drops before any answer reaches the browser.
        await route.abort("connectionreset");
        return;
      }
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
    // Focus moves into the reveal step, onto its first action.
    await expect(reveal.getByRole("button", { name: "Copy token" })).toBeFocused();
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

    // The show-once token survives a stray Escape or backdrop click.
    await page.keyboard.press("Escape");
    await expect(reveal).toBeVisible();
    await expect(field).toHaveValue(PLAINTEXT);
    await page.mouse.click(5, 5);
    await expect(reveal).toBeVisible();
    await expect(field).toHaveValue(PLAINTEXT);
    // Focus stays trapped and Done is reachable from the keyboard.
    const done = reveal.getByRole("button", { name: "Done" });
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("Tab");
      expect(await reveal.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await done.focus();
    await expect(done).toBeFocused();

    await done.click();
    await expect(reveal).toHaveCount(0);
    expect(await page.content()).not.toContain(PLAINTEXT);
    // At the cap now: the create button is off with the plain sentence.
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
    await expect(page.locator("[data-scim-tokens-create-blocked='limit']")).toHaveText(
      scimTokenLimitMessage(2),
    );
  });

  test("the name form still closes on Escape", async ({ page }) => {
    const api = await installScimTokensApi(page);
    await page.goto("/scim-tokens");
    await page.getByRole("button", { name: "Create token" }).click();
    const dialog = page.getByRole("dialog", { name: "Create SCIM token" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  test("a dropped connection on create shows the banner and still refreshes the list", async ({
    page,
  }) => {
    const api = await installScimTokensApi(page, { seed: [OKTA], mode: "create-network" });
    await page.goto("/scim-tokens");
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toBeVisible();
    const lists = () => api.calls.filter((call) => call === "GET /workspace/scim-tokens").length;
    const before = lists();
    await page.getByRole("button", { name: "Create token" }).click();
    const dialog = page.getByRole("dialog", { name: "Create SCIM token" });
    await dialog.getByLabel("Token name").fill("Okta staging");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(api.calls).toContain("POST /workspace/scim-tokens");
    await expect.poll(lists).toBeGreaterThan(before);
    // The form stays open so the admin can try again or cancel.
    await expect(dialog.getByRole("button", { name: "Create token" })).toBeEnabled();
    await expect(dialog.getByLabel("Token name")).toHaveValue("Okta staging");
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

  test("SCIM turned off: plain sentence, no create, list and revoke still work", async ({
    page,
  }) => {
    const api = await installScimTokensApi(page, { seed: [OKTA, ENTRA], configured: false });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-create-blocked='not-configured']")).toHaveText(
      SCIM_TOKENS_NOT_CONFIGURED,
    );
    await expect(page.getByText("can't sign in")).toHaveCount(0);
    const create = page.getByRole("button", { name: "Create token" });
    await expect(create).toBeDisabled();
    await expect(create).toHaveAccessibleDescription(SCIM_TOKENS_NOT_CONFIGURED);
    // Existing tokens still list, and Revoke stays on for each of them.
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("2 of 2 active");
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toBeVisible();
    const revokeOkta = page.getByRole("button", { name: "Revoke Okta production" });
    await expect(revokeOkta).toBeEnabled();
    await expect(page.getByRole("button", { name: "Revoke Entra staging" })).toBeEnabled();
    await expectNoBlockingAxeViolations(page);

    // Revoking while SCIM is off works: it is the only way to stop a
    // token before SCIM comes back on.
    await revokeOkta.click();
    const confirm = page.getByRole("dialog", { name: "Revoke this SCIM token?" });
    await confirm.getByRole("button", { name: "Revoke token" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator("[data-scim-tokens-note='status']")).toHaveText("Token revoked.");
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toHaveCount(0);
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("1 of 2 active");
    expect(api.calls).toContain(`DELETE /workspace/scim-tokens/${OKTA_ID}`);
    // Below the cap now, but create stays off while SCIM is off.
    await expect(create).toBeDisabled();
    await expect(page.locator("[data-scim-tokens-create-blocked='not-configured']")).toHaveText(
      SCIM_TOKENS_NOT_CONFIGURED,
    );

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

  test("a store outage on the list shows the banner, keeps create off, and Retry refetches", async ({
    page,
  }) => {
    const api = await installScimTokensApi(page, { seed: [OKTA], mode: "store-down" });
    const lists = () => api.calls.filter((call) => call === LIST_CALL).length;
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText(
      "SCIM tokens could not be loaded.",
    );
    const alert = page.locator("main").getByRole("alert");
    await expect(alert).toContainText("Service Unavailable");
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
    const retry = page.getByRole("button", { name: SCIM_TOKENS_RETRY_LABEL, exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    // The banner shows only after the automatic retries are spent.
    expect(lists()).toBe(LIST_ATTEMPTS);
    await expect(retry).toHaveAttribute("aria-busy", "false");
    await expectNoBlockingAxeViolations(page);

    // Retry while the store is still down asks again and stays usable.
    // With no list cached, the press hides the banner and its Retry until
    // the last automatic retry fails, then renders a new Retry. Wait for
    // that whole cycle: the first new call lands before the old banner
    // unmounts, so checking the banner then can pass on the stale one.
    const before = lists();
    await retry.click();
    await expect.poll(lists).toBe(before + LIST_ATTEMPTS);
    await expect(alert).toContainText("Service Unavailable");
    await expect(retry).toHaveAttribute("aria-busy", "false");
    await expect(retry).toBeEnabled();
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();

    // Bring the store back only now that no automatic retry is pending,
    // so the click below is what loads the list.
    api.mode = "ok";
    const listed = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        apiPath(response.url()) === "/workspace/scim-tokens" &&
        response.status() === 200,
    );
    await retry.click();
    await listed;
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toBeVisible();
    await expect(page.locator("[data-scim-tokens-count]")).toHaveText("1 of 2 active");
    await expect(page.locator("[data-scim-tokens-retry]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create token" })).toBeEnabled();
    expect(lists()).toBe(before + LIST_ATTEMPTS + 1);
  });

  test("a store outage on a refresh keeps the list, shows Retry and turns create off", async ({
    page,
  }) => {
    const api = await installScimTokensApi(page, { seed: [OKTA] });
    const lists = () => api.calls.filter((call) => call === LIST_CALL).length;
    await page.goto("/scim-tokens");
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create token" })).toBeEnabled();

    api.mode = "store-down";
    const before = lists();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("Service Unavailable");
    await expect(page.locator(`[data-scim-token-row='${OKTA_ID}']`)).toBeVisible();
    await expect(page.locator("[data-scim-tokens-create-blocked='unavailable']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Revoke Okta production" })).toBeEnabled();
    // The cached list keeps the banner up, but still flip the store only
    // after the refresh's automatic retries are spent.
    expect(lists()).toBe(before + LIST_ATTEMPTS);

    api.mode = "ok";
    const retry = page.getByRole("button", { name: SCIM_TOKENS_RETRY_LABEL, exact: true });
    await expect(retry).toHaveAttribute("aria-busy", "false");
    const listed = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        apiPath(response.url()) === "/workspace/scim-tokens" &&
        response.status() === 200,
    );
    await retry.click();
    await listed;
    await expect(page.locator("[data-scim-tokens-retry]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create token" })).toBeEnabled();
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

  test("shows one plain line for the SCIM Groups mode", async ({ page }) => {
    await installScimTokensApi(page, { seed: [OKTA], groupsMode: "groups" });
    await page.goto("/scim-tokens");
    await expect(page.locator("[data-scim-groups-mode='groups']")).toHaveText(
      SCIM_GROUPS_MODE_GROUPS_LINE,
    );
    await expect(page.locator("[data-scim-groups-mode]")).toHaveCount(1);
    await expectNoBlockingAxeViolations(page);

    const second = await page.context().newPage();
    await installScimTokensApi(second, { seed: [OKTA], groupsMode: "workspaces" });
    await second.goto("/scim-tokens");
    await expect(second.locator("[data-scim-groups-mode='workspaces']")).toHaveText(
      SCIM_GROUPS_MODE_WORKSPACES_LINE,
    );
    await expect(second.getByRole("button", { name: "Create token" })).toBeEnabled();
    await second.close();
  });
});
