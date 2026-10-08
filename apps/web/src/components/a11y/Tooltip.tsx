"use client";

import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  type FocusEvent,
} from "react";
import {
  TOOLTIP_CLOSED,
  tooltipEscapeDismisses,
  tooltipFocusOpens,
  tooltipIsOpen,
  tooltipReduce,
  tooltipTextClass,
  tooltipTriggerAria,
  type TooltipAlign,
} from "@/lib/a11y-tooltip";

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
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
 * on hover, and Escape closes it. Escape is taken on window capture so
 * an open tooltip closes before a surrounding Dialog sees the key.
 */
export function useTooltip(text: string | undefined): TooltipControls {
  const tipId = `${useId()}-tip`;
  const [state, dispatch] = useReducer(tooltipReduce, TOOLTIP_CLOSED);
  const hasText = Boolean(text?.trim());
  const open = hasText && tooltipIsOpen(state);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (
        tooltipEscapeDismisses({
          key: event.key,
          open: true,
          defaultPrevented: event.defaultPrevented,
        })
      ) {
        event.preventDefault();
        dispatch("escape");
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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

/**
 * The tooltip text. Closed, it is visually hidden but still read by
 * screen readers. Open, it shows as a bubble under the trigger.
 * `labelled` false drops role and id when the parent already carries
 * the text in its own accessible name.
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
  if (!text?.trim()) {
    return null;
  }
  return (
    <span
      id={labelled ? controls.tipId : undefined}
      role={labelled ? "tooltip" : undefined}
      data-ff-tooltip={controls.open ? "open" : "closed"}
      className={tooltipTextClass({ open: controls.open, align })}
    >
      {text}
    </span>
  );
}
