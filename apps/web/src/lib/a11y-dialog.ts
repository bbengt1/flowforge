/**
 * G.3.1 Dialog behavior: Tab cycles inside the dialog, Escape closes
 * the top dialog, and the page behind the overlay is inert.
 */

export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const INERT_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT"]);

const stack: symbol[] = [];

export function dialogStackPush(id: symbol): void {
  if (!stack.includes(id)) {
    stack.push(id);
  }
}

export function dialogStackPop(id: symbol): void {
  const index = stack.lastIndexOf(id);
  if (index >= 0) {
    stack.splice(index, 1);
  }
}

export function dialogStackIsTop(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

export function dialogStackReset(): void {
  stack.length = 0;
}

export function dialogEscapeCloses(input: {
  key: string;
  defaultPrevented: boolean;
  isTop: boolean;
}): boolean {
  return input.isTop && input.key === "Escape" && !input.defaultPrevented;
}

/**
 * Where Tab should move. `null` means the browser can move to the next
 * tab stop still inside the dialog. `-1` means focus the dialog container
 * because it has no tab stops. Any other number is an index to focus.
 */
export function dialogTabTargetIndex(
  count: number,
  activeIndex: number,
  shift: boolean,
): number | null {
  if (count <= 0) {
    return -1;
  }
  if (shift) {
    if (activeIndex <= 0) {
      return count - 1;
    }
    return null;
  }
  if (activeIndex < 0 || activeIndex >= count - 1) {
    return 0;
  }
  return null;
}

export function isDialogTabStop(input: {
  disabled: boolean;
  tabIndex: number;
  hidden: boolean;
  inert: boolean;
  ariaHidden: boolean;
}): boolean {
  return (
    !input.disabled &&
    !input.hidden &&
    !input.inert &&
    !input.ariaHidden &&
    input.tabIndex >= 0
  );
}

export function dialogChildShouldBeInert(input: {
  tagName: string;
  containsDialog: boolean;
  alreadyInert: boolean;
}): boolean {
  if (input.containsDialog || input.alreadyInert) {
    return false;
  }
  if (INERT_SKIP_TAGS.has(input.tagName)) {
    return false;
  }
  return true;
}
