import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  installOperatorApi,
  OPERATOR_FAILED_EXECUTION_ID,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";
import { MANUAL_START_INPUT_HELP } from "../src/lib/manual-start-contract.ts";

/**
 * The runs inbox, the run page, and the Start panel say things in plain
 * words: no routes, CSRF, HTTP codes, permission keys, API fields, or
 * tracker ids.
 */

const VERSION_ID = "44444444-4444-4444-8444-444444444444";

const PERMISSIONS = [
  "workflow.view",
  "workflow.edit",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "execution.cancel",
  "approval.view",
  "approval.decide",
] as const;

const DEVELOPER_TEXT =
  /\b(?:GET|POST|PUT|PATCH) \/|CSRF|Idempotency-Key|HTTP \d{3}|\(\d{3}\)|\b(?:is|returns) (?:200|201|400|403|409)\b|workflow\.execute|execution\.(?:view|cancel)|approval\.(?:decide|view)|script\.emergencyStop|capabilities\.|result\.retry|workflowVersionId|workflowId|ops-config|fail-closed|fails closed|contract bug|#\d+|\b[ER]\d+\.\d+\b|E5\/E8\/E9|Chloe UI|[Tt]his UI|\/executions\/\{|\/workflows\/\{|jonny/;

const PAGE_HELP =
  "Runs in this workspace. Open a run to see each step on the graph, its output, and its artifacts.";
const INBOX_HELP =
  "Filter runs by status or workflow, then open one to see its steps. Cancel, Retry, and Stop are on each row when they apply. A waiting run continues once someone approves or rejects it. Drafts never run, and secrets show as [redacted].";
const EMPTY_HELP =
  "Start a published version from the workflow page or the panel below. Starting again with the same idempotency key opens the existing run, and the same key with different input starts nothing. Drafts never run.";
const RETRY_CONFLICT = "This execution can't be retried.";
const START_CONFLICT =
  "The run wasn't started. This idempotency key was already used with different input, or this start needs approval first.";

function controlPlanePath(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  const match = /^\/api\/(?:v1|control-plane)(\/.*)$/.exec(pathname);
  return match ? match[1] : null;
}

/** Answer matching GETs; everything else falls back to the operator API. */
async function fulfillJson(page: Page, matches: (path: string, url: URL) => unknown) {
  await page.route(
    (url) => {
      const path = controlPlanePath(url.toString());
      return path !== null && matches(path, url) !== undefined;
    },
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(matches(controlPlanePath(url.toString()) ?? "", url)),
      });
    },
  );
}

/** Answer one POST with an RFC 9457 problem. */
async function failPost(
  page: Page,
  matches: (path: string) => boolean,
  status: number,
  code: string,
) {
  await page.route(
    (url) => {
      const path = controlPlanePath(url.toString());
      return path !== null && matches(path);
    },
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const path = controlPlanePath(route.request().url()) ?? "";
      await route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: `urn:flowforge:problem:${code}`,
          title: "Not allowed",
          status,
          detail: "The request was refused.",
          instance: path,
          code,
          request_id: "req-e2e-624",
        }),
      });
    },
  );
}

/**
 * The operator API answers every POST with 405, which would put a raw
 * ProblemBanner (out of scope here) into the pre-run policy review.
 */
async function allowPolicy(page: Page) {
  await page.route(
    (url) => controlPlanePath(url.toString()) === "/policy/evaluate",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ decision: "allow", requirements: [], denied: [] }),
      });
    },
  );
}

async function expectNoDeveloperText(region: Locator): Promise<void> {
  const text = (await region.innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(DEVELOPER_TEXT);
}

async function expectNoTitles(region: Locator): Promise<void> {
  await expect(region.locator("[title]")).toHaveCount(0);
}

test.describe("runs inbox", () => {
  test("the header and filters are plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await page.goto("/executions");
    await expect(page.getByRole("heading", { level: 1, name: "Executions" })).toBeVisible();
    const header = page.locator("main > header");
    await expect(header).toHaveText(new RegExp(`Executions\\s*${escape(PAGE_HELP)}`));
    await expect(header.locator("code")).toHaveCount(0);
    await expectNoTitles(header);
    const main = page.locator("main");
    await expect(main.getByText(INBOX_HELP)).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Workspace executions" })
        .getByRole("listitem")
        .filter({ hasText: "Deploy" }),
    ).toBeVisible();
    await expectNoDeveloperText(main);
    await expect(main.locator("code")).toHaveCount(0);
    // Rows carry buttons, so the inbox is a plain list, not a listbox (#634 F3).
    const listbox = page.getByRole("list", { name: "Workspace executions" });
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(listbox).not.toContainText("/executions/{id}");
    await expectNoBlockingAxeViolations(page);
  });

  test("the empty state is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await fulfillJson(page, (path) => (path === "/executions" ? { items: [] } : undefined));
    await page.goto("/executions");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "No executions yet" })).toBeVisible();
    await expect(main.getByText(EMPTY_HELP)).toBeVisible();
    await expect(main.getByRole("link", { name: "Start a run" })).toBeVisible();
    await expectNoDeveloperText(main);
    await expectNoTitles(main);
    await expectNoBlockingAxeViolations(page);
  });
});

test("runs inbox rows that show Cancel, Retry and Approve have no axe violations (#634 F3)", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  const base = {
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: "Deploy",
    workflowSlug: "deploy",
    workflowVersionId: VERSION_ID,
    workflowVersionNumber: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:01:00.000Z",
    startedAt: "2026-09-01T12:00:00.000Z",
    permittedActions: ["view"],
  };
  const RUNNING_ID = "77777777-7777-4777-8777-777777777771";
  const WAITING_ID = "77777777-7777-4777-8777-777777777772";
  await fulfillJson(page, (path) =>
    path === "/executions"
      ? {
          items: [
            { ...base, id: RUNNING_ID, status: "running" },
            { ...base, id: WAITING_ID, status: "waiting" },
            {
              ...base,
              id: OPERATOR_FAILED_EXECUTION_ID,
              status: "failed",
              finishedAt: "2026-09-01T12:01:00.000Z",
            },
          ],
        }
      : undefined,
  );
  await page.goto("/executions");
  const listbox = page.getByRole("list", { name: "Workspace executions" });
  await expect(listbox.getByRole("listitem")).toHaveCount(3);
  const actions = listbox.locator("[data-execution-operate-action], [data-execution-decide-action], li button");
  await expect(listbox.getByRole("button", { name: "Cancel" }).first()).toBeVisible();
  await expect(listbox.getByRole("button", { name: /^Retry/ }).first()).toBeVisible();
  await expect(listbox.getByRole("button", { name: /Approve/ }).first()).toBeVisible();
  expect(await actions.count()).toBeGreaterThan(0);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);
});

test("the run page and its retry conflict are plain", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  // A 403 on retry is covered in run-retry-forbidden.spec.ts (#630).
  await failPost(page, (path) => path.endsWith("/retry"), 409, "conflict");
  await page.goto(`/executions/${OPERATOR_FAILED_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Steps", level: 2 })).toBeVisible();
  await expect(main.getByText("No config pins on this run.")).toBeVisible();
  await expect(main.getByText("No ops-config pins on this execution.")).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Artifacts", level: 2 })).toBeVisible();
  await expect(
    main.getByText(
      "Each download uses a short-lived link that works once. FlowForge checks your access on every download and never saves the link.",
    ),
  ).toBeVisible();
  await expect(
    main.getByText(
      "Worker jobs for this run, with their lease and heartbeat details when available. Worker secrets are never shown.",
    ),
  ).toBeVisible();
  // Landmarks are named once each (#634 F4).
  await expect(page.getByRole("region", { name: "Graph replay" })).toHaveCount(1);
  await expectNoDeveloperText(main);
  await expect(main.locator("code")).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);

  await main.getByRole("button", { name: "Retry execution" }).click();
  await expect(main.getByText(RETRY_CONFLICT).first()).toBeVisible();
  // The API's ProblemBanner sits next to it and is out of scope (#623), so
  // only the run page's own copy is checked here.
  await expectNoBlockingAxeViolations(page);
});

test("the Start panel's conflict message is plain", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await allowPolicy(page);
  await fulfillJson(page, (path) =>
    path === `/workflows/${OPERATOR_WORKFLOW_ID}/versions`
      ? {
          items: [
            {
              id: VERSION_ID,
              workflowId: OPERATOR_WORKFLOW_ID,
              versionNumber: 1,
              digest: "sha256:e2e-published",
              publishedAt: "2026-09-01T12:00:00.000Z",
            },
          ],
        }
      : undefined,
  );
  await failPost(
    page,
    (path) => path === `/workflows/${OPERATOR_WORKFLOW_ID}/executions`,
    409,
    "conflict",
  );
  await page.goto(`/workflows?start=${OPERATOR_WORKFLOW_ID}`);
  const panel = page.locator("section[aria-labelledby='manual-start-heading']");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("Only published versions can run. Drafts and unsaved changes never run."),
  ).toBeVisible();
  const version = panel.locator("select").first();
  if ((await version.inputValue()) === "") {
    await version.selectOption(VERSION_ID);
  }
  const start = panel.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeEnabled();
  // The input hint shows once (#634 L-b).
  await expect(panel.getByText(MANUAL_START_INPUT_HELP)).toHaveCount(1);
  await expectNoDeveloperText(panel);
  await expectNoTitles(panel);
  await start.click();
  await expect(panel.getByText(START_CONFLICT)).toBeVisible();
  await expectNoDeveloperText(panel);
  await expectNoBlockingAxeViolations(page);
});

test("the editor's Start dialog stays plain", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await allowPolicy(page);
  await fulfillJson(page, (path) =>
    path === `/workflows/${OPERATOR_WORKFLOW_ID}/versions`
      ? {
          items: [
            {
              id: VERSION_ID,
              workflowId: OPERATOR_WORKFLOW_ID,
              versionNumber: 1,
              digest: "sha256:e2e-published",
              publishedAt: "2026-09-01T12:00:00.000Z",
            },
          ],
        }
      : undefined,
  );
  await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
  const start = page.getByRole("button", { name: "Start published" });
  await expect(start).toBeEnabled();
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Start published" });
  await expect(dialog).toBeVisible();
  const version = dialog.locator("select").first();
  if ((await version.inputValue()) === "") {
    await version.selectOption(VERSION_ID);
  }
  await expect(dialog.getByRole("heading", { name: "Pre-run review" })).toBeVisible();
  await expectNoDeveloperText(dialog);
  await expectNoTitles(dialog);
  await expectNoBlockingAxeViolations(page);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
