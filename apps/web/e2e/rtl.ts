import { expect, type Locator, type Page } from "@playwright/test";

export async function expectDocumentRtl(page: Page): Promise<void> {
  const root = page.locator("html");
  await expect(root).toHaveAttribute("dir", "rtl");
  const direction = await root.evaluate((element) => {
    const html = getComputedStyle(element).direction;
    const body = getComputedStyle(document.body).direction;
    return { html, body };
  });
  expect(direction.html).toBe("rtl");
  expect(direction.body).toBe("rtl");
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  if (!value) {
    throw new Error("missing box");
  }
  return value;
}

/** `start` sits on the inline-start side of `end` (the right side when dir=rtl). */
export async function expectOnInlineStartSide(
  start: Locator,
  end: Locator,
): Promise<void> {
  const startBox = await box(start);
  const endBox = await box(end);
  expect(startBox.x).toBeGreaterThan(endBox.x + endBox.width - 8);
}

export async function expectMirroredShell(page: Page): Promise<void> {
  await expectDocumentRtl(page);
  await expect(page.locator("main")).toHaveCount(1);
  const nav = page.getByRole("complementary", { name: "Workspace navigation" });
  await expectOnInlineStartSide(nav, page.locator("main"));
  const border = await nav.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      direction: style.direction,
      inlineEnd: Number.parseFloat(style.borderInlineEndWidth),
      inlineStart: Number.parseFloat(style.borderInlineStartWidth),
    };
  });
  expect(border.direction).toBe("rtl");
  expect(border.inlineEnd).toBeGreaterThan(0);
  expect(border.inlineStart).toBe(0);

  const search = await box(page.getByRole("combobox", { name: "Search workspace" }));
  const commands = await box(page.getByRole("button", { name: "Commands" }));
  expect(search.x).toBeGreaterThan(commands.x);
  expect(Math.abs(search.y - commands.y)).toBeLessThan(24);
}

export async function expectFieldWorksInRtl(
  page: Page,
  label: string,
  id: string,
): Promise<void> {
  const input = page.getByLabel(label);
  await expect(input).toHaveAttribute("id", id);
  const field = page.locator(`label[for="${id}"]`);
  await expect(field).toHaveAttribute("for", id);
  await field.getByText(label, { exact: true }).click();
  await expect(input).toBeFocused();
  const metrics = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      direction: style.direction,
      textAlign: style.textAlign,
      dir: element.getAttribute("dir"),
    };
  });
  expect(metrics.direction).toBe("rtl");
  expect(metrics.dir).not.toBe("ltr");
  expect(["start", "right"]).toContain(metrics.textAlign);
}

export async function expectTextOnInlineStart(locator: Locator): Promise<void> {
  const result = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    const host = element.getBoundingClientRect();
    return {
      direction: style.direction,
      textAlign: style.textAlign,
      distStart: host.right - rect.right,
      distEnd: rect.left - host.left,
    };
  });
  expect(result.direction).toBe("rtl");
  expect(["start", "right"]).toContain(result.textAlign);
  expect(result.distStart + 8).toBeLessThan(result.distEnd);
}

export async function expectFocusInside(dialog: Locator): Promise<void> {
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
}

export async function expectPageBehindInert(page: Page, inert: boolean): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("main")?.closest("[inert]") != null),
    )
    .toBe(inert);
}
