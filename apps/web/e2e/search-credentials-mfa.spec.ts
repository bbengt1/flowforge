import { expect, test, type Page, type Request } from "@playwright/test";
import { installOperatorApi } from "./operator-api";

/**
 * The search bar lists credentials in the background on every page. For
 * an admin who hasn't stepped up, that read answers 403 mfa-required; it
 * must not open the step-up prompt by itself. Opening the credentials
 * page still asks for step-up.
 */

const CREDENTIALS_LIST = /\/api\/(?:v1|control-plane)\/credentials(?:\?|$)/;
const EXECUTIONS_LIST = /\/api\/(?:v1|control-plane)\/executions(?:\?|$)/;

function isCredentialsList(request: Request): boolean {
  return CREDENTIALS_LIST.test(new URL(request.url()).pathname + new URL(request.url()).search);
}

async function requireMfaForCredentials(page: Page): Promise<{ count: () => number }> {
  let count = 0;
  await page.route(CREDENTIALS_LIST, async (route) => {
    count += 1;
    await route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:flowforge:problem:mfa-required",
        title: "MFA Required",
        status: 403,
        detail: "Verify MFA before using this permission.",
        instance: "/api/v1/credentials",
        code: "mfa-required",
        request_id: "req-mfa-credentials",
      }),
    });
  });
  return { count: () => count };
}

function stepUpDialog(page: Page) {
  return page.getByRole("dialog", { name: "Multi-factor authentication" });
}

test.describe("search bar credentials and MFA step-up", () => {
  for (const path of ["/executions", "/groups", "/workflows"]) {
    test(`no step-up prompt on ${path} before stepping up`, async ({ page }) => {
      await installOperatorApi(page);
      const credentials = await requireMfaForCredentials(page);
      const credentialsRead = page.waitForResponse((response) =>
        isCredentialsList(response.request()),
      );
      // The search bar reads executions only after the credentials read
      // has settled, so this proves the mfa-required answer was handled.
      const executionsRead = page.waitForRequest((request) =>
        EXECUTIONS_LIST.test(new URL(request.url()).pathname + new URL(request.url()).search),
      );
      await page.goto(path);
      expect((await credentialsRead).status()).toBe(403);
      await executionsRead;

      const search = page.getByRole("combobox", { name: "Search workspace" });
      await search.fill("prod-k8s");
      const results = page.getByRole("listbox", { name: "Search results" });
      await expect(results).toBeVisible();
      await expect(results.getByText("prod-k8s")).toHaveCount(0);

      await expect(stepUpDialog(page)).toHaveCount(0);
      expect(credentials.count()).toBeGreaterThan(0);
      await expect(page.getByRole("alert").filter({ hasText: /credential/i })).toHaveCount(0);
    });
  }

  test("opening the credentials page still asks for step-up", async ({ page }) => {
    await installOperatorApi(page);
    await requireMfaForCredentials(page);
    await page.goto("/credentials");
    await expect(stepUpDialog(page)).toBeVisible();
  });
});
