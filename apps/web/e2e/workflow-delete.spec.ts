import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installOperatorApi, OPERATOR_WORKFLOW_ID } from "./operator-api";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SHOTS = "/opt/cursor/artifacts/screenshots";

const ACTIVE_MESSAGE =
  "Queued or running executions must finish or be cancelled before this workflow can be deleted. Delete does not cancel them.";
const MISLEADING_DETAIL = "please parse this sentence instead of the code";

const VIEWER_PERMISSIONS = [
  "workflow.view",
  "credential.view",
  "execution.view",
  "approval.view",
] as const;

type DeleteMode = "ok" | "active" | "missing";

type DeleteImpactBody = {
  waitingRuns: number;
  blocked: boolean;
  inFlightRuns: number;
};

function problem(path: string, status: number, code: string, detail: string) {
  return {
    type: "about:blank",
    title: status === 409 ? "Conflict" : "Not Found",
    status,
    detail,
    instance: path,
    code,
    request_id: "e2e",
  };
}

function workflowBody(canDelete: boolean, deleteImpact?: DeleteImpactBody) {
  return {
    id: OPERATOR_WORKFLOW_ID,
    slug: "deploy",
    name: "Deploy",
    status: "published",
    draftRevision: 1,
    capabilities: { delete: canDelete },
    ...(deleteImpact ? { deleteImpact } : {}),
  };
}

async function installDeleteApi(
  page: Page,
  options: {
    canDelete: boolean;
    mode?: DeleteMode;
    permissions?: readonly string[];
    embed?: boolean;
    deleteImpact?: DeleteImpactBody;
  },
): Promise<void> {
  await installOperatorApi(page, { permissions: options.permissions });
  let deleted = options.mode === "missing";
  await page.route(/\/api\/(?:v1|control-plane)\//, async (route) => {
    const handled = await fulfillDelete(route, {
      canDelete: options.canDelete,
      mode: options.mode ?? "ok",
      embed: options.embed === true,
      deleteImpact: options.deleteImpact,
      deleted: () => deleted,
      markDeleted: () => {
        deleted = true;
      },
    });
    if (!handled) {
      await route.fallback();
    }
  });
}

async function fulfillDelete(
  route: Route,
  state: {
    canDelete: boolean;
    mode: DeleteMode;
    embed: boolean;
    deleteImpact?: DeleteImpactBody;
    deleted: () => boolean;
    markDeleted: () => void;
  },
): Promise<boolean> {
  const url = new URL(route.request().url());
  const path = url.pathname.replace(/^\/api\/(?:v1|control-plane)/, "");
  const method = route.request().method();
  const workflowPath = `/workflows/${OPERATOR_WORKFLOW_ID}`;

  if (state.embed && method === "GET" && path === "/session") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        csrf_token: "e2e-csrf",
        principal: {
          id: "88888888-8888-4888-8888-888888888888",
          issuer: "https://flowforge.local",
          external_subject: "operator-ada",
          display_name: "Ada Operator",
          status: "active",
        },
        session: {
          id: "99999999-9999-4999-8999-999999999999",
          idle_expires_at: "2099-01-01T00:00:00.000Z",
          absolute_expires_at: "2099-01-01T12:00:00.000Z",
          must_change_password: false,
          embed: {
            mode: "embed",
            sdk: "embed.v1",
            tenantId: TENANT_ID,
            tenantSlug: "acme",
            tenantName: "Acme",
            workbenchKey: "ops",
            workspaceId: WORKSPACE_ID,
            workspaceName: "Ops",
            capabilities: ["workflow.view", "workflow.edit", "workflow.delete"],
          },
        },
      }),
    });
    return true;
  }

  if (method === "DELETE" && path === workflowPath) {
    if (state.mode === "active") {
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify(
          problem(
            path,
            409,
            "workflow_has_active_executions",
            MISLEADING_DETAIL,
          ),
        ),
      });
      return true;
    }
    state.markDeleted();
    await route.fulfill({ status: 204, body: "" });
    return true;
  }

  if (method === "GET" && (path === "/workflows" || path === "/workflows/")) {
    const items = state.deleted()
      ? []
      : [
          workflowBody(
            state.canDelete,
            state.embed ? state.deleteImpact : undefined,
          ),
        ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items }),
    });
    return true;
  }

  if (method === "GET" && path === workflowPath) {
    if (state.deleted()) {
      await route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify(problem(path, 404, "not-found", "missing")),
      });
      return true;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(workflowBody(state.canDelete, state.deleteImpact)),
    });
    return true;
  }

  return false;
}

function workflowCard(page: Page) {
  return page.locator('[data-x3-kind="workflow"]').filter({ hasText: "Deploy" });
}

async function openConfirmFromContextMenu(page: Page): Promise<void> {
  await workflowCard(page).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Explorer actions" });
  await expect(menu).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await menu.screenshot({ path: `${SHOTS}/delete-context-menu.png` });
  await menu.getByRole("menuitem", { name: "Delete workflow" }).click();
}

async function confirmDelete(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Delete workflow" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("unpublishes the workflow");
  await expect(dialog).toContainText("turns off its triggers");
  await dialog.getByLabel("Type Deploy to confirm").fill("Deploy");
  await dialog.getByRole("button", { name: "Delete workflow" }).click();
}

test.describe("delete workflow", () => {
  test("an editor deletes from the Explorer context menu", async ({ page }) => {
    await installDeleteApi(page, { canDelete: true });
    await page.goto("/workflows");
    const card = workflowCard(page);
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('[data-workflow-delete="selection"]')).toBeVisible();
    await openConfirmFromContextMenu(page);
    const dialog = page.getByRole("dialog", { name: "Delete workflow" });
    mkdirSync(SHOTS, { recursive: true });
    await dialog.screenshot({ path: `${SHOTS}/delete-confirm-dialog.png` });
    await dialog.getByLabel("Type Deploy to confirm").fill("Deploy");
    await dialog.getByRole("button", { name: "Delete workflow" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(page.getByText("Workflow deleted")).toBeVisible();
  });

  test("an editor deletes from the editor overflow and leaves the editor", async ({
    page,
  }) => {
    await installDeleteApi(page, { canDelete: true });
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete workflow" }).click();
    await confirmDelete(page);
    await expect(page).toHaveURL(/\/workflows\/?$/);
    await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
    await expect(page.getByText("Workflow deleted")).toBeVisible();
    await expect(workflowCard(page)).toHaveCount(0);
  });

  test("a viewer sees no delete action", async ({ page }) => {
    await installDeleteApi(page, {
      canDelete: false,
      permissions: VIEWER_PERMISSIONS,
    });
    await page.goto("/workflows");
    const card = workflowCard(page);
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator("[data-workflow-delete]")).toHaveCount(0);
    await card.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Delete workflow" })).toHaveCount(0);
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(page.locator("[data-workflow-delete]")).toHaveCount(0);
  });

  test("a 409 active-executions code keeps the dialog open", async ({ page }) => {
    await installDeleteApi(page, { canDelete: true, mode: "active" });
    await page.goto("/workflows");
    await expect(workflowCard(page)).toBeVisible();
    await openConfirmFromContextMenu(page);
    const dialog = page.getByRole("dialog", { name: "Delete workflow" });
    await dialog.getByLabel("Type Deploy to confirm").fill("Deploy");
    await dialog.getByRole("button", { name: "Delete workflow" }).click();
    await expect(dialog).toBeVisible();
    const alert = dialog.locator('[data-workflow-delete="active-executions"]');
    await expect(alert).toHaveText(ACTIVE_MESSAGE);
    await expect(dialog).not.toContainText(MISLEADING_DETAIL);
    await expect(workflowCard(page)).toBeVisible();
    mkdirSync(SHOTS, { recursive: true });
    await dialog.screenshot({ path: `${SHOTS}/delete-active-executions.png` });
  });

  test("parked runs are named in the confirm dialog", async ({ page }) => {
    await installDeleteApi(page, {
      canDelete: true,
      deleteImpact: { waitingRuns: 2, blocked: false, inFlightRuns: 0 },
    });
    await page.goto("/workflows");
    await expect(workflowCard(page)).toBeVisible();
    await openConfirmFromContextMenu(page);
    const dialog = page.getByRole("dialog", { name: "Delete workflow" });
    await expect(dialog).toContainText(
      "2 runs waiting on an approval or a delay will be stopped and marked failed.",
    );
    await dialog.getByLabel("Type Deploy to confirm").fill("Deploy");
    await expect(dialog.getByRole("button", { name: "Delete workflow" })).toBeEnabled();
  });

  test("in-flight runs disable delete confirm", async ({ page }) => {
    await installDeleteApi(page, {
      canDelete: true,
      deleteImpact: { waitingRuns: 0, blocked: true, inFlightRuns: 1 },
    });
    await page.goto("/workflows");
    await expect(workflowCard(page)).toBeVisible();
    await openConfirmFromContextMenu(page);
    const dialog = page.getByRole("dialog", { name: "Delete workflow" });
    await expect(dialog).toContainText(
      "This workflow can't be deleted while 1 run is still running or queued.",
    );
    await dialog.getByLabel("Type Deploy to confirm").fill("Deploy");
    await expect(dialog.getByRole("button", { name: "Delete workflow" })).toBeDisabled();
  });

  test("embed never shows delete, even when the flag is true", async ({ page }) => {
    await installDeleteApi(page, {
      canDelete: true,
      embed: true,
      deleteImpact: { waitingRuns: 2, blocked: false, inFlightRuns: 0 },
    });
    const listed = page.waitForResponse((response) => {
      if (response.request().method() !== "GET" || !response.ok()) {
        return false;
      }
      const path = new URL(response.url()).pathname.replace(
        /^\/api\/(?:v1|control-plane)/,
        "",
      );
      return path === "/workflows" || path === "/workflows/";
    });
    await page.goto("/embed/v1/workflows");
    const listBody = (await (await listed).json()) as {
      items?: { capabilities?: { delete?: boolean } }[];
    };
    expect(listBody.items?.[0]?.capabilities?.delete).toBe(true);
    await expect(workflowCard(page)).toBeVisible();
    await expect(page.locator("[data-workflow-delete]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete workflow" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Delete workflow" })).toHaveCount(0);
    await workflowCard(page).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Delete workflow" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const actions = page.locator('[data-o1="kebab"] summary');
    await expect(actions).toHaveAttribute("aria-label", "Workflow actions");
    await actions.click();
    await expect(page.locator('[data-workflow-delete="list"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete workflow" })).toHaveCount(0);

    const flagged = page.waitForResponse(async (response) => {
      if (response.request().method() !== "GET" || !response.ok()) {
        return false;
      }
      const path = new URL(response.url()).pathname.replace(
        /^\/api\/(?:v1|control-plane)/,
        "",
      );
      if (
        path !== `/workflows/${OPERATOR_WORKFLOW_ID}` &&
        path !== "/workflows" &&
        path !== "/workflows/"
      ) {
        return false;
      }
      const body = (await response.json()) as {
        capabilities?: { delete?: boolean };
        items?: { id?: string; capabilities?: { delete?: boolean } }[];
      };
      if (path === `/workflows/${OPERATOR_WORKFLOW_ID}`) {
        return body.capabilities?.delete === true;
      }
      return (
        body.items?.some(
          (item) =>
            item.id === OPERATOR_WORKFLOW_ID && item.capabilities?.delete === true,
        ) === true
      );
    });
    await page.goto(`/embed/v1/workflows/${OPERATOR_WORKFLOW_ID}`);
    expect(await flagged).toBeTruthy();
    await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(page.locator("[data-workflow-delete]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete workflow" })).toHaveCount(0);
    await expect(page.getByText(/will be stopped/)).toHaveCount(0);
    await expect(page.getByText("waitingRuns")).toHaveCount(0);
    await expect(page.getByText("inFlightRuns")).toHaveCount(0);
  });

  test("a deep link to a deleted workflow uses the not-found boundary", async ({
    page,
  }) => {
    await installDeleteApi(page, { canDelete: true, mode: "missing" });
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  });
});
