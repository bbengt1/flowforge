import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { expectNoSecretsInBrowserStorage, installOperatorApi } from "./operator-api";
import { expectDocumentRtl, installDocumentRtl } from "./rtl";
import {
  WORKFLOW_SLUG_CONFLICT_MESSAGE,
  WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE,
} from "../src/lib/workflow-delete.ts";
import { WORKFLOW_SLUG_PREVIEW_HINT } from "../src/lib/workflow-slug.ts";

const SHOTS = "/opt/cursor/artifacts/screenshots";
const CREATED_ID = "33333333-3333-4333-8333-333333333333";

type CreateMode = "created" | "reserved" | "conflict";

function problem(path: string, code: string, detail: string) {
  return {
    type: "about:blank",
    title: "Conflict",
    status: 409,
    detail,
    instance: path,
    code,
    request_id: "e2e-slug",
    errors: [{ path: "slug", code, message: detail }],
  };
}

function createdBody(name: string) {
  return {
    workflow: {
      id: CREATED_ID,
      slug: "from-server",
      name,
      status: "draft",
      draftRevision: 1,
    },
    draft: {
      workflowId: CREATED_ID,
      revision: 1,
      definitionYaml: `apiVersion: flowforge/v1\nkind: Workflow\nmetadata:\n  name: ${name}\n  slug: from-server\n`,
      digest: "sha256:e2e-draft",
      summary: {
        apiVersion: "flowforge/v1",
        name,
        triggers: [],
        nodes: [],
        edges: [],
        outputs: [],
      },
      warnings: [],
    },
  };
}

async function installCreateApi(page: Page, mode: CreateMode): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  await installOperatorApi(page);
  await page.route(/\/api\/(?:v1|control-plane)\/workflows\/?$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    bodies.push(readJsonBody(route));
    const path = "/workflows";
    if (mode === "reserved") {
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify(
          problem(
            path,
            "workflow_slug_reserved",
            "please parse this sentence instead of the code",
          ),
        ),
      });
      return;
    }
    if (mode === "conflict") {
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify(
          problem(path, "conflict", "A workflow with this slug already exists."),
        ),
      });
      return;
    }
    const name = typeof bodies.at(-1)?.name === "string" ? bodies.at(-1)?.name : "Workflow";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(createdBody(String(name))),
    });
  });
  return bodies;
}

function readJsonBody(route: Route): Record<string, unknown> {
  const raw = route.request().postData();
  if (!raw) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function assertNameOnlyBody(body: Record<string, unknown>, name: string): void {
  expect(body.name).toBe(name);
  expect(body).not.toHaveProperty("slug");
  expect(typeof body.definitionYaml).toBe("string");
  expect(String(body.definitionYaml)).not.toMatch(/^\s*slug\s*:/m);
}

async function openCreateForm(page: Page): Promise<void> {
  await page.goto("/workflows");
  await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
  await expect(page.locator("#home-create-name")).toBeVisible();
}

test.describe("workflow create slug preview", () => {
  test("an unedited preview is not sent, including a second name-only create", async ({
    page,
  }) => {
    const bodies = await installCreateApi(page, "created");
    await openCreateForm(page);
    await page.locator("#home-create-name").fill("Redeploy API");
    const slug = page.locator("#home-create-slug");
    await expect(slug).toHaveValue("redeploy-api");
    await expect(slug).toHaveAttribute("data-slug-preview", "true");
    await expect(page.getByText(WORKFLOW_SLUG_PREVIEW_HINT)).toBeVisible();
    mkdirSync(SHOTS, { recursive: true });
    await page.locator("[data-workflow-create-form]").screenshot({
      path: `${SHOTS}/workflow-create-slug-preview.png`,
    });
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);

    await page.locator("[data-o1='create']").click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${CREATED_ID}$`));
    expect(bodies).toHaveLength(1);
    assertNameOnlyBody(bodies[0]!, "Redeploy API");

    await page.goto("/workflows");
    await page.locator("#home-create-name").fill("Deploy Again");
    await expect(page.locator("#home-create-slug")).toHaveValue("deploy-again");
    await page.locator("[data-o1='create']").click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${CREATED_ID}$`));
    expect(bodies).toHaveLength(2);
    assertNameOnlyBody(bodies[1]!, "Deploy Again");
  });

  test("reserved and slug-conflict errors land on the Slug field", async ({ page }) => {
    const reservedBodies = await installCreateApi(page, "reserved");
    await openCreateForm(page);
    await page.locator("#home-create-name").fill("Redeploy");
    await expect(page.locator("#home-create-slug")).toHaveValue("redeploy");
    await page.locator("[data-o1='create']").click();
    const reserved = page.locator("#home-create-slug-error");
    await expect(reserved).toHaveText(WORKFLOW_SLUG_RESERVED_SLUG_MESSAGE);
    await expect(page.locator("#home-create-slug")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#home-create-slug")).toHaveAttribute(
      "data-workflow-create-error",
      "workflow_slug_reserved",
    );
    await expect(page.locator("#home-create-name-error")).toHaveCount(0);
    await expect(page.locator("#home-create-name")).not.toHaveAttribute("aria-invalid", "true");
    expect(reservedBodies).toHaveLength(1);
    assertNameOnlyBody(reservedBodies[0]!, "Redeploy");

    const conflictBodies = await installCreateApi(page, "conflict");
    await page.goto("/workflows");
    await page.locator("#home-create-name").fill("Second Name");
    await page.locator("[data-o1='create']").click();
    await expect(page.locator("#home-create-slug-error")).toHaveText(
      WORKFLOW_SLUG_CONFLICT_MESSAGE,
    );
    await expect(page.locator("#home-create-name-error")).toHaveCount(0);
    expect(conflictBodies).toHaveLength(1);
    assertNameOnlyBody(conflictBodies[0]!, "Second Name");
    await expectNoBlockingAxeViolations(page);
  });

  test("rtl keeps the slug preview labeled and axe-clean", async ({ page, baseURL }) => {
    await installDocumentRtl(page, baseURL ?? "http://127.0.0.1:3100");
    await installCreateApi(page, "created");
    await openCreateForm(page);
    await expectDocumentRtl(page);
    await page.locator("#home-create-name").fill("9 lives");
    const slug = page.locator("#home-create-slug");
    await expect(slug).toHaveValue("w-9-lives");
    await expect(slug).toHaveAttribute("dir", "ltr");
    await page.locator("label[for='home-create-slug'] span").first().click();
    await expect(slug).toBeFocused();
    await expectNoBlockingAxeViolations(page);
    await expectNoSecretsInBrowserStorage(page);
  });
});
