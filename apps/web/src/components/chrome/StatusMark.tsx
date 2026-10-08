"use client";

import { TooltipText, useTooltip } from "@/components/a11y/Tooltip";
import {
  FF_STATUS_TIP_TRIGGER_CLASS,
  type TooltipAlign,
} from "@/lib/a11y-tooltip";
import { FF_STATUS_VALUE } from "@/lib/status-embed-visual";

type StatusMarkProps = {
  icon: string;
  label: string;
  description?: string;
  className?: string;
  role?: "status" | "presentation";
  /**
   * The mark sits inside a row that is already interactive (a button or
   * a listbox option). It takes no tab stop of its own; the description
   * stays in the row's accessible name and still shows on hover.
   */
  nested?: boolean;
  /** Which edge of the mark the open tooltip lines up with. */
  tipAlign?: TooltipAlign;
};

/**
 * V.7 shared icon+text status mark. Standalone and `/embed/v1`
 * use this one component — do not fork an embed status tree.
 *
 * With a description, the mark is a keyboard tab stop. Focus or hover
 * shows the description as a tooltip, Escape hides it, and
 * aria-describedby points at it. The description is never hover-only.
 */
export function StatusMark({
  icon,
  label,
  description,
  className,
  role = "status",
  nested = false,
  tipAlign = "end",
}: StatusMarkProps) {
  const tip = useTooltip(description);
  const hasTip = Boolean(description?.trim());
  const focusable = hasTip && !nested && role === "status";
  return (
    <span
      role={role}
      data-ff-status={FF_STATUS_VALUE}
      data-ff-status-tip={hasTip ? (nested ? "nested" : "focus") : undefined}
      tabIndex={focusable ? 0 : undefined}
      aria-label={focusable ? label : undefined}
      {...(focusable ? tip.describedBy : {})}
      {...(focusable ? tip.focusProps : {})}
      {...(hasTip ? tip.hoverProps : {})}
      className={`inline-flex items-center gap-1.5 ${
        hasTip ? FF_STATUS_TIP_TRIGGER_CLASS : ""
      } ${className ?? ""}`
        .replace(/\s+/g, " ")
        .trim()}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      <TooltipText
        controls={tip}
        text={description}
        align={tipAlign}
        labelled={focusable}
      />
    </span>
  );
}
