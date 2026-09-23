import { expect, type Locator, type Page } from "@playwright/test";
import { DOCUMENT_DIR_COOKIE } from "../src/lib/document-dir.ts";

/** Sets the document direction cookie before navigation. */
export async function installDocumentRtl(
  page: Page,
  baseURL: string,
): Promise<void> {
  await page.context().addCookies([
    {
      name: DOCUMENT_DIR_COOKIE,
      value: "rtl",
      url: baseURL,
    },
  ]);
}

export async function expectDocumentRtl(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const direction = await page.locator("body").evaluate((element) => {
    return getComputedStyle(element).direction;
  });
  expect(direction).toBe("rtl");
}

/**
 * Text or the element's box sits on the inline-start side (the right
 * when dir=rtl). Physical text-align:left fails this.
 */
export async function expectHugsInlineStart(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const metrics = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const parent = element.parentElement;
    const parentBox = parent?.getBoundingClientRect() ?? box;
    return {
      direction: style.direction,
      textAlign: style.textAlign,
      textGapStart: box.right - text.right,
      textGapEnd: text.left - box.left,
      boxGapStart: parentBox.right - box.right,
      boxGapEnd: box.left - parentBox.left,
      unusedInBox: box.width - text.width,
      unusedInParent: parentBox.width - box.width,
    };
  });
  expect(metrics.direction).toBe("rtl");
  expect(metrics.textAlign).not.toBe("left");
  if (metrics.unusedInBox > 12) {
    expect(metrics.textGapStart).toBeLessThan(metrics.textGapEnd);
    return;
  }
  if (metrics.unusedInParent > 12) {
    expect(metrics.boxGapStart).toBeLessThan(metrics.boxGapEnd);
  }
}

/** A horizontal flex row's first child sits on the inline-start edge. */
export async function expectFirstChildAtInlineStart(
  locator: Locator,
): Promise<void> {
  await expect(locator).toBeVisible();
  const metrics = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const first = element.firstElementChild?.getBoundingClientRect();
    return {
      direction: getComputedStyle(element).direction,
      gapStart: first ? box.right - first.right : Number.POSITIVE_INFINITY,
      gapEnd: first ? first.left - box.left : 0,
    };
  });
  expect(metrics.direction).toBe("rtl");
  expect(metrics.gapStart).toBeLessThan(metrics.gapEnd);
}

/** The box's inline-start edge is the viewport's inline-start edge. */
export async function expectAnchoredToInlineStart(
  locator: Locator,
  page: Page,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) {
    return;
  }
  const gapFromInlineStart = viewport.width - (box.x + box.width);
  expect(gapFromInlineStart).toBeLessThan(8);
  expect(box.x).toBeGreaterThan(viewport.width / 2);
}

export async function expectHorizontallyCentered(
  locator: Locator,
  page: Page,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) {
    return;
  }
  const center = box.x + box.width / 2;
  expect(Math.abs(center - viewport.width / 2)).toBeLessThan(48);
}
