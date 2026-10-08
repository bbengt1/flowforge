/**
 * Status tooltip behavior. A tooltip opens on keyboard focus and on
 * pointer hover, Escape dismisses it without moving focus, and the
 * trigger points at the tooltip text with aria-describedby. The text
 * is never hover-only: when the bubble is closed it stays in the page
 * as visually hidden text, so screen readers can read it either way.
 */

export type TooltipState = {
  focused: boolean;
  hovered: boolean;
  dismissed: boolean;
};

export type TooltipEvent =
  | "focus"
  | "blur"
  | "pointerenter"
  | "pointerleave"
  | "escape";

export const TOOLTIP_CLOSED: TooltipState = {
  focused: false,
  hovered: false,
  dismissed: false,
};

/** Class for the open bubble. Closed text uses the shared sr-only class. */
export const FF_STATUS_TIP_CLASS = "ff-status-tip";
export const FF_STATUS_TIP_END_CLASS = "ff-status-tip-end";
export const FF_STATUS_TIP_TRIGGER_CLASS = "ff-status-tip-trigger";

export type TooltipAlign = "start" | "end";

export function tooltipReduce(
  state: TooltipState,
  event: TooltipEvent,
): TooltipState {
  switch (event) {
    case "focus":
      return { ...state, focused: true, dismissed: false };
    case "blur":
      return {
        ...state,
        focused: false,
        dismissed: state.hovered ? state.dismissed : false,
      };
    case "pointerenter":
      return { ...state, hovered: true, dismissed: false };
    case "pointerleave":
      return {
        ...state,
        hovered: false,
        dismissed: state.focused ? state.dismissed : false,
      };
    case "escape":
      return tooltipIsOpen(state) ? { ...state, dismissed: true } : state;
    default:
      return state;
  }
}

export function tooltipIsOpen(state: TooltipState): boolean {
  return (state.focused || state.hovered) && !state.dismissed;
}

/** Escape closes an open tooltip. Another handler that already took the key wins. */
export function tooltipEscapeDismisses(input: {
  key: string;
  open: boolean;
  defaultPrevented: boolean;
}): boolean {
  return input.open && input.key === "Escape" && !input.defaultPrevented;
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
}): string {
  if (!input.open) {
    return "sr-only";
  }
  return input.align === "end"
    ? `${FF_STATUS_TIP_CLASS} ${FF_STATUS_TIP_END_CLASS}`
    : FF_STATUS_TIP_CLASS;
}
