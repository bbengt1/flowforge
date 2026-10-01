import { expect, test } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  expectNoSecretsInBrowserStorage,
  installOperatorApi,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";
import { expectDocumentRtl, installDocumentRtl } from "./rtl";

const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const DELETED_EXECUTION_ID = "6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d";

const REASONS = [
  {
    id: "a1111111-1111-4111-8111-111111111111",
    closeReason: "requirement_unresolvable",
    sentence: "Closed because no one eligible could decide it.",
    name: "Unresolvable gate",
  },
  {
    id: "a2222222-2222-4222-8222-222222222222",
    closeReason: "workflow_deleted",
    sentence: "Closed because the workflow was deleted.",
    name: "Deleted workflow gate",
  },
  {
    id: "a3333333-3333-4333-8333-333333333333",
    closeReason: "run_canceled",
    sentence: "Closed because the run was canceled.",
    name: "Canceled run gate",
  },
] as const;

function closedApproval(
  id: string,
  name: string,
  closeReason: string,
) {
  return {
    id,
    status: "canceled",
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: name,
    closeReason,
    requestedBy: "operator-ada",
    requestedAt: "2026-09-01T12:00:00.000Z",
    binding: {
      workflowVersionId: VERSION_ID,
      operation: "deploy",
    },
    validity: { current: false },
  };
}

function isControlPlane(url: string, suffix: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  return (
    pathname === `/api/v1${suffix}` ||
    pathname === `/api/control-plane${suffix}`
  );
}

test("closed approvals show each close reason as text", async ({ page, baseURL }) => {
  await installDocumentRtl(page, baseURL ?? "http://127.0.0.1:3100");
  await installOperatorApi(page);
  await page.route(
    (url) => isControlPlane(url.toString(), "/approvals"),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            ...REASONS.map((reason) =>
              closedApproval(reason.id, reason.name, reason.closeReason),
            ),
            closedApproval(
              "a4444444-4444-4444-8444-444444444444",
              "Unknown reason gate",
              "not-a-published-reason",
            ),
          ],
        }),
      });
    },
  );
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/approvals");
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  await expectDocumentRtl(page);
  await page.getByLabel("Status").selectOption({ label: "All" });
  for (const reason of REASONS) {
    const row = page.locator("li").filter({ hasText: reason.name });
    await expect(row.getByText("Closed", { exact: true })).toBeVisible();
    await expect(row.getByText(reason.sentence)).toBeVisible();
    await expect(row.getByText(reason.closeReason)).toHaveCount(0);
  }
  const unknown = page.locator("li").filter({ hasText: "Unknown reason gate" });
  await expect(unknown.getByText("Closed", { exact: true })).toBeVisible();
  await expect(unknown.getByText("not-a-published-reason")).toHaveCount(0);
  await expect(page.locator("main")).toHaveCount(1);
  await expectNoBlockingAxeViolations(page);
  await expectNoSecretsInBrowserStorage(page);
  expect(consoleErrors.filter((line) => /not-a-published-reason/.test(line))).toEqual([]);
});

test("a deleted run does not fetch the pinned version", async ({ page }) => {
  await installOperatorApi(page);
  const versionRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/versions/")) {
      versionRequests.push(request.url());
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.route(
    (url) => isControlPlane(url.toString(), `/executions/${DELETED_EXECUTION_ID}`),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(deletedExecution()),
      });
    },
  );

  await page.goto(
    `/executions/${DELETED_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  await expect(
    page.getByText("This workflow was deleted, so its graph is no longer available."),
  ).toBeVisible();
  expect(versionRequests).toEqual([]);
  expect(
    consoleErrors.filter((line) => /versions|404/i.test(line)),
  ).toEqual([]);
  await expectNoBlockingAxeViolations(page);
});

function deletedExecution() {
  return {
    id: DELETED_EXECUTION_ID,
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    workflowName: "Deploy",
    status: "failed",
    statusReason: "workflow_deleted",
    createdAt: "2026-09-01T12:00:00.000Z",
    finishedAt: "2026-09-01T12:00:06.000Z",
    capabilities: {
      retry: {
        allowed: false,
        code: "execution_not_retryable",
        reason: "workflow_deleted",
      },
    },
    steps: [
      {
        id: "b1111111-1111-4111-8111-111111111111",
        nodeId: "gate",
        nodeType: "flow.approval",
        attempt: 1,
        status: "canceled",
      },
    ],
    jobs: [],
    auditEvents: [],
    artifacts: [],
  };
}
