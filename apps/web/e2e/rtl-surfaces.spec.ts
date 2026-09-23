import { expect, test, type Page } from "@playwright/test";
import { DOCUMENT_DIRECTION_HEADER } from "../src/lib/document-direction";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  expectNoSecretsInBrowserStorage,
  installOperatorApi,
  installSignedOutApi,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";
import {
  expectDocumentRtl,
  expectFieldWorksInRtl,
  expectFocusInside,
  expectMirroredShell,
  expectOnInlineStartSide,
  expectPageBehindInert,
  expectTextOnInlineStart,
} from "./rtl";

const ADV021_ALERT =
  "This embed has no FlowForge-bound session. GET /session did not return session.embed. Host identity and catalog values are not chrome authority. Exchange a host assertion.";

const FOLDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

test.use({
  extraHTTPHeaders: { [DOCUMENT_DIRECTION_HEADER]: "rtl" },
});

async function installEmptyFolder(page: Page): Promise<void> {
  await installOperatorApi(page);
  await page.route(/\/api\/(?:v1|control-plane)\/workflow-folders/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: FOLDER_ID,
            workspaceId: WORKSPACE_ID,
            parentId: null,
            name: "Ops notes",
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route(/\/api\/(?:v1|control-plane)\/workflows/, async (route) => {
    const folderId = new URL(route.request().url()).searchParams.get("folderId");
    if (folderId !== FOLDER_ID) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });
}

test.describe("RTL primary surfaces", () => {
  test("login Field stays associated under dir=rtl", async ({ page }) => {
    await installSignedOutApi(page);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expectDocumentRtl(page);
    await expectFieldWorksInRtl(page, "Email or username", "login-identifier");
    await expectFieldWorksInRtl(page, "Password", "login-password");
    await expect(page.locator("main")).toHaveCount(1);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("workflow home mirrors, and ConfirmDestructive previews impact", async ({
    page,
  }) => {
    await installEmptyFolder(page);
    await page.goto(`/workflows?folder=${FOLDER_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
    await expect(page.getByText("before listing workflows.")).toHaveCount(0);
    await expectMirroredShell(page);
    await expectFieldWorksInRtl(page, "Filter folders", "home-folder-rail-filter");

    const tree = page.locator("[data-x1='folder-tree']");
    const pane = page.locator("[data-x1='content-pane']");
    await expectOnInlineStartSide(tree, pane);
    const treeBorder = await tree.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderInlineEndWidth),
    );
    expect(treeBorder).toBeGreaterThan(0);

    const folder = page.locator("[data-home-folder-rail='folder']");
    await expect(folder).toBeVisible();
    const icon = await folder.locator("svg").boundingBox();
    const name = await folder.locator("span").boundingBox();
    if (!icon || !name) {
      throw new Error("folder row did not lay out an icon and a name");
    }
    expect(icon.x).toBeGreaterThan(name.x);

    const deleteFolder = page.getByRole("button", { name: "Delete folder" });
    await expect(page.getByRole("heading", { name: "Nothing in this folder." })).toBeVisible();
    await expect(deleteFolder).toBeEnabled();
    await deleteFolder.click();

    const dialog = page.getByRole("dialog", { name: "Delete folder" });
    await expect(dialog).toBeVisible();
    const direction = await dialog.evaluate((element) => getComputedStyle(element).direction);
    expect(direction).toBe("rtl");
    const panel = dialog.locator("[data-confirm-destructive='dialog']");
    await expect(panel).toHaveAttribute("data-confirm-destructive-undo", "true");
    await expect(page.locator("[data-confirm-destructive='undo']")).toHaveCount(0);
    await expect(dialog.getByText("You can undo this for a few seconds after confirming.")).toBeVisible();
    const impact = dialog.getByRole("list", { name: "What this will affect" });
    await expect(impact.getByText("Ops notes")).toBeVisible();
    await expectTextOnInlineStart(impact.locator("li").first());
    const dialogText = await dialog.innerText();
    expect(dialogText).not.toMatch(/password|BEGIN |PRIVATE KEY|kubeconfig/i);

    const actions = dialog.locator("[data-confirm-destructive='actions']");
    const cancel = actions.getByRole("button", { name: "Cancel" });
    const confirm = actions.getByRole("button", { name: "Delete folder" });
    await expect(cancel).toBeFocused();
    const cancelBox = await cancel.boundingBox();
    const confirmBox = await confirm.boundingBox();
    if (!cancelBox || !confirmBox) {
      throw new Error("confirm actions did not lay out");
    }
    expect(cancelBox.x).toBeGreaterThan(confirmBox.x);
    expect(Math.abs(cancelBox.y - confirmBox.y)).toBeLessThan(8);

    await expectPageBehindInert(page, true);
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await expectFocusInside(dialog);
    await page.keyboard.press("Shift+Tab");
    await expect(confirm).toBeFocused();
    await expectFocusInside(dialog);

    await expectNoBlockingAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(deleteFolder).toBeFocused();
    await expectPageBehindInert(page, false);
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
    await expectMirroredShell(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("executions inbox settles under dir=rtl", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/executions");
    await expect(page.getByRole("heading", { level: 1, name: "Executions" })).toBeVisible();
    await expect(page.getByText("before listing executions.")).toHaveCount(0);
    await expect(
      page.getByRole("listbox", { name: "Workspace executions" }).getByRole("option", { name: /Deploy/ }),
    ).toBeVisible();
    await expectMirroredShell(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("approvals list settles under dir=rtl", async ({ page }) => {
    await installOperatorApi(page);
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
    await expect(page.getByText("to list approvals.")).toHaveCount(0);
    await expect(page.getByText("deploy").first()).toBeVisible();
    await expectMirroredShell(page);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });

  test("editor canvas stays physical and the command palette traps focus", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    const canvas = page.getByRole("application", { name: "Workflow canvas" });
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute("dir", "ltr");
    await expectMirroredShell(page);
    await expectNoBlockingAxeViolations(page);

    const commands = page.getByRole("button", { name: "Commands" });
    await commands.click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const direction = await dialog.evaluate((element) => getComputedStyle(element).direction);
    expect(direction).toBe("rtl");
    const filter = page.getByLabel("Filter commands");
    await expect(filter).toHaveAttribute("id", "command-palette-filter");
    await expect(filter).toBeFocused();
    const filterDirection = await filter.evaluate((element) => getComputedStyle(element).direction);
    expect(filterDirection).toBe("rtl");
    const option = dialog.getByRole("option").first();
    await expect(option).toBeVisible();
    const align = await option.evaluate((element) => getComputedStyle(element).textAlign);
    expect(["start", "right"]).toContain(align);

    await page.keyboard.press("Shift+Tab");
    await expect(filter).not.toBeFocused();
    await expectFocusInside(dialog);
    await page.keyboard.press("Tab");
    await expect(filter).toBeFocused();
    await page.evaluate(() => document.getElementById("command-palette-trigger")?.focus());
    await expectFocusInside(dialog);
    await expectPageBehindInert(page, true);

    await expectNoBlockingAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(commands).toBeFocused();
    await expectPageBehindInert(page, false);
    await expectNoSecretsInBrowserStorage(page);
  });
});

test.describe("RTL embed cold path", () => {
  test("ADV-021 only: no wizard, Login, or Change-password", async ({ page }) => {
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
    await expect(page.getByRole("heading", { name: "Change password" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Set up this FlowForge instance" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await expect(page.getByText("Checking first-run setup…")).toHaveCount(0);
    await expect(page.locator("main")).toHaveCount(1);
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });
});
