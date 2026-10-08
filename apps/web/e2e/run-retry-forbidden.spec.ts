import { expect, test, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  installOperatorApi,
  OPERATOR_FAILED_EXECUTION_ID,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";

/**
 * #630: a refused Retry keeps the run page on screen and says why next to
 * the button. Only a refusal to load the run itself shows the forbidden
 * view.
 */

const PERMISSIONS = [
  "workflow.view",
  "workflow.execute",
  "execution.view",
  "execution.cancel",
  "approval.view",
] as const;

const RETRY_FORBIDDEN = "Your role can't retry runs. No new attempt was started.";
const RUN_PATH = `/executions/${OPERATOR_FAILED_EXECUTION_ID}`;
const RUN_URL = `${RUN_PATH}?workflowId=${OPERATOR_WORKFLOW_ID}`;

function controlPlanePath(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  const match = /^\/api\/(?:v1|control-plane)(\/.*)$/.exec(pathname);
  return match ? match[1] : null;
}

function problemBody(path: string, status: number, code: string) {
  return JSON.stringify({
    type: `urn:flowforge:problem:${code}`,
    title: "Forbidden",
    status,
    detail: "The request was refused.",
    instance: path,
    code,
    request_id: "req-e2e-630",
  });
}

/** Answer matching requests of one method with an RFC 9457 problem. */
async function refuse(
  page: Page,
  method: "GET" | "POST",
  matches: (path: string) => boolean,
  code = "forbidden",
) {
  await page.route(
    (url) => {
      const path = controlPlanePath(url.toString());
      return path !== null && matches(path);
    },
    async (route) => {
      if (route.request().method() !== method) {
        await route.fallback();
        return;
      }
      const path = controlPlanePath(route.request().url()) ?? "";
      await route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        body: problemBody(path, 403, code),
      });
    },
  );
}

async function openRun(page: Page) {
  await page.goto(RUN_URL);
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Steps", level: 2 })).toBeVisible();
  return main;
}

async function expectRunPageStays(page: Page) {
  const main = page.locator("main");
  await expect(main.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  await expect(main.getByText(OPERATOR_FAILED_EXECUTION_ID, { exact: true })).toBeVisible();
  await expect(main.getByText("Version pin")).toBeVisible();
  await expect(main.getByRole("heading", { name: "Steps", level: 2 })).toBeVisible();
  await expect(main.getByRole("button", { name: "Retry execution" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Retry step" })).toBeVisible();
}

test("a refused run retry keeps the run page and says why inline", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await refuse(page, "POST", (path) => path === `${RUN_PATH}/retry`);
  const main = await openRun(page);

  await main.getByRole("button", { name: "Retry execution" }).click();
  const sentence = main.getByRole("status").filter({ hasText: RETRY_FORBIDDEN });
  await expect(sentence).toHaveCount(1);
  await expect(sentence).toBeVisible();
  await expectRunPageStays(page);
  // The sentence carries the refusal. No banner and no forbidden view.
  await expect(page.locator("#execution-errors [role='alert']")).toHaveCount(0);
  await expect(main.getByText("(403)")).toHaveCount(0);
  // It sits in the run header, next to the Retry button.
  const header = main
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "Retry execution" }) });
  await expect(header.getByText(RETRY_FORBIDDEN)).toBeVisible();
  await expectNoBlockingAxeViolations(page);
});

test("a refused step retry keeps the run page and says why next to the step", async ({
  page,
}) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await refuse(page, "POST", (path) => /\/steps\/[^/]+\/retry$/.test(path));
  const main = await openRun(page);

  const retryStep = main.getByRole("button", { name: "Retry step" });
  await retryStep.click();
  const item = main
    .locator("li")
    .filter({ has: page.getByRole("button", { name: "Retry step" }) });
  await expect(item.getByRole("status").filter({ hasText: RETRY_FORBIDDEN })).toBeVisible();
  await expect(main.getByText(RETRY_FORBIDDEN)).toHaveCount(1);
  await expectRunPageStays(page);
  await expect(page.locator("#execution-errors [role='alert']")).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);
});

test("a session check on retry keeps the run page and shows its notice", async ({
  page,
}) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await refuse(page, "POST", (path) => path === `${RUN_PATH}/retry`, "csrf-invalid");
  const main = await openRun(page);

  await main.getByRole("button", { name: "Retry execution" }).click();
  await expect(page.locator("#execution-errors [role='alert']")).toBeVisible();
  await expectRunPageStays(page);
  // Not a role refusal, so the role sentence stays away.
  await expect(main.getByText(RETRY_FORBIDDEN)).toHaveCount(0);
});

test("a refusal to load the run still shows the forbidden view", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await refuse(page, "GET", (path) => path === RUN_PATH);
  await page.goto(RUN_URL);
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  const banner = page.locator("#execution-errors [role='alert']");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("(403)");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Steps", level: 2 })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Retry execution" })).toHaveCount(0);
  await expect(main.getByText(RETRY_FORBIDDEN)).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);
});
