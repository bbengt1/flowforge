/**
 * Status tooltip behavior. A tooltip opens on keyboard focus and on
 * pointer hover, Escape dismisses it without moving focus, and the
 * trigger points at the tooltip text with aria-describedby. The text
 * is never hover-only: when the bubble is closed it stays in the page
 * as visually hidden text, so screen readers can read it either way.
 *
 * A chip inside an interactive row takes no tab stop. Its row can open
 * it instead ("activate"), for example while the row is the keyboard
 * current row of a list.
 */

export type TooltipState = {
  focused: boolean;
  hovered: boolean;
  /** Opened by its row, not by the chip itself. */
  active: boolean;
  dismissed: boolean;
};

export type TooltipEvent =
  | "focus"
  | "blur"
  | "pointerenter"
  | "pointerleave"
  | "activate"
  | "deactivate"
  | "escape";

export const TOOLTIP_CLOSED: TooltipState = {
  focused: false,
  hovered: false,
  active: false,
  dismissed: false,
};

/** Class for the open bubble. Closed text uses the shared sr-only class. */
export const FF_STATUS_TIP_CLASS = "ff-status-tip";
export const FF_STATUS_TIP_END_CLASS = "ff-status-tip-end";
/** Open bubble flipped above its trigger. */
export const FF_STATUS_TIP_ABOVE_CLASS = "ff-status-tip-above";
/** Inline shift, in CSS px toward the inline end, set on the open bubble. */
export const FF_STATUS_TIP_SHIFT_VAR = "--ff-tip-shift";
export const FF_STATUS_TIP_TRIGGER_CLASS = "ff-status-tip-trigger";

export type TooltipAlign = "start" | "end";

/** Once nothing holds the tooltip open, a past Escape is forgotten. */
function settleDismissed(state: TooltipState): TooltipState {
  return state.focused || state.hovered || state.active
    ? state
    : { ...state, dismissed: false };
}

export function tooltipReduce(
  state: TooltipState,
  event: TooltipEvent,
): TooltipState {
  switch (event) {
    case "focus":
      return { ...state, focused: true, dismissed: false };
    case "blur":
      return settleDismissed({ ...state, focused: false });
    case "pointerenter":
      return { ...state, hovered: true, dismissed: false };
    case "pointerleave":
      return settleDismissed({ ...state, hovered: false });
    case "activate":
      return state.active ? state : { ...state, active: true, dismissed: false };
    case "deactivate":
      return state.active ? settleDismissed({ ...state, active: false }) : state;
    case "escape":
      return tooltipIsOpen(state) ? { ...state, dismissed: true } : state;
    default:
      return state;
  }
}

export function tooltipIsOpen(state: TooltipState): boolean {
  return (state.focused || state.hovered || state.active) && !state.dismissed;
}

/** Escape closes an open tooltip. Another handler that already took the key wins. */
export function tooltipEscapeDismisses(input: {
  key: string;
  open: boolean;
  defaultPrevented: boolean;
}): boolean {
  return input.open && input.key === "Escape" && !input.defaultPrevented;
}

export type TooltipEscapeRegistry = {
  /** Register an open tooltip's close. Returns the unregister. */
  register(close: () => void): () => void;
  size(): number;
  /**
   * One Escape closes every open tooltip, from focus, hover, or row.
   * True only when it closed something, so the caller calls
   * preventDefault only then and a Dialog or the Command palette still
   * gets an Escape that no tooltip used.
   */
  handleKey(input: { key: string; defaultPrevented: boolean }): boolean;
};

export function createTooltipEscapeRegistry(): TooltipEscapeRegistry {
  const open = new Set<() => void>();
  return {
    register(close) {
      const entry = () => close();
      open.add(entry);
      return () => {
        open.delete(entry);
      };
    },
    size() {
      return open.size;
    },
    handleKey(input) {
      if (
        !tooltipEscapeDismisses({
          key: input.key,
          open: open.size > 0,
          defaultPrevented: input.defaultPrevented,
        })
      ) {
        return false;
      }
      for (const close of [...open]) {
        close();
      }
      return true;
    },
  };
}

/**
 * A nested chip (no tab stop of its own) shows its help while its row
 * is the keyboard-current row or is hovered, and only when it has help.
 */
export function nestedTipActive(input: {
  hasHelp: boolean;
  keyboardCurrent: boolean;
  rowHovered?: boolean;
}): boolean {
  return input.hasHelp && (input.keyboardCurrent || input.rowHovered === true);
}

/**
 * Focus opens the tooltip only when the trigger itself took keyboard
 * focus. A click that focuses the chip, or focus moving onto a child
 * control, does not open it.
 */
export function tooltipFocusOpens(input: {
  targetIsTrigger: boolean;
  focusVisible: boolean;
}): boolean {
  return input.targetIsTrigger && input.focusVisible;
}

/** aria-describedby for a trigger. Omitted when there is no tooltip text. */
export function tooltipTriggerAria(input: {
  tipId: string;
  text: string | undefined;
}): { "aria-describedby"?: string } {
  return input.text?.trim() ? { "aria-describedby": input.tipId } : {};
}

/** Classes for the tooltip text: a visible bubble when open, sr-only when closed. */
export function tooltipTextClass(input: {
  open: boolean;
  align?: TooltipAlign;
  side?: TooltipSide;
}): string {
  if (!input.open) {
    return "sr-only";
  }
  const classes = [FF_STATUS_TIP_CLASS];
  if (input.align === "end") {
    classes.push(FF_STATUS_TIP_END_CLASS);
  }
  if (input.side === "above") {
    classes.push(FF_STATUS_TIP_ABOVE_CLASS);
  }
  return classes.join(" ");
}

/*
 * Edge placement. The bubble opens below its trigger, lined up with the
 * trigger's start or end edge. When that would cross the edge of a
 * clipping container (an overflow ancestor) or the viewport, it flips
 * to the other inline edge and, on the block axis, above the trigger.
 * When neither inline edge fits it is shifted back inside, anchored at
 * the inline start edge if it is wider than the boundary. All rects are
 * viewport px; the shift is logical (positive toward the inline end),
 * so the same answer works under rtl.
 */

export type TooltipSide = "below" | "above";

export type TooltipRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TooltipPlacementInput = {
  trigger: TooltipRect;
  bubble: { width: number; height: number };
  boundary: TooltipRect;
  direction: "ltr" | "rtl";
  align: TooltipAlign;
  /** Space between trigger and bubble on the block axis. */
  gap: number;
};

export type TooltipPlacement = {
  side: TooltipSide;
  align: TooltipAlign;
  /** Logical inline shift in px, positive toward the inline end. */
  shift: number;
};

export function tooltipDefaultPlacement(align: TooltipAlign): TooltipPlacement {
  return { side: "below", align, shift: 0 };
}

/** overflow values that clip a descendant's box. */
export function tooltipOverflowClips(overflow: string): boolean {
  return /\b(hidden|auto|scroll|clip)\b/.test(overflow);
}

/** Intersection of rects, for example every clipping ancestor and the viewport. */
export function tooltipIntersectRects(
  rects: readonly TooltipRect[],
): TooltipRect | null {
  if (rects.length === 0) {
    return null;
  }
  const [first, ...rest] = rects;
  return rest.reduce<TooltipRect>(
    (acc, rect) => ({
      left: Math.max(acc.left, rect.left),
      top: Math.max(acc.top, rect.top),
      right: Math.min(acc.right, rect.right),
      bottom: Math.min(acc.bottom, rect.bottom),
    }),
    { ...first },
  );
}

function inlineExtent(
  input: TooltipPlacementInput,
  align: TooltipAlign,
): { left: number; right: number } {
  const { trigger, bubble } = input;
  // Physical side the bubble lines up with: start is left under ltr and
  // right under rtl; end is the opposite.
  const leftAligned = (align === "start") === (input.direction === "ltr");
  return leftAligned
    ? { left: trigger.left, right: trigger.left + bubble.width }
    : { left: trigger.right - bubble.width, right: trigger.right };
}

function inlineOverflow(
  extent: { left: number; right: number },
  boundary: TooltipRect,
): number {
  return (
    Math.max(0, boundary.left - extent.left) +
    Math.max(0, extent.right - boundary.right)
  );
}

export function tooltipPlacement(
  input: TooltipPlacementInput,
): TooltipPlacement {
  const { trigger, bubble, boundary, gap } = input;
  if (
    boundary.right - boundary.left <= 0 ||
    boundary.bottom - boundary.top <= 0 ||
    bubble.width <= 0 ||
    bubble.height <= 0
  ) {
    return tooltipDefaultPlacement(input.align);
  }

  // Inline axis: keep the preferred edge when it fits, else flip, else
  // take whichever crosses less (the preferred edge on a tie).
  const other: TooltipAlign = input.align === "start" ? "end" : "start";
  const preferred = inlineExtent(input, input.align);
  const flipped = inlineExtent(input, other);
  const preferredOver = inlineOverflow(preferred, boundary);
  const flippedOver = inlineOverflow(flipped, boundary);
  const align =
    preferredOver === 0 || preferredOver <= flippedOver ? input.align : other;
  const extent = align === input.align ? preferred : flipped;

  let dx = 0;
  if (extent.right - extent.left > boundary.right - boundary.left) {
    // Wider than the boundary: anchor at the inline start edge.
    dx =
      input.direction === "ltr"
        ? boundary.left - extent.left
        : boundary.right - extent.right;
  } else if (extent.left < boundary.left) {
    dx = boundary.left - extent.left;
  } else if (extent.right > boundary.right) {
    dx = boundary.right - extent.right;
  }
  const logical = input.direction === "ltr" ? dx : -dx;
  const shift = Math.round(logical) === 0 ? 0 : Math.round(logical);

  // Block axis: below when it fits, above when only that fits, else the
  // side with more room (below on a tie).
  const roomBelow = boundary.bottom - (trigger.bottom + gap);
  const roomAbove = trigger.top - gap - boundary.top;
  const side: TooltipSide =
    bubble.height <= roomBelow
      ? "below"
      : bubble.height <= roomAbove || roomAbove > roomBelow
        ? "above"
        : "below";

  return { side, align, shift };
}

/** Inline style for the open bubble. Empty when there is no shift. */
export function tooltipShiftStyle(
  placement: Pick<TooltipPlacement, "shift">,
): Record<string, string> {
  return placement.shift === 0
    ? {}
    : { [FF_STATUS_TIP_SHIFT_VAR]: `${placement.shift}px` };
}
