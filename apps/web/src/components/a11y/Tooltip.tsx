"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react";
import {
  FF_STATUS_TIP_TRIGGER_CLASS,
  TOOLTIP_CLOSED,
  createTooltipEscapeRegistry,
  tooltipDefaultPlacement,
  tooltipFocusOpens,
  tooltipIntersectRects,
  tooltipIsOpen,
  tooltipOverflowClips,
  tooltipPlacement,
  tooltipReduce,
  tooltipShiftStyle,
  tooltipTextClass,
  tooltipTriggerAria,
  type TooltipAlign,
  type TooltipPlacement,
  type TooltipRect,
} from "@/lib/a11y-tooltip";

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/*
 * Every open tooltip registers here. One window capture listener closes
 * them all on a single Escape, before a surrounding Dialog or the
 * Command palette sees the key, and calls preventDefault only when it
 * closed something.
 */
const escapeRegistry = createTooltipEscapeRegistry();
let escapeListening = false;

function onEscapeKey(event: KeyboardEvent) {
  if (
    escapeRegistry.handleKey({
      key: event.key,
      defaultPrevented: event.defaultPrevented,
    })
  ) {
    event.preventDefault();
  }
}

function syncEscapeListener() {
  const want = escapeRegistry.size() > 0;
  if (want && !escapeListening) {
    window.addEventListener("keydown", onEscapeKey, true);
    escapeListening = true;
  } else if (!want && escapeListening) {
    window.removeEventListener("keydown", onEscapeKey, true);
    escapeListening = false;
  }
}

export type TooltipControls = {
  open: boolean;
  tipId: string;
  /** Put on the element that takes focus. */
  focusProps: {
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  /** Put on the element that wraps both the trigger and the bubble. */
  hoverProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
  describedBy: { "aria-describedby"?: string };
};

/**
 * Shared tooltip state for status chips. Opens on keyboard focus and
 * on hover, and Escape closes it. `active` lets a row open a nested
 * chip's tooltip (no tab stop of its own), for example while the row is
 * the keyboard-current row of a list.
 */
export function useTooltip(
  text: string | undefined,
  options?: { active?: boolean },
): TooltipControls {
  const tipId = `${useId()}-tip`;
  const [state, dispatch] = useReducer(tooltipReduce, TOOLTIP_CLOSED);
  const hasText = Boolean(text?.trim());
  const open = hasText && tooltipIsOpen(state);
  const active = options?.active === true;

  useEffect(() => {
    dispatch(active ? "activate" : "deactivate");
  }, [active]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const unregister = escapeRegistry.register(() => dispatch("escape"));
    syncEscapeListener();
    return () => {
      unregister();
      syncEscapeListener();
    };
  }, [open]);

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (
      tooltipFocusOpens({
        targetIsTrigger: event.target === event.currentTarget,
        focusVisible: isFocusVisible(event.currentTarget),
      })
    ) {
      dispatch("focus");
    }
  }, []);
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) {
      dispatch("blur");
    }
  }, []);
  const onPointerEnter = useCallback(() => dispatch("pointerenter"), []);
  const onPointerLeave = useCallback(() => dispatch("pointerleave"), []);

  return {
    open,
    tipId,
    focusProps: { onFocus, onBlur },
    hoverProps: { onPointerEnter, onPointerLeave },
    describedBy: tooltipTriggerAria({ tipId, text }),
  };
}

function toRect(rect: DOMRect): TooltipRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}

/** Viewport plus every overflow-clipping ancestor above the trigger. */
function clippingBoundary(trigger: Element): TooltipRect | null {
  const rects: TooltipRect[] = [
    {
      left: 0,
      top: 0,
      right: document.documentElement.clientWidth || window.innerWidth,
      bottom: document.documentElement.clientHeight || window.innerHeight,
    },
  ];
  for (
    let node = trigger.parentElement;
    node && node !== document.body && node !== document.documentElement;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      tooltipOverflowClips(style.overflowX) ||
      tooltipOverflowClips(style.overflowY)
    ) {
      rects.push(toRect(node.getBoundingClientRect()));
    }
  }
  return tooltipIntersectRects(rects);
}

function measurePlacement(
  bubble: HTMLElement,
  align: TooltipAlign,
): TooltipPlacement | null {
  const trigger = bubble.parentElement?.closest(
    `.${FF_STATUS_TIP_TRIGGER_CLASS}`,
  );
  if (!trigger) {
    return null;
  }
  const boundary = clippingBoundary(trigger);
  if (!boundary) {
    return null;
  }
  const triggerRect = trigger.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  // A transformed ancestor (the zoomed canvas) scales both rects; the
  // shift is applied in the bubble's own CSS px.
  const scale =
    bubble.offsetWidth > 0 ? bubbleRect.width / bubble.offsetWidth : 1;
  // The side the bubble is drawn on right now, to read the gap.
  const drawnAbove = bubble.dataset.ffTooltipSide === "above";
  const gap = Math.max(
    0,
    drawnAbove
      ? triggerRect.top - bubbleRect.bottom
      : bubbleRect.top - triggerRect.bottom,
  );
  const placement = tooltipPlacement({
    trigger: toRect(triggerRect),
    bubble: { width: bubbleRect.width, height: bubbleRect.height },
    boundary,
    direction: getComputedStyle(trigger).direction === "rtl" ? "rtl" : "ltr",
    align,
    gap,
  });
  const shift =
    scale > 0 && scale !== 1 ? Math.round(placement.shift / scale) : placement.shift;
  return { ...placement, shift: shift === 0 ? 0 : shift };
}

function samePlacement(a: TooltipPlacement, b: TooltipPlacement): boolean {
  return a.side === b.side && a.align === b.align && a.shift === b.shift;
}

/**
 * The tooltip text. Closed, it is visually hidden but still read by
 * screen readers. Open, it shows as a bubble under the trigger, flipped
 * or shifted so it stays inside its clipping container and the
 * viewport. `labelled` false drops role and id when the parent already
 * carries the text in its own accessible name.
 */
export function TooltipText({
  controls,
  text,
  align = "start",
  labelled = true,
}: {
  controls: Pick<TooltipControls, "open" | "tipId">;
  text: string | undefined;
  align?: TooltipAlign;
  labelled?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<TooltipPlacement>(() =>
    tooltipDefaultPlacement(align),
  );
  const open = controls.open;

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    let frame = 0;
    const place = () => {
      const bubble = ref.current;
      if (!bubble) {
        return;
      }
      const next = measurePlacement(bubble, align);
      if (next) {
        setPlacement((current) => (samePlacement(current, next) ? current : next));
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open, align, text]);

  if (!text?.trim()) {
    return null;
  }
  const shown = open ? placement : tooltipDefaultPlacement(align);
  return (
    <span
      ref={ref}
      id={labelled ? controls.tipId : undefined}
      role={labelled ? "tooltip" : undefined}
      data-ff-tooltip={open ? "open" : "closed"}
      data-ff-tooltip-side={open ? shown.side : undefined}
      data-ff-tooltip-align={open ? shown.align : undefined}
      className={tooltipTextClass({ open, align: shown.align, side: shown.side })}
      style={open ? (tooltipShiftStyle(shown) as CSSProperties) : undefined}
    >
      {text}
    </span>
  );
}
