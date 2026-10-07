import { expect, test, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  expectNoSecretsInBrowserStorage,
  installOperatorApi,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";

const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const REQUESTER_ID = "99999999-9999-4999-8999-999999999999";
const OVERRIDE_ID = "b1111111-1111-4111-8111-111111111111";
const TARGET_ID = "b2222222-2222-4222-8222-222222222222";
const UNTARGETED_ID = "b3333333-3333-4333-8333-333333333333";
const CLOSED_ID = "b4444444-4444-4444-8444-444444444444";
const USER_ADA = "c1111111-1111-4111-8111-111111111111";
const GROUP_NAMED = "d1111111-1111-4111-8111-111111111111";
const GROUP_UNNAMED = "d2222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "6d6d6d6d-1111-4111-8111-111111111111";
const GATE_STEP_ID = "e5555555-5555-4555-8555-555555555555";

const DECIDE_PERMISSIONS = [
  "workflow.view",
  "workflow.edit",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "approval.view",
  "approval.decide",
] as const;

const NOT_TARGETED =
  "You're not one of the named approvers for this step, so you can't decide it.";
const NO_ELIGIBLE_RUN =
  "No one other than the requester can approve this step, so it failed right away.";
const NO_ELIGIBLE_CLOSE =
  "Closed because no one other than the requester could approve it.";

function isControlPlane(url: string, suffix: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  return (
    pathname === `/api/v1${suffix}` || pathname === `/api/control-plane${suffix}`
  );
}

function approvalPath(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  const match = /^\/api\/(?:v1|control-plane)(\/approvals(?:\/.*)?)$/.exec(pathname);
  return match ? match[1] : null;
}

function targetedApproval(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    status: "pending",
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: name,
    requestedBy: REQUESTER_ID,
    requestedAt: "2026-10-01T12:00:00.000Z",
    approverRole: "approver",
    binding: {
      workflowVersionId: VERSION_ID,
      operation: "workflow.execute",
      nodeId: "gate",
      expiresAt: "2099-01-01T00:00:00Z",
    },
    validity: { current: true, reason: "pending" },
    permittedActions: ["approve", "reject"],
    approvers: {
      users: [{ id: USER_ADA, displayName: "Ada Approver" }],
      groups: [
        {
          id: GROUP_NAMED,
          displayName: "Release managers",
          members: [{ id: REQUESTER_ID, displayName: "Hidden Member" }],
        },
        { id: GROUP_UNNAMED, displayName: "" },
      ],
    },
    ...extra,
  };
}

async function installApprovals(
  page: Page,
  approvals: Record<string, unknown>[],
  onDecide: (id: string, body: unknown) => { status: number; body: unknown },
) {
  await installOperatorApi(page, { permissions: DECIDE_PERMISSIONS });
  await page.route(
    (url) => approvalPath(url.toString()) !== null,
    async (route) => {
      const path = approvalPath(route.request().url()) ?? "";
      const method = route.request().method();
      const decide = /^\/approvals\/([^/]+)\/decide$/.exec(path);
      if (decide && method === "POST") {
        const result = onDecide(decide[1], route.request().postDataJSON());
        await route.fulfill({
          status: result.status,
          contentType:
            result.status >= 400 ? "application/problem+json" : "application/json",
          body: JSON.stringify(result.body),
        });
        return;
      }
      if (method !== "GET" || path === "/approvals/catalog") {
        await route.fallback();
        return;
      }
      if (path === "/approvals") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: approvals }),
        });
        return;
      }
      const found = approvals.find((item) => path === `/approvals/${item.id}`);
      if (found) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(found),
        });
        return;
      }
      await route.fallback();
    },
  );
}

test("approval detail lists people and groups, and an admin override needs a confirm", async ({
  page,
}) => {
  const decides: unknown[] = [];
  const approval = targetedApproval(OVERRIDE_ID, "Override gate", {
    capabilities: { decide: { allowed: true, via: "admin_override" } },
  });
  await installApprovals(page, [approval], (_id, body) => {
    decides.push(body);
    return {
      status: 200,
      body: { ...approval, status: "approved", capabilities: { decide: { allowed: false, code: "not_pending" } } },
    };
  });

  await page.goto(`/approvals/${OVERRIDE_ID}`);
  const approvers = page.locator("[data-approval-approvers]");
  await expect(approvers.getByRole("heading", { name: "Approvers" })).toBeVisible();
  const people = approvers.locator('[data-approval-approvers-set="users"]');
  const groups = approvers.locator('[data-approval-approvers-set="groups"]');
  await expect(people.getByText("People")).toBeVisible();
  await expect(people.getByText("Ada Approver")).toBeVisible();
  await expect(groups.getByText("Groups")).toBeVisible();
  await expect(groups.getByText("Release managers")).toBeVisible();
  await expect(groups.getByText(GROUP_UNNAMED)).toBeVisible();
  await expect(page.getByText("Hidden Member")).toHaveCount(0);

  const override = page.locator("[data-approval-override]");
  await expect(override.getByText("Admin override", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Decide as an admin override?" });
  await expect(dialog).toBeVisible();
  await expectNoBlockingAxeViolations(page);
  expect(decides).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(decides).toEqual([]);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Decide as an admin override?" })
    .getByRole("button", { name: "Approve as override" })
    .click();
  await expect.poll(() => decides.length).toBe(1);
  expect(decides[0]).toMatchObject({ decision: "approved" });
  await expectNoSecretsInBrowserStorage(page);
});

test("a named approver decides with no extra step", async ({ page }) => {
  const decides: unknown[] = [];
  const approval = targetedApproval(TARGET_ID, "Target gate", {
    capabilities: { decide: { allowed: true, via: "target" } },
  });
  await installApprovals(page, [approval], (_id, body) => {
    decides.push(body);
    return { status: 200, body: { ...approval, status: "rejected" } };
  });

  await page.goto(`/approvals/${TARGET_ID}`);
  await expect(page.locator("[data-approval-approvers]")).toBeVisible();
  await expect(page.locator("[data-approval-override]")).toHaveCount(0);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect.poll(() => decides.length).toBe(1);
  expect(decides[0]).toMatchObject({ decision: "rejected" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a user who isn't a named approver sees a plain sentence", async ({ page }) => {
  const denied = targetedApproval(UNTARGETED_ID, "Not mine", {
    capabilities: { decide: { allowed: false, code: "approver_not_targeted" } },
  });
  await installApprovals(page, [denied], () => ({ status: 500, body: {} }));
  await page.goto(`/approvals/${UNTARGETED_ID}`);
  await expect(page.locator("[data-approval-not-targeted]")).toHaveText(NOT_TARGETED);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByText("approver_not_targeted")).toHaveCount(0);
});

test("a 403 approver_not_targeted on decide maps to the same sentence", async ({ page }) => {
  const stale = targetedApproval(UNTARGETED_ID, "Stale gate");
  await installApprovals(page, [stale], () => ({
    status: 403,
    body: {
      type: "urn:flowforge:problem:approver_not_targeted",
      title: "Forbidden",
      status: 403,
      detail: "You are not a named approver for this approval.",
      instance: `/approvals/${UNTARGETED_ID}/decide`,
      code: "approver_not_targeted",
      request_id: "req-not-targeted",
    },
  }));
  await page.goto(`/approvals/${UNTARGETED_ID}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(NOT_TARGETED).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("pending list tags gates the user can only decide as an admin override", async ({
  page,
}) => {
  await installApprovals(
    page,
    [
      targetedApproval(OVERRIDE_ID, "Override gate", {
        capabilities: { decide: { allowed: true, via: "admin_override" } },
      }),
      targetedApproval(TARGET_ID, "Target gate", {
        capabilities: { decide: { allowed: true, via: "target" } },
      }),
    ],
    () => ({ status: 500, body: {} }),
  );
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  const overrideRow = page.locator("li").filter({ hasText: "Override gate" });
  const targetRow = page.locator("li").filter({ hasText: "Target gate" });
  await expect(overrideRow.locator("[data-approval-override-tag]")).toHaveText("Admin override");
  await expect(targetRow.locator("[data-approval-override-tag]")).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);
});

test("a closed approval explains no_eligible_decider in plain words", async ({ page }) => {
  const closed = targetedApproval(CLOSED_ID, "Closed gate", {
    status: "canceled",
    closeReason: "requirement_unresolvable",
    closeReasonDetails: { cause: "no_eligible_decider" },
    validity: { current: false },
    permittedActions: ["view"],
  });
  await installApprovals(page, [closed], () => ({ status: 500, body: {} }));
  await page.goto(`/approvals/${CLOSED_ID}`);
  await expect(page.getByText(NO_ELIGIBLE_CLOSE).first()).toBeVisible();
  await expect(page.getByText("no_eligible_decider")).toHaveCount(0);
});

test("run page says no one other than the requester can approve", async ({ page }) => {
  await installOperatorApi(page);
  const detail = {
    id: EXECUTION_ID,
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: "Deploy",
    workflowSlug: "deploy",
    workflowVersionId: VERSION_ID,
    workflowVersionNumber: 1,
    status: "failed",
    statusReason: "requirement_unresolvable",
    statusReasonDetails: { cause: "no_eligible_decider" },
    createdAt: "2026-10-01T12:00:00.000Z",
    startedAt: "2026-10-01T12:00:00.000Z",
    finishedAt: "2026-10-01T12:00:01.000Z",
    permittedActions: ["view"],
    jobs: [],
    auditEvents: [],
    artifacts: [],
    steps: [
      {
        id: GATE_STEP_ID,
        nodeId: "gate",
        nodeType: "flow.approval",
        attempt: 1,
        status: "failed",
        error: {
          code: "requirement_unresolvable",
          message: "No eligible decider.",
          details: { cause: "no_eligible_decider" },
        },
      },
    ],
  };
  // The re-parked gate's earlier approval row can be canceled with no cause.
  const canceled = {
    ...targetedApproval(CLOSED_ID, "Deploy"),
    status: "canceled",
    executionId: EXECUTION_ID,
    executionStatus: "failed",
    closeReason: "requirement_unresolvable",
    validity: { current: false },
    permittedActions: ["view"],
  };
  await page.route(
    (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/$/, "");
      return (
        path === `/api/v1/executions/${EXECUTION_ID}` ||
        path === `/api/control-plane/executions/${EXECUTION_ID}` ||
        path.endsWith("/logs") ||
        (isControlPlane(url.toString(), "/approvals") &&
          parsed.searchParams.get("executionId") === EXECUTION_ID)
      );
    },
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/logs")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ lines: [] }),
        });
        return;
      }
      if (path.includes("/approvals")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [canceled] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
    },
  );
  await page.goto(`/executions/${EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  await expect(page.getByText(NO_ELIGIBLE_RUN).first()).toBeVisible();
  await expect(page.getByText("no_eligible_decider")).toHaveCount(0);
  await expect(page.getByText(NO_ELIGIBLE_CLOSE)).toHaveCount(0);
});
