import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installOperatorApi,
  OPERATOR_EXECUTION_ID,
  OPERATOR_WORKFLOW_ID,
} from "./operator-api";
import { expectDocumentRtl, installDocumentRtl } from "./rtl";

/**
 * Status tooltips stay inside their clipping container and the
 * viewport, and one Escape closes every open tooltip.
 */

const RUN_PATH = `/executions/${OPERATOR_EXECUTION_ID}?workflowId=${OPERATOR_WORKFLOW_ID}`;

/**
 * Every corner of the open bubble hit-tests to the bubble itself, so
 * no overflow container, viewport edge, or neighbor clips or covers it.
 */
async function expectBubbleFullyVisible(tip: Locator): Promise<void> {
  await expect(tip).toHaveAttribute("data-ff-tooltip", "open");
  const corners = await tip.evaluate((bubble) => {
    const rect = bubble.getBoundingClientRect();
    const inset = 6;
    const points = [
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
    ];
    return {
      width: rect.width,
      height: rect.height,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      hits: points.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === bubble || bubble.contains(hit))
          ? true
          : `${hit?.tagName ?? "none"}.${hit?.className ?? ""}`;
      }),
    };
  });
  expect(corners.width).toBeGreaterThan(40);
  expect(corners.height).toBeGreaterThan(10);
  expect(corners.rect.left).toBeGreaterThanOrEqual(-1);
  expect(corners.rect.right).toBeLessThanOrEqual(corners.viewport.width + 1);
  expect(corners.hits, JSON.stringify(corners)).toEqual([true, true, true, true]);
}

async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  // Keyboard modality first, so :focus-visible matches.
  await page.keyboard.press("Shift");
  await target.focus();
  await expect(target).toBeFocused();
}

async function openWorkflowHome(page: Page): Promise<void> {
  await installOperatorApi(page);
  await page.goto("/workflows");
  await expect(
    page.getByRole("heading", { level: 1, name: "Workflows" }),
  ).toBeVisible();
  await expect(page.getByText("Deploy", { exact: true })).toBeVisible();
}

async function expectLastRunTipInside(page: Page): Promise<void> {
  const lastRun = page.locator("[data-home-last-run='status'] a").first();
  await expect(lastRun).toBeVisible();
  const tip = lastRun.locator("[data-ff-tooltip]");
  await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
  // Keyboard focus.
  await keyboardFocus(page, lastRun);
  await expectBubbleFullyVisible(tip);
  await page.keyboard.press("Escape");
  await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
  await expect(lastRun).toBeFocused();
  // Hover.
  await lastRun.blur();
  await lastRun.hover();
  await expectBubbleFullyVisible(tip);
  await page.mouse.move(0, 0);
  await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
}

test.describe("status tooltip edges", () => {
  for (const width of [1280, 1440]) {
    test(`workflows last-run tooltip stays inside at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openWorkflowHome(page);
      await expectLastRunTipInside(page);
    });
  }

  test("workflows last-run tooltip stays inside at 1280 under rtl", async ({
    page,
    baseURL,
  }) => {
    await installDocumentRtl(page, baseURL ?? "http://127.0.0.1:3100");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkflowHome(page);
    await expectDocumentRtl(page);
    await expectLastRunTipInside(page);
  });

  test("activation chip shows its help as the shared tooltip", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkflowHome(page);
    const activation = page.locator("[data-home-activation='status'] a").first();
    await expect(activation).toBeVisible();
    await expect(activation).not.toHaveAttribute("title", /.*/);
    const tipId = await activation.getAttribute("aria-describedby");
    expect(tipId).toBeTruthy();
    const tip = page.locator(`[id="${tipId}"]`);
    await expect(tip).toHaveAttribute("role", "tooltip");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
    const help = (await tip.textContent())?.trim() ?? "";
    expect(help.length).toBeGreaterThan(0);
    await expect(activation).toHaveAccessibleDescription(help);
    // The help is the description only, not part of the link's name.
    await expect(activation).not.toHaveAccessibleName(
      new RegExp(help.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await keyboardFocus(page, activation);
    await expectBubbleFullyVisible(tip);
    await page.keyboard.press("Escape");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
    await expect(activation).toBeFocused();
  });

  test("a link-less last-run chip shows its help on the keyboard-current row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Without execution.view the last-run chip is not a link.
    await installOperatorApi(page, {
      permissions: [
        "workflow.view",
        "workflow.edit",
        "workflow.publish",
        "workflow.execute",
        "credential.view",
        "approval.view",
      ],
    });
    await page.goto("/workflows");
    await expect(
      page.getByRole("heading", { level: 1, name: "Workflows" }),
    ).toBeVisible();
    await expect(page.getByText("Deploy", { exact: true })).toBeVisible();
    const chip = page.locator("[data-home-last-run-tip='row']").first();
    await expect(chip).toBeVisible();
    await expect(chip).not.toHaveAttribute("tabindex", /.*/);
    const tip = chip.locator("[data-ff-tooltip]");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
    const row = page.locator("li[data-x3-kind='workflow']").first();
    const list = page.locator("[data-x3='pane-list']");
    await list.focus();
    for (let index = 0; index < 6; index += 1) {
      if ((await row.getAttribute("data-x3-selected")) === "true") {
        break;
      }
      await page.keyboard.press("ArrowDown");
    }
    await expect(row).toHaveAttribute("data-x3-selected", "true");
    await expectBubbleFullyVisible(tip);
    await expect(list).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tip).toHaveAttribute("data-ff-tooltip", "closed");
    await expect(list).toBeFocused();
  });

  test("run canvas node at the bottom edge opens its tooltip above", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installOperatorApi(page);
    await page.goto(RUN_PATH);
    await expect(
      page.getByRole("heading", { level: 1, name: "Execution" }),
    ).toBeVisible();
    const node = page.locator("[data-canvas-node='downstream']");
    await expect(node).toBeVisible();
    const chip = node.locator("[data-ff-status-tip='node']");
    const tip = chip.locator("[data-ff-tooltip]");
    // The canvas surface is the node's grandparent (surface > pan layer > node).
    const surface = node.locator("xpath=../..");
    await surface.scrollIntoViewIfNeeded();
    // Drag the graph down from an empty spot on the canvas until the
    // chip sits ~14 px above the canvas bottom edge: below, only a
    // sliver of the bubble would show. Re-measure after each drag.
    let surfaceBottom = 0;
    let chipBottom = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [surfaceBox, chipBox] = await Promise.all([
        surface.boundingBox(),
        chip.boundingBox(),
      ]);
      surfaceBottom = (surfaceBox?.y ?? 0) + (surfaceBox?.height ?? 0);
      chipBottom = (chipBox?.y ?? 0) + (chipBox?.height ?? 0);
      const dy = Math.round(surfaceBottom - 14 - chipBottom);
      if (Math.abs(dy) <= 4) {
        break;
      }
      const empty = await surface.evaluate((element, span) => {
        const rect = element.getBoundingClientRect();
        // Start where the end point stays on the canvas too.
        const minY = rect.top + 8 + Math.max(0, -span);
        const maxY = rect.bottom - 8 - Math.max(0, span);
        for (let y = minY; y < maxY; y += 8) {
          for (let x = rect.left + 8; x < rect.right - 8; x += 16) {
            const hit = document.elementFromPoint(x, y);
            if (
              hit &&
              element.contains(hit) &&
              !hit.closest("[data-canvas-node],[data-port],button,a")
            ) {
              return { x, y };
            }
          }
        }
        return null;
      }, dy);
      expect(empty).toBeTruthy();
      await page.mouse.move(empty?.x ?? 0, empty?.y ?? 0);
      await page.mouse.down();
      await page.mouse.move(empty?.x ?? 0, (empty?.y ?? 0) + dy, { steps: 8 });
      await page.mouse.up();
    }
    expect(chipBottom).toBeGreaterThan(surfaceBottom - 24);
    expect(chipBottom).toBeLessThan(surfaceBottom);
    await chip.hover();
    await expect(tip).toHaveAttribute("data-ff-tooltip", "open");
    await expect(tip).toHaveAttribute("data-ff-tooltip-side", "above");
    await expectBubbleFullyVisible(tip);
  });

  test("one Escape closes a focus tooltip and a hover tooltip together", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installOperatorApi(page);
    await page.goto(RUN_PATH);
    await expect(
      page.getByRole("heading", { level: 1, name: "Execution" }),
    ).toBeVisible();
    const blocked = page.getByRole("status", { name: "Blocked", exact: true });
    const pending = page.getByRole("status", { name: "Pending", exact: true }).first();
    const blockedTip = blocked.locator("[data-ff-tooltip]");
    const pendingTip = pending.locator("[data-ff-tooltip]");
    await keyboardFocus(page, blocked);
    await expect(blockedTip).toHaveAttribute("data-ff-tooltip", "open");
    await pending.hover();
    await expect(pendingTip).toHaveAttribute("data-ff-tooltip", "open");
    await expect(blockedTip).toHaveAttribute("data-ff-tooltip", "open");
    await page.keyboard.press("Escape");
    await expect(blockedTip).toHaveAttribute("data-ff-tooltip", "closed");
    await expect(pendingTip).toHaveAttribute("data-ff-tooltip", "closed");
    await expect(blocked).toBeFocused();
  });

  test("command palette keeps an Escape another handler already used", async ({
    page,
  }) => {
    await installOperatorApi(page);
    await page.goto(`/workflows/${OPERATOR_WORKFLOW_ID}`);
    await expect(
      page.getByRole("application", { name: "Workflow canvas" }),
    ).toBeVisible();
    const commands = page.getByRole("button", { name: "Commands" });
    await commands.click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    // Stand-in for a tooltip inside the palette: a window capture
    // handler that takes the first Escape, the way an open tooltip does.
    await page.evaluate(() => {
      const takeOnce = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          window.removeEventListener("keydown", takeOnce, true);
        }
      };
      window.addEventListener("keydown", takeOnce, true);
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Filter commands")).toBeVisible();
    // The next Escape is nobody else's: the palette closes.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(commands).toBeFocused();
  });
});
