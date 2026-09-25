import { expect, test, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { installOperatorApi, OPERATOR_WORKFLOW_ID } from "./operator-api";

const LONG_NAME =
  "Quarterly platform deploy across every production region and disaster-recovery site";

const VIEWER_PERMISSIONS = [
  "workflow.view",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "approval.view",
] as const;

async function installLongWorkflowName(page: Page): Promise<void> {
  await page.route(
    /\/api\/(?:v1|control-plane)\/workflows\/33333333-3333-4333-8333-333333333333$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: OPERATOR_WORKFLOW_ID,
          slug: "deploy",
          name: LONG_NAME,
          status: "draft",
          draftRevision: 1,
        }),
      });
    },
  );
}

async function expectNoTopBarOverflow(page: Page): Promise<void> {
  const metrics = await page.locator('[data-editor-context="sticky"]').evaluate((el) => {
    const bar = el.getBoundingClientRect();
    let maxRight = bar.right;
    let minLeft = bar.left;
    for (const node of el.querySelectorAll("a, button, input, h1, p")) {
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        continue;
      }
      maxRight = Math.max(maxRight, box.right);
      minLeft = Math.min(minLeft, box.left);
    }
    const view = document.documentElement.clientWidth;
    return {
      scroll: el.scrollWidth - el.clientWidth,
      pastBar: Math.max(0, maxRight - bar.right),
      pastViewport: Math.max(0, maxRight - view),
      beforeViewport: Math.max(0, -minLeft),
    };
  });
  expect(metrics.scroll).toBeLessThanOrEqual(1);
  expect(metrics.pastBar).toBeLessThanOrEqual(1);
  expect(metrics.pastViewport).toBeLessThanOrEqual(1);
  expect(metrics.beforeViewport).toBeLessThanOrEqual(1);
}

async function expectControlInViewport(page: Page, name: string | RegExp): Promise<void> {
  const button = page.locator('[data-editor-context="sticky"]').getByRole("button", {
    name,
    exact: typeof name === "string",
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.width).toBeGreaterThan(8);
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(viewport!.height);
}

test.describe("editor top bar", () => {
  test("keeps the workflow name visible at 1280, 1440, and 1680", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await installLongWorkflowName(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);

    const name = page.locator('[data-editor-workflow-name="heading"]');
    await expect(name).toBeVisible();
    await expect(name).toHaveAttribute("title", LONG_NAME);
    await expect(
      page.locator('[data-editor-topbar="identity"]').getByText("deploy", { exact: true }),
    ).toBeVisible();

    for (const width of [1280, 1440, 1680]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(name).toBeVisible();
      const box = await name.boundingBox();
      expect(box, `name button at ${width}px`).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(100);
      await expectNoTopBarOverflow(page);
      for (const label of ["Save draft", "Add action", "Start published", "Test run"] as const) {
        await expectControlInViewport(page, label);
      }
      await expectControlInViewport(page, /library/i);
      await expectControlInViewport(page, /undo/i);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await name.click();
    const input = page.locator('[data-editor-workflow-name="rename"]');
    await expect(input).toBeVisible();
    const clicked = await input.boundingBox();
    expect(clicked).not.toBeNull();
    expect(clicked!.width).toBeGreaterThanOrEqual(100);
    await expectNoTopBarOverflow(page);
    await page.keyboard.press("Escape");
    await expect(name).toBeVisible();

    await name.focus();
    await page.keyboard.press("Enter");
    await expect(input).toBeVisible();
    const keyed = await input.boundingBox();
    expect(keyed).not.toBeNull();
    expect(keyed!.width).toBeGreaterThanOrEqual(100);
    await expectNoTopBarOverflow(page);
    await page.keyboard.press("Escape");
    await expect(name).toBeVisible();
    await expectNoBlockingAxeViolations(page);
  });

  test("viewer mode shows the workflow name as plain text", async ({ page }) => {
    await installOperatorApi(page, { permissions: VIEWER_PERMISSIONS });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);

    await expect(page.locator('[data-editor-workflow-name="heading"]')).toHaveCount(0);
    await expect(page.locator('[data-editor-workflow-name="rename"]')).toHaveCount(0);
    const heading = page.getByRole("heading", { level: 1, name: "Deploy" });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveAttribute("title", "Deploy");
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    await expectNoTopBarOverflow(page);
    await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
  });
});
