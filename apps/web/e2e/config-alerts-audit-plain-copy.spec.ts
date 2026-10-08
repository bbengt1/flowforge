import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { installOperatorApi, OPERATOR_WORKFLOW_ID } from "./operator-api";

/**
 * Config, alerts, audit, credentials, and the shared problem banner say
 * things in plain words: no routes, CSRF, HTTP codes, permission keys,
 * request_id, tracker ids, or "Chloe UI".
 */

const CREDENTIAL_ID = "55555555-5555-4555-8555-555555555555";
const ALERT_ID = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

const PERMISSIONS = [
  "workflow.view",
  "workflow.edit",
  "workflow.publish",
  "workflow.execute",
  "credential.view",
  "execution.view",
  "approval.view",
  "alert.view",
  "alert.ack",
  "opsconfig.view",
  "opsconfig.edit",
] as const;

const DEVELOPER_TEXT =
  /\b(?:GET|POST|PUT|PATCH|DELETE) \/|CSRF|If-Match|problem\+json|HTTP \d{3}|\(\d{3}\)|\b(?:is|returns) (?:200|201|400|403|404|409)\b|\b(?:alert|audit|credential|opsconfig|workflow|execution)\.(?:view|ack|manage|edit|execute|use)\b|usePermission|request_id|fail-closed|fails? closed|failed closed|contract bug|#\d+|\b[ER]\d+\.\d+\b|Chloe UI|[Tt]his UI|\/credentials\/\{|\/alerts\/\{|jonny/;

const CONFIG_PAGE_HELP =
  "Targets, profiles, connections, templates, schemas, and policies for this workspace. Save a draft as often as you like, then publish it to make a fixed version that workflows use. Cluster targets connect to Kubernetes, SSH targets connect to hosts by their known fingerprint, and command profiles are fixed command templates, not a terminal. Keys and kubeconfigs stay in the credentials vault.";
const CONFIG_KIND_PAGE_HELP =
  "Edit a draft, then publish it to make a fixed version that workflows can use.";
const ALERTS_PAGE_HELP =
  "Authorization, replay, policy, and redaction problems in this workspace. Each alert shows what happened, when, and the ids to trace it, never secrets or the full event details. Acknowledge an alert to show it's been seen.";
const AUDIT_PAGE_HELP =
  "Who did what in this workspace, and when. Filter by resource or action to find an entry.";
const AUDIT_APPEND_ONLY_HELP =
  "Entries are only ever added to the audit log. Nobody can edit or delete them here.";
const CREDENTIAL_VAULT_HELP =
  "Search finds credentials by display name. Filter by type, tag, or status, then open one to manage it. FlowForge shows only each credential's name and id. Secret values never appear in workflows, search, or analytics.";
const START_BAD_INPUT =
  "The run wasn't started. Only published versions can run, and the input has to be valid and no larger than 16 KiB.";

const alert = {
  id: ALERT_ID,
  kind: "authorization",
  severity: "warning",
  status: "open",
  action: "publish",
  outcome: "denied",
  resourceType: "workflow",
  resourceId: OPERATOR_WORKFLOW_ID,
  correlationId: "corr-e2e-623",
  requestId: "req-alert-623",
  occurredAt: "2026-09-01T12:00:00.000Z",
};

const auditEvent = {
  id: "abababab-abab-4bab-8bab-abababababab",
  action: "rotate",
  outcome: "success",
  resourceType: "credential",
  resourceId: CREDENTIAL_ID,
  actorId: "88888888-8888-4888-8888-888888888888",
  occurredAt: "2026-09-01T12:00:00.000Z",
};

function controlPlanePath(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  const match = /^\/api\/(?:v1|control-plane)(\/.*)$/.exec(pathname);
  return match ? match[1] : null;
}

/** Answer matching GETs; everything else falls back to the operator API. */
async function fulfillJson(page: Page, matches: (path: string) => unknown) {
  await page.route(
    (url) => {
      const path = controlPlanePath(url.toString());
      return path !== null && matches(path) !== undefined;
    },
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(matches(controlPlanePath(route.request().url()) ?? "")),
      });
    },
  );
}

/** Answer one route and method with an RFC 9457 problem. */
async function fail(
  page: Page,
  method: "GET" | "POST",
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
      if (route.request().method() !== method) {
        await route.fallback();
        return;
      }
      const path = controlPlanePath(route.request().url()) ?? "";
      await route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: `urn:flowforge:problem:${code}`,
          title: "Conflict",
          status,
          detail: "The request was refused.",
          instance: path,
          code,
          request_id: "req-e2e-623",
        }),
      });
    },
  );
}

async function expectNoDeveloperText(region: Locator): Promise<void> {
  const text = (await region.innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(DEVELOPER_TEXT);
}

async function expectPlain(page: Page): Promise<void> {
  const main = page.locator("main");
  await expectNoDeveloperText(main);
  await expect(main.locator("code")).toHaveCount(0);
  await expect(main.locator("[title]:not(iframe)")).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);
}

test.describe("config", () => {
  test("the config hub is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await page.goto("/config");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(CONFIG_PAGE_HELP)).toBeVisible();
    await expect(page.locator("main")).not.toContainText("E4.2");
    await expectPlain(page);
  });

  test("a config list is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await page.goto("/config/cluster-targets");
    await expect(page.getByRole("heading", { level: 1, name: "cluster target" })).toBeVisible();
    await expect(page.getByText(new RegExp(escape(CONFIG_KIND_PAGE_HELP)))).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    await expectPlain(page);
  });

  test("the shared problem banner says what happened and a reference only", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await fail(page, "GET", (path) => path === "/cluster-targets", 409, "conflict");
    await page.goto("/config/cluster-targets");
    // The list loads when Refresh is pressed.
    await page.getByRole("button", { name: "Refresh" }).click();
    const banner = page.getByRole("alert").filter({ hasText: "FlowForge couldn't do that." });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Reference: req-e2e-623");
    await expect(banner).not.toContainText("(409)");
    await expect(banner).not.toContainText("conflict");
    await expect(banner).not.toContainText("request_id");
    await expectPlain(page);
  });
});

test.describe("alerts", () => {
  test("the alert list is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await fulfillJson(page, (path) => (path === "/alerts" ? { items: [alert] } : undefined));
    await page.goto("/alerts");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(ALERTS_PAGE_HELP)).toBeVisible();
    await expect(page.locator("main")).toContainText("Secrets are never shown.");
    await expectPlain(page);
  });

  test("an alert is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await fulfillJson(page, (path) => (path === `/alerts/${ALERT_ID}` ? alert : undefined));
    await page.goto(`/alerts/${ALERT_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("main")).toContainText(ALERT_ID);
    await expectPlain(page);
  });
});

test("the audit log is plain", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
  await fulfillJson(page, (path) => (path === "/audit-events" ? { items: [auditEvent] } : undefined));
  await page.goto("/audit");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(AUDIT_PAGE_HELP)).toBeVisible();
  await expect(page.getByText(AUDIT_APPEND_ONLY_HELP)).toBeVisible();
  await expectPlain(page);
});

test.describe("credentials", () => {
  test("the vault is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await page.goto("/credentials");
    await expect(page.getByRole("heading", { level: 1, name: "Credential vault" })).toBeVisible();
    await expect(page.getByText("Loading credentials…")).toHaveCount(0);
    await expect(page.getByText("prod-k8s")).toBeVisible();
    await expect(page.getByText(CREDENTIAL_VAULT_HELP)).toBeVisible();
    await expectPlain(page);
  });

  test("a credential is plain", async ({ page }) => {
    await installOperatorApi(page, { permissions: PERMISSIONS });
    await fulfillJson(page, (path) =>
      path === `/credentials/${CREDENTIAL_ID}`
        ? {
            id: CREDENTIAL_ID,
            displayName: "prod-k8s",
            type: "kubernetes",
            status: "active",
            tags: ["prod"],
          }
        : undefined,
    );
    await page.goto(`/credentials/${CREDENTIAL_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("main")).toContainText("prod-k8s");
    await expectPlain(page);
  });
});

test("the Start panel's bad-input message replaces the API's words", async ({ page }) => {
  await installOperatorApi(page, { permissions: PERMISSIONS });
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
  await fail(
    page,
    "POST",
    (path) => path === `/workflows/${OPERATOR_WORKFLOW_ID}/executions`,
    400,
    "invalid-request",
  );
  await page.goto(`/workflows?start=${OPERATOR_WORKFLOW_ID}`);
  const panel = page.locator("section[aria-labelledby='manual-start-heading']");
  await expect(panel).toBeVisible();
  const version = panel.locator("select").first();
  if ((await version.inputValue()) === "") {
    await version.selectOption(VERSION_ID);
  }
  const start = panel.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  const banner = panel.getByRole("alert").filter({ hasText: START_BAD_INPUT });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Reference: req-e2e-623");
  await expect(banner).not.toContainText("(400)");
  await expect(banner).not.toContainText("The request was refused.");
  await expectNoDeveloperText(panel);
  await expectNoBlockingAxeViolations(page);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
