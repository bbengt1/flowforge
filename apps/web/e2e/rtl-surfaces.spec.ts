import { expect, test, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  expectNoSecretsInBrowserStorage,
  installOperatorApi,
  installSignedOutApi,
  OPERATOR_EXECUTION_ID,
  OPERATOR_FOLDER_NAME,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";
import {
  expectAnchoredToInlineStart,
  expectDocumentRtl,
  expectFirstChildAtInlineStart,
  expectHorizontallyCentered,
  expectHugsInlineStart,
  installDocumentRtl,
} from "./rtl";

const ADV021_ALERT =
  "This embed has no FlowForge-bound session. GET /session did not return session.embed. Host identity and catalog values are not chrome authority. Exchange a host assertion.";

test.beforeEach(async ({ page, baseURL }) => {
  await installDocumentRtl(page, baseURL ?? "http://127.0.0.1:3100");
});

async function expectRtlShell(page: Page): Promise<void> {
  await expectDocumentRtl(page);
  await expect(page.locator("main")).toHaveCount(1);
  const aside = page.getByRole("complementary", {
    name: "Workspace navigation",
  });
  await expectAnchoredToInlineStart(aside, page);
  const edges = await aside.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      inlineEnd: style.borderInlineEndWidth,
      inlineStart: style.borderInlineStartWidth,
    };
  });
  expect(edges.inlineEnd).toBe("1px");
  expect(edges.inlineStart).toBe("0px");
  const search = page.getByRole("combobox", { name: "Search workspace" });
  const commands = page.getByRole("button", { name: "Commands" });
  const searchBox = await search.boundingBox();
  const commandsBox = await commands.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(commandsBox).not.toBeNull();
  if (searchBox && commandsBox) {
    expect(searchBox.x).toBeGreaterThan(commandsBox.x);
  }
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await skip.focus();
  await expectAnchoredToInlineStart(skip, page);
}

test.describe("RTL primary surfaces", () => {
  test("login Field keeps label association and inline-start text", async ({
    page,
  }) => {
    await installSignedOutApi(page);
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeVisible();
    await expectDocumentRtl(page);
    await expect(page.locator("main")).toHaveCount(1);

    const identifier = page.locator("#login-identifier");
    const identifierLabel = page.locator("label[for='login-identifier']");
    await identifierLabel.locator("span").first().click();
    await expect(identifier).toBeFocused();
    await expect(identifier).toHaveAttribute("id", "login-identifier");
    await expectHugsInlineStart(identifierLabel.locator("span").first());

    const password = page.locator("#login-password");
    await page.locator("label[for='login-password'] span").first().click();
    await expect(password).toBeFocused();
    await expect(page.getByLabel("Password")).toBeVisible();

    const skip = page.getByRole("link", { name: "Skip to main content" });
    await skip.focus();
    await expectAnchoredToInlineStart(skip, page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("workflow home anchors the shell and opens ConfirmDestructive", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto("/workflows");
    await expect(
      page.getByRole("heading", { level: 1, name: "Workflows" }),
    ).toBeVisible();
    await expect(page.getByText("Deploy", { exact: true })).toBeVisible();
    await expectRtlShell(page);

    const folder = page.getByRole("button", { name: OPERATOR_FOLDER_NAME });
    await expectFirstChildAtInlineStart(folder);
    const unfiled = page.locator("[data-home-folder-rail='unfiled']");
    const virtual = unfiled.locator("[data-x4='unfiled-virtual']");
    const unfiledBox = await unfiled.boundingBox();
    const virtualBox = await virtual.boundingBox();
    expect(unfiledBox).not.toBeNull();
    expect(virtualBox).not.toBeNull();
    if (unfiledBox && virtualBox) {
      expect(virtualBox.x + virtualBox.width / 2).toBeLessThan(
        unfiledBox.x + unfiledBox.width / 2,
      );
    }

    await folder.click();
    await expect(page.getByText("Nothing in this folder.")).toBeVisible();
    const remove = page.getByRole("button", { name: "Delete folder" });
    await expect(remove).toBeEnabled();
    await remove.click();

    const dialog = page.getByRole("dialog", { name: "Delete folder" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const impact = dialog.getByRole("list", { name: "What this will affect" });
    await expect(impact).toBeVisible();
    await expect(impact.getByText(OPERATOR_FOLDER_NAME)).toBeVisible();
    await expect(impact.getByText("None in this folder.")).toBeVisible();
    await expect(
      dialog.locator("[data-confirm-destructive-undo='true']"),
    ).toBeVisible();
    await expectHugsInlineStart(impact.getByText("Folder", { exact: true }));
    await expectHorizontallyCentered(
      dialog.locator("[data-confirm-destructive='dialog']"),
      page,
    );
    const actions = dialog.locator("[data-confirm-destructive='actions']");
    const cancel = actions.getByRole("button", { name: "Cancel" });
    const confirm = actions.getByRole("button", { name: "Delete folder" });
    await expect(cancel).toBeFocused();
    const cancelBox = await cancel.boundingBox();
    const confirmBox = await confirm.boundingBox();
    expect(cancelBox).not.toBeNull();
    expect(confirmBox).not.toBeNull();
    if (cancelBox && confirmBox) {
      expect(cancelBox.x).toBeGreaterThan(confirmBox.x + confirmBox.width - 4);
    }
    const chrome = await dialog.innerText();
    expect(chrome).not.toMatch(/BEGIN |PRIVATE KEY|password|kubeconfig/i);

    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    const navInert = await page.evaluate(() => {
      const nav = document.getElementById("workspace-nav");
      return Boolean(nav?.closest("[inert]"));
    });
    expect(navInert).toBe(true);

    await expectNoBlockingAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeFocused();
    await expectNoSecretsInBrowserStorage(page);
  });

  test("credential vault lists display name and uuid under rtl", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto("/credentials");
    await expect(
      page.getByRole("heading", { level: 1, name: "Credential vault" }),
    ).toBeVisible();
    await expect(page.getByText("Loading credentials…")).toHaveCount(0);
    const name = page.getByText("prod-k8s");
    await expect(name).toBeVisible();
    await expect(page.getByText("55555555-5555-4555-8555-555555555555")).toBeVisible();
    await expectHugsInlineStart(page.getByRole("heading", { level: 1 }));
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/BEGIN |PRIVATE KEY|kubeconfig|password/i);
    await expectRtlShell(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("executions inbox keeps rtl shell chrome", async ({ page }) => {
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
    await expectHugsInlineStart(page.getByRole("heading", { level: 1 }));
    await expectRtlShell(page);
    await expectNoBlockingAxeViolations(page);
  });

  test("run view keeps blocked, pending, and skipped under rtl", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto(
      `/executions/${OPERATOR_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Execution" }),
    ).toBeVisible();
    const rollback = page.locator("[data-canvas-node='rollback']");
    await expect(rollback).toContainText("Skipped");
    await expect(rollback).not.toContainText("Valid");
    await expect(page.getByRole("status", { name: /Blocked/ })).toBeVisible();
    await expect(page.getByRole("status", { name: /Pending/ }).first()).toBeVisible();
    await expect(page.getByRole("status", { name: /Skipped/ }).first()).toBeVisible();
    const blockedEdges = await page
      .getByRole("status", { name: /Blocked/ })
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          inlineStart: style.borderInlineStartWidth,
          inlineEnd: style.borderInlineEndWidth,
        };
      });
    expect(blockedEdges.inlineStart).toBe("3px");
    expect(blockedEdges.inlineEnd).toBe("1px");
    await expectHugsInlineStart(page.getByRole("heading", { level: 1 }));
    await expectRtlShell(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("approvals list keeps rtl shell chrome", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/approvals");
    await expect(
      page.getByRole("heading", { level: 1, name: "Approvals" }),
    ).toBeVisible();
    await expect(page.getByText("to list approvals.")).toHaveCount(0);
    await expect(page.getByText("deploy").first()).toBeVisible();
    await expectHugsInlineStart(page.getByRole("heading", { level: 1 }));
    await expectRtlShell(page);
    await expectNoBlockingAxeViolations(page);
  });

  test("editor dialog traps focus and returns it under rtl", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    await expect(
      page.getByRole("application", { name: "Workflow canvas" }),
    ).toBeVisible();
    await expectRtlShell(page);
    await expectNoBlockingAxeViolations(page);

    const commands = page.getByRole("button", { name: "Commands" });
    await commands.click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const filter = page.getByLabel("Filter commands");
    await expect(filter).toBeFocused();
    await expect(filter).toHaveAttribute("id", "command-palette-filter");
    await expectHorizontallyCentered(dialog.locator(".ff-shell-panel"), page);
    const option = dialog.getByRole("option").first().locator("span").first();
    await expectHugsInlineStart(option);
    await expectNoBlockingAxeViolations(page);

    await page.keyboard.press("Tab");
    const tabInside = await page.evaluate(() => {
      const root = document.getElementById("command-palette-dialog");
      return Boolean(root?.contains(document.activeElement));
    });
    expect(tabInside).toBe(true);
    await filter.focus();
    await page.keyboard.press("Shift+Tab");
    const shiftInside = await page.evaluate(() => {
      const root = document.getElementById("command-palette-dialog");
      return Boolean(root?.contains(document.activeElement));
    });
    expect(shiftInside).toBe(true);
    const navInert = await page.evaluate(() => {
      const nav = document.getElementById("workspace-nav");
      return Boolean(nav?.closest("[inert]"));
    });
    expect(navInert).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(commands).toBeFocused();
    await expectNoSecretsInBrowserStorage(page);
  });
});

test.describe("RTL embed cold path", () => {
  test("ADV-021 only: no wizard, Login, or Change-password", async ({
    page,
  }) => {
    await installSignedOutApi(page);
    await page.goto("/embed/v1");
    await expectDocumentRtl(page);
    const adv021 = page.getByRole("alert").filter({ hasText: "session.embed" });
    await expect(adv021).toHaveCount(2);
    await expect(adv021.first()).toHaveText(ADV021_ALERT);
    await expect(
      page.getByRole("heading", { level: 1, name: "Exchange a host assertion" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Change password" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Set up this FlowForge instance" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await expect(page.getByText("Checking first-run setup…")).toHaveCount(0);

    const brand = page.getByRole("link", { name: "FlowForge embed" });
    const chip = page.getByLabel("No session");
    const viewport = page.viewportSize();
    const brandBox = await brand.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(viewport).not.toBeNull();
    expect(brandBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    if (viewport && brandBox && chipBox) {
      expect(viewport.width - (brandBox.x + brandBox.width)).toBeLessThan(40);
      expect(chipBox.x).toBeLessThan(brandBox.x);
      expect(chipBox.x).toBeLessThan(viewport.width / 2);
    }

    await expect(page.locator("main")).toHaveCount(1);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });
});
