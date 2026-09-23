import { expect, test, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  expectNoSecretsInBrowserStorage,
  installOperatorApi,
  installSignedOutApi,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";

const ADV021_ALERT =
  "This embed has no FlowForge-bound session. GET /session did not return session.embed. Host identity and catalog values are not chrome authority. Exchange a host assertion.";

async function expectOneMain(page: Page): Promise<void> {
  await expect(page.locator("main")).toHaveCount(1);
}

async function expectSkipLink(page: Page): Promise<void> {
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toHaveAttribute("href", "#main-content");
}

test.describe("primary surfaces", () => {
  test("login chrome is labeled and has no serious axe findings", async ({
    page,
  }) => {
    await installSignedOutApi(page);
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expectSkipLink(page);
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("workflow home settles before axe", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/workflows");
    await expect(
      page.getByRole("heading", { level: 1, name: "Workflows" }),
    ).toBeVisible();
    await expect(page.getByText("before listing workflows.")).toHaveCount(0);
    await expect(page.getByText("Deploy", { exact: true })).toBeVisible();
    await expectSkipLink(page);
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("credential vault lists display name and uuid only", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/credentials");
    await expect(
      page.getByRole("heading", { level: 1, name: "Credential vault" }),
    ).toBeVisible();
    await expect(page.getByText("Loading credentials…")).toHaveCount(0);
    await expect(page.getByText("prod-k8s")).toBeVisible();
    await expect(page.getByText("55555555-5555-4555-8555-555555555555")).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/BEGIN |PRIVATE KEY|kubeconfig|password/i);
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("executions inbox settles before axe", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/executions");
    await expect(
      page.getByRole("heading", { level: 1, name: "Executions" }),
    ).toBeVisible();
    await expect(page.getByText("before listing executions.")).toHaveCount(0);
    await expect(
      page
        .getByRole("listbox", { name: "Workspace executions" })
        .getByRole("option", { name: /Deploy/ }),
    ).toBeVisible();
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);
  });

  test("approvals list settles before axe", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/approvals");
    await expect(
      page.getByRole("heading", { level: 1, name: "Approvals" }),
    ).toBeVisible();
    await expect(page.getByText("to list approvals.")).toHaveCount(0);
    await expect(page.getByText("deploy").first()).toBeVisible();
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);
  });

  test("editor canvas is named and the command palette traps focus", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    await expect(
      page.getByRole("application", { name: "Workflow canvas" }),
    ).toBeVisible();
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);

    const commands = page.getByRole("button", { name: "Commands" });
    await commands.click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Filter commands")).toBeVisible();
    await expectNoBlockingAxeViolations(page);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(commands).toBeFocused();
  });
});

test.describe("embed cold path", () => {
  test("ADV-021 only: no wizard, Login, or Change-password", async ({
    page,
  }) => {
    await installSignedOutApi(page);
    await page.goto("/embed/v1");
    const adv021 = page.getByRole("alert").filter({ hasText: "session.embed" });
    await expect(adv021).toHaveCount(2);
    await expect(adv021.first()).toHaveText(ADV021_ALERT);
    await expect(
      page.getByRole("heading", { level: 1, name: "Exchange a host assertion" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Sign in" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Change password" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Set up this FlowForge instance" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await expect(page.getByText("Checking first-run setup…")).toHaveCount(0);
    await expectOneMain(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });
});
