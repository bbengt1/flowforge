import { expect, test } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import {
  expectNoSecretsInBrowserStorage,
  installOperatorApi,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";

const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const OUTPUT_EXECUTION_ID = "6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e";
const REASON_EXECUTION_ID = "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f";
const GATE_EXECUTION_ID = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
const NOTIFY_STEP_ID = "e1111111-1111-4111-8111-111111111111";
const QUIET_STEP_ID = "e2222222-2222-4222-8222-222222222222";
const GATE_STEP_ID = "e3333333-3333-4333-8333-333333333333";
const REVIEW_STEP_ID = "e4444444-4444-4444-8444-444444444444";

const OUTPUT_JSON_SNIPPET = '"applied": true';
const HTML_NOTE = "<img src=x onerror=alert(1)>";
const STEP_ERROR = "script_failed: notify exploded";
const STEP_MESSAGE = "notify exploded";
const UNRESOLVABLE =
  "Failed because an approval requirement could no longer be met.";
const GATE_ERROR_MESSAGE = "The approval requirement could not be rebuilt.";
const EXPIRED_LINE =
  "Approval gate gate: Closed because it expired before anyone decided.";
const INVALIDATED_LINE =
  "Approval gate review: Closed because it was invalidated before anyone decided.";

function isControlPlane(url: string, suffix: string): boolean {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  return (
    pathname === `/api/v1${suffix}` || pathname === `/api/control-plane${suffix}`
  );
}

function executionBase(id: string, status: string, statusReason?: string) {
  return {
    id,
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: "Deploy",
    workflowSlug: "deploy",
    workflowVersionId: VERSION_ID,
    workflowVersionNumber: 1,
    status,
    ...(statusReason ? { statusReason } : {}),
    createdAt: "2026-09-01T12:00:00.000Z",
    startedAt: "2026-09-01T12:00:00.000Z",
    finishedAt: "2026-09-01T12:01:00.000Z",
    permittedActions: ["view"],
    capabilities: { retry: { allowed: true } },
    jobs: [],
    auditEvents: [],
    artifacts: [],
  };
}

function outputExecution() {
  return {
    ...executionBase(OUTPUT_EXECUTION_ID, "failed"),
    steps: [
      {
        id: NOTIFY_STEP_ID,
        nodeId: "notify",
        nodeType: "data.set",
        attempt: 1,
        status: "failed",
        output: { applied: true, note: HTML_NOTE },
        error: { code: "script_failed", message: STEP_MESSAGE },
      },
      {
        id: QUIET_STEP_ID,
        nodeId: "quiet",
        nodeType: "data.set",
        attempt: 1,
        status: "skipped",
        output: null,
        error: null,
      },
    ],
  };
}

function reasonExecution() {
  return {
    ...executionBase(REASON_EXECUTION_ID, "failed", "requirement_unresolvable"),
    steps: [
      {
        id: GATE_STEP_ID,
        nodeId: "gate",
        nodeType: "flow.approval",
        attempt: 1,
        status: "failed",
        output: { closed: true },
        error: {
          code: "requirement_unresolvable",
          message: GATE_ERROR_MESSAGE,
        },
      },
    ],
  };
}

function succeededExecution() {
  return {
    ...executionBase(GATE_EXECUTION_ID, "succeeded"),
    steps: [
      {
        id: GATE_STEP_ID,
        nodeId: "gate",
        nodeType: "flow.approval",
        attempt: 1,
        status: "succeeded",
        output: { decision: "expired" },
      },
      {
        id: REVIEW_STEP_ID,
        nodeId: "review",
        nodeType: "flow.approval",
        attempt: 1,
        status: "skipped",
      },
    ],
  };
}

function approval(id: string, status: string, nodeId: string) {
  return {
    id,
    status,
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: "Deploy",
    executionId: GATE_EXECUTION_ID,
    executionStatus: "succeeded",
    requestedBy: "operator-ada",
    requestedAt: "2026-09-01T12:00:00.000Z",
    binding: {
      workflowVersionId: VERSION_ID,
      operation: "deploy",
      nodeId,
    },
    validity: { current: false, reason: status },
    permittedActions: ["view"],
  };
}

async function installRun(
  page: import("@playwright/test").Page,
  executionId: string,
  detail: unknown,
  logsForStep: (stepId: string) => unknown,
  approvals?: unknown,
) {
  await installOperatorApi(page);
  await page.route(
    (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/$/, "");
      const prefixes = [
        `/api/v1/executions/${executionId}`,
        `/api/control-plane/executions/${executionId}`,
      ];
      if (prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        return true;
      }
      return (
        (isControlPlane(url, "/approvals") &&
          parsed.searchParams.get("executionId") === executionId) ||
        false
      );
    },
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const parsed = new URL(route.request().url());
      const path = parsed.pathname.replace(/\/$/, "");
      if (
        path === `/api/v1/executions/${executionId}` ||
        path === `/api/control-plane/executions/${executionId}`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(detail),
        });
        return;
      }
      if (path.endsWith("/logs")) {
        const stepId = path.split("/").at(-2) ?? "";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(logsForStep(stepId)),
        });
        return;
      }
      if (parsed.searchParams.get("executionId") === executionId && approvals) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: approvals }),
        });
        return;
      }
      await route.fallback();
    },
  );
  await page.route(
    (url) => isControlPlane(url, "/workflows/catalog"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          apiVersion: "flowforge/v1",
          triggers: [],
          nodes: [
            {
              type: "data.set",
              phase: "core",
              inputs: [{ name: "input", kind: "any" }],
              outputs: [{ name: "result", kind: "object" }],
            },
            {
              type: "flow.approval",
              phase: "core",
              inputs: [{ name: "input", kind: "any" }],
              outputs: [
                { name: "approved", kind: "object" },
                { name: "rejected", kind: "object" },
              ],
            },
          ],
        }),
      });
    },
  );
}

test("empty step logs fall back to output and the failed-step error", async ({ page }) => {
  await installRun(page, OUTPUT_EXECUTION_ID, outputExecution(), (stepId) =>
    stepId === QUIET_STEP_ID ? { lines: ["", "  "] } : { lines: [""] },
  );
  await page.goto(
    `/executions/${OUTPUT_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  const steps = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Steps", level: 2 }),
  });
  const notify = steps.locator("li").filter({ hasText: "notify" });
  await expect(notify.getByText(STEP_ERROR)).toBeVisible();
  await expect(notify.locator("pre")).toContainText(OUTPUT_JSON_SNIPPET);
  await expect(notify.locator("pre")).toContainText(HTML_NOTE);
  await expect(notify.locator("img")).toHaveCount(0);
  const quiet = steps.locator("li").filter({ hasText: "quiet" });
  await expect(quiet.locator("pre")).toHaveText("—");
  const replay = page.locator("section").filter({
    has: page.locator("#graph-replay-heading"),
  });
  await expect(replay.getByText("Safe outputs")).toBeVisible();
  await expect(
    replay.getByText("Safe outputs", { exact: true }).locator("xpath=following-sibling::pre"),
  ).toContainText(OUTPUT_JSON_SNIPPET);
  await expect(replay.getByText(STEP_ERROR)).toBeVisible();
  const notifyPort = page.locator("[data-canvas-node='notify']");
  await expect(notifyPort.locator("[data-replay-port-output]")).toContainText(OUTPUT_JSON_SNIPPET);
  await expect(notifyPort.locator("[data-replay-port-output]")).toContainText(HTML_NOTE);
  await expect(notifyPort.locator("img")).toHaveCount(0);
  await expect(notifyPort.getByText("unavailable any")).toHaveCount(0);
  await expect(notifyPort.getByText("unavailable object")).toHaveCount(0);
  await expect(page.getByText("unavailable any")).toHaveCount(0);
  await expect(page.getByText("unavailable object")).toHaveCount(0);
  await expect(page.getByText(STEP_MESSAGE).first()).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expectNoBlockingAxeViolations(page);
  await expectNoSecretsInBrowserStorage(page);
});

test("a failed run shows the statusReason sentence and not the raw code", async ({ page }) => {
  await installRun(page, REASON_EXECUTION_ID, reasonExecution(), () => ({ lines: [""] }));
  await page.goto(
    `/executions/${REASON_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  await expect(page.getByText(UNRESOLVABLE)).toBeVisible();
  await expect(page.getByText(GATE_ERROR_MESSAGE).first()).toBeVisible();
  await expect(page.getByText("requirement_unresolvable")).toHaveCount(0);
  await expect(
    page.getByText(`requirement_unresolvable: ${GATE_ERROR_MESSAGE}`),
  ).toHaveCount(0);
  const steps = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Steps", level: 2 }),
  });
  const gate = steps.locator("li").filter({ hasText: "gate" });
  await expect(gate.getByText(GATE_ERROR_MESSAGE)).toBeVisible();
  await expect(gate.getByText("requirement_unresolvable")).toHaveCount(0);
  const gatePort = page.locator("[data-canvas-node='gate']");
  await expect(gatePort.locator("[data-replay-port-output]")).toContainText('"closed": true');
  await expect(gatePort.getByText("requirement_unresolvable")).toHaveCount(0);
  await expect(page.getByText("not-a-reason")).toHaveCount(0);
  await expectNoBlockingAxeViolations(page);
  await expectNoSecretsInBrowserStorage(page);
});

test("a succeeded run names each expired or invalidated gate", async ({ page }) => {
  await installRun(
    page,
    GATE_EXECUTION_ID,
    succeededExecution(),
    () => ({ lines: [""] }),
    [
      approval("a5555555-5555-4555-8555-555555555555", "expired", "gate"),
      approval("a6666666-6666-4666-8666-666666666666", "invalidated", "review"),
    ],
  );
  await page.goto(
    `/executions/${GATE_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  await expect(page.getByText(EXPIRED_LINE).first()).toBeVisible();
  await expect(page.getByText(INVALIDATED_LINE).first()).toBeVisible();
  const steps = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Steps", level: 2 }),
  });
  await expect(
    steps.locator("li").filter({ hasText: "attempt" }).filter({ hasText: EXPIRED_LINE }),
  ).toBeVisible();
  await expect(
    steps.locator("li").filter({ hasText: "attempt" }).filter({ hasText: INVALIDATED_LINE }),
  ).toBeVisible();
  await expectNoBlockingAxeViolations(page);
  await expectNoSecretsInBrowserStorage(page);
});
