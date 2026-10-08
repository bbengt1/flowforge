import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoBlockingAxeViolations } from "./axe";
import { installOperatorApi, OPERATOR_WORKFLOW_ID } from "./operator-api";

/**
 * The approvals list and detail, the run page header and approval
 * panel, the Start dialog, and the workflows last-run chip say things
 * in plain words: no routes, CSRF, HTTP codes, permission keys, flags,
 * or issue references.
 */

const ME = "88888888-8888-4888-8888-888888888888";
const OTHER = "99999999-9999-4999-8999-999999999999";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const MINE_ID = "a1111111-1111-4111-8111-111111111111";
const THEIRS_ID = "a2222222-2222-4222-8222-222222222222";
const RUN_ID = "a3333333-3333-4333-8333-333333333333";
const GATE_STEP_ID = "a4444444-4444-4444-8444-444444444444";

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

const DEVELOPER_TEXT =
  /\bPOST\b|\bGET \/|CSRF|Idempotency-Key|approval\.(?:decide|view)|workflow\.execute|execution\.cancel|waitResumeEnabled|dispatchAllowed|capabilities\.|workflowVersionId|[Rr]esume is decide|[Ss]elf-approval|HTTP \d{3}|#\d+|\bE\d+\.\d+\b|Chloe UI|This UI|\/approvals\/\{|\/executions\/\{|jonny/;

const REQUESTER_SENTENCE =
  "The person who requested this approval can't approve or reject it.";
const OLD_REQUESTER_BLOCK = "You requested this approval.";
const RESUME_SENTENCE =
  "The run continues once someone approves or rejects this step, here or on its approval page.";
const WAITING_SENTENCE =
  "Waiting for someone to approve or reject it, or for a timed delay to end.";

function approval(
  id: string,
  requestedBy: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    status: "pending",
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: id === MINE_ID ? "Mine" : "Theirs",
    requestedBy,
    requestedAt: "2026-10-01T12:00:00.000Z",
    approverRole: "approver",
    binding: {
      workflowVersionId: VERSION_ID,
      operation: "deploy",
      nodeId: "gate",
      expiresAt: "2099-01-01T00:00:00Z",
    },
    validity: { current: true, reason: "pending" },
    permittedActions: ["approve", "reject"],
    ...extra,
  };
}

function controlPlanePath(url: string): string | null {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  const match = /^\/api\/(?:v1|control-plane)(\/.*)$/.exec(pathname);
  return match ? match[1] : null;
}

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
      const body = matches(controlPlanePath(url.toString()) ?? "", url);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}

async function expectNoDeveloperText(region: Locator): Promise<void> {
  const text = (await region.innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(DEVELOPER_TEXT);
}

async function expectPlain(region: Locator): Promise<void> {
  await expectNoDeveloperText(region);
  await expect(region.locator("[title]")).toHaveCount(0);
}

/** No duplicate ids, so aria wiring never points at the wrong panel. */
async function expectUniqueIds(page: Page): Promise<void> {
  const duplicates = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const element of document.querySelectorAll("[id]")) {
      seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  });
  expect(duplicates).toEqual([]);
}

async function expectRequesterSentenceOnly(region: Locator): Promise<void> {
  await expect(region.getByText(REQUESTER_SENTENCE, { exact: true }).first()).toBeVisible();
  await expect(region.getByText(OLD_REQUESTER_BLOCK)).toHaveCount(0);
  await expect(region.getByText("Self-approval")).toHaveCount(0);
}

test.describe("approvals pages", () => {
  test("the list says what approvals are in plain words", async ({ page }) => {
    await installOperatorApi(page, { permissions: DECIDE_PERMISSIONS });
    const items = [approval(MINE_ID, ME), approval(THEIRS_ID, OTHER)];
    await fulfillJson(page, (path) =>
      path === "/approvals" ? { items } : undefined,
    );
    await page.goto("/approvals");
    const main = page.locator("main");
    await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
    await expect(
      main.getByText(
        "Approval requests in this workspace. A waiting run continues once someone approves or rejects its request.",
      ),
    ).toBeVisible();
    await expect(main.locator("li").filter({ hasText: "Theirs" })).toBeVisible();
    const mine = main.locator("li").filter({ hasText: "Mine" });
    await expect(mine).toBeVisible();
    await expectRequesterSentenceOnly(mine);
    await expect(mine.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expectPlain(main);
    await expectUniqueIds(page);
    await expectNoBlockingAxeViolations(page);
  });

  test("the detail page is plain and the requester sees one sentence", async ({ page }) => {
    await installOperatorApi(page, { permissions: DECIDE_PERMISSIONS });
    // A changed binding renders a second snapshot on the page.
    const mine = approval(MINE_ID, ME, {
      validity: {
        current: false,
        reason: "invalidated",
        changedFields: ["policyRevisionId"],
        currentBinding: {
          workflowVersionId: VERSION_ID,
          operation: "deploy",
          policyRevisionId: "b5555555-5555-4555-8555-555555555555",
        },
      },
    });
    const pending = approval(THEIRS_ID, ME);
    await fulfillJson(page, (path) => {
      if (path === `/approvals/${MINE_ID}`) {
        return mine;
      }
      if (path === `/approvals/${THEIRS_ID}`) {
        return pending;
      }
      return undefined;
    });

    await page.goto(`/approvals/${THEIRS_ID}`);
    const main = page.locator("main");
    await expect(page.getByRole("heading", { level: 1, name: "Approval request" })).toBeVisible();
    await expect(
      main.getByText("Check what this request covers before you approve or reject it."),
    ).toBeVisible();
    await expect(main.getByRole("heading", { name: "What this approval covers" })).toBeVisible();
    await expectRequesterSentenceOnly(main);
    await expect(main.getByText(REQUESTER_SENTENCE, { exact: true })).toHaveCount(1);
    await expectPlain(main);
    await expectUniqueIds(page);
    await expectNoBlockingAxeViolations(page);

    await page.goto(`/approvals/${MINE_ID}`);
    await expect(main.getByRole("heading", { name: "What this approval covers" })).toHaveCount(2);
    await expectPlain(main);
    await expectUniqueIds(page);
    await expectNoBlockingAxeViolations(page);
  });
});

test("the run page header and approval panel are plain", async ({ page }) => {
  await installOperatorApi(page, { permissions: DECIDE_PERMISSIONS });
  const detail = {
    id: RUN_ID,
    workflowId: OPERATOR_WORKFLOW_ID,
    workflowName: "Deploy",
    workflowSlug: "deploy",
    workflowVersionId: VERSION_ID,
    workflowVersionNumber: 1,
    status: "waiting",
    createdAt: "2026-10-01T12:00:00.000Z",
    startedAt: "2026-10-01T12:00:00.000Z",
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
        status: "waiting",
      },
    ],
  };
  // Two gates on one run: one the viewer requested, one they can decide.
  const gates = [
    { ...approval(MINE_ID, ME), executionId: RUN_ID, executionStatus: "waiting" },
    { ...approval(THEIRS_ID, OTHER), executionId: RUN_ID, executionStatus: "waiting" },
  ];
  await fulfillJson(page, (path, url) => {
    if (path === `/executions/${RUN_ID}`) {
      return detail;
    }
    if (path.endsWith("/logs")) {
      return { lines: [] };
    }
    if (path === "/approvals" && url.searchParams.get("executionId") === RUN_ID) {
      return { items: gates };
    }
    return undefined;
  });
  await page.goto(`/executions/${RUN_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "Execution" })).toBeVisible();
  const header = page.locator("main > header");
  await expect(header).toContainText(
    "Each step's status is shown on the graph of the published version that ran.",
  );
  await expect(header).not.toContainText("Graph replay");
  await expectPlain(header);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Execution approval state" }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("This run is waiting for an approval.")).toBeVisible();
  await expect(panel.getByText(RESUME_SENTENCE)).toBeVisible();
  await expectRequesterSentenceOnly(panel);
  await expectPlain(panel);
  await expectUniqueIds(page);
  await expectNoBlockingAxeViolations(page);
});

test("the Start dialog is plain", async ({ page }) => {
  await installOperatorApi(page, { permissions: DECIDE_PERMISSIONS });
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
  await expect(
    dialog.getByText("Only published versions can run. Drafts and unsaved changes never run.").first(),
  ).toBeVisible();
  await expectPlain(dialog);
  const version = dialog.locator("select").first();
  if ((await version.inputValue()) === "") {
    await version.selectOption(VERSION_ID);
  }
  await expect(dialog.getByRole("heading", { name: "Pre-run review" })).toBeVisible();
  await expect(dialog.getByText("FlowForge checks policy before the run starts.")).toBeVisible();
  await expectPlain(dialog);
  await expectNoBlockingAxeViolations(page);
});

test.describe("workflows last-run chip", () => {
  const ROWS = [
    { id: "c1111111-1111-4111-8111-111111111111", name: "Alpha deploy", status: "waiting" },
    { id: "c2222222-2222-4222-8222-222222222222", name: "Beta deploy", status: "succeeded" },
    { id: "c3333333-3333-4333-8333-333333333333", name: "Gamma deploy", status: "failed" },
  ];

  async function openRows(page: Page): Promise<void> {
    await installOperatorApi(page);
    await fulfillJson(page, (path, url) => {
      const folderId = url.searchParams.get("folderId")?.trim() ?? "";
      if (path === "/workflows" && (folderId === "" || folderId === "unfiled")) {
        return {
          items: ROWS.map((row, index) => ({
            id: row.id,
            slug: row.name.toLowerCase().replace(/ /g, "-"),
            name: row.name,
            status: "draft",
            draftRevision: 1,
            // Newest first, so the waiting row sits above the others.
            updatedAt: `2026-10-0${ROWS.length - index}T12:00:00.000Z`,
          })),
        };
      }
      const runs = /^\/workflows\/([^/]+)\/executions$/.exec(path);
      const row = runs ? ROWS.find((item) => item.id === runs[1]) : undefined;
      if (row) {
        return {
          items: [
            {
              id: `${row.id.slice(0, 35)}9`,
              workflowId: row.id,
              workflowName: row.name,
              workflowVersionId: VERSION_ID,
              workflowVersionNumber: 1,
              status: row.status,
              createdAt: "2026-10-01T12:00:00.000Z",
              startedAt: "2026-10-01T12:00:00.000Z",
              permittedActions: ["view"],
            },
          ],
        };
      }
      return undefined;
    });
    await page.goto("/workflows");
    await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
    for (const row of ROWS) {
      await expect(page.getByText(row.name, { exact: true })).toBeVisible();
    }
  }

  test("a waiting last run says Waiting with the Waiting sentence", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openRows(page);
    const waiting = page.locator("[data-home-last-run-kind='waiting'] a");
    await expect(waiting).toHaveCount(1);
    await expect(waiting.locator("span.truncate")).toHaveText("Waiting");
    const tip = waiting.locator("[data-ff-tooltip]");
    await expect(tip).toHaveText(WAITING_SENTENCE);
    const cell = page.locator("[data-home-row-scan-cell='lastRun']").first();
    expect(await cell.innerText()).not.toMatch(/decide|Resume/);
    await expect(page.locator("main")).not.toContainText("Resume is decide");
    await expectNoDeveloperText(page.locator("main"));
  });

  for (const width of [1280, 1440]) {
    test(`the hovered last-run bubble stays above the next row at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openRows(page);
      const rows = page.locator("li[data-home-row-scan='card']");
      await expect(rows).toHaveCount(ROWS.length);
      await expect(rows.first()).toContainText("Alpha deploy");
      const link = rows.first().locator("[data-home-last-run='status'] a");
      const tip = link.locator("[data-ff-tooltip]");
      // Room below the row, so the bubble opens downward over the next row.
      await rows.first().evaluate((row) => row.scrollIntoView({ block: "start" }));
      await link.hover();
      await expect(tip).toHaveAttribute("data-ff-tooltip", "open");
      // The hovered link must not start a stacking context.
      const style = await link.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          opacity: computed.opacity,
          filter: computed.filter,
          transform: computed.transform,
          isolation: computed.isolation,
          zIndex: computed.zIndex,
        };
      });
      expect(style).toEqual({
        opacity: "1",
        filter: "none",
        transform: "none",
        isolation: "auto",
        zIndex: "auto",
      });
      // The open bubble reaches into the next row, and every corner of it
      // hit-tests to the bubble, so nothing in that row paints over it.
      const result = await tip.evaluate((bubble) => {
        const rect = bubble.getBoundingClientRect();
        const row = bubble.closest("li")?.nextElementSibling;
        const next = row?.getBoundingClientRect();
        const inset = 6;
        const points = [
          [rect.left + inset, rect.top + inset],
          [rect.right - inset, rect.top + inset],
          [rect.left + inset, rect.bottom - inset],
          [rect.right - inset, rect.bottom - inset],
        ];
        return {
          bubble: [rect.top, rect.bottom],
          nextRow: next ? [next.top, next.bottom] : null,
          overlapsNextRow: Boolean(next && rect.bottom > next.top + 1),
          hits: points.map(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return hit && (hit === bubble || bubble.contains(hit))
              ? true
              : `${hit?.tagName ?? "none"}.${hit?.className ?? ""}`;
          }),
        };
      });
      expect(result.overlapsNextRow, JSON.stringify(result)).toBe(true);
      expect(result.hits, JSON.stringify(result)).toEqual([true, true, true, true]);
    });
  }
});
