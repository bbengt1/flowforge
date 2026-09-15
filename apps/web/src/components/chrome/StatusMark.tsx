import { FF_STATUS_VALUE } from "@/lib/status-embed-visual";

type StatusMarkProps = {
  icon: string;
  label: string;
  description?: string;
  className?: string;
  role?: "status" | "presentation";
};

/**
 * V.7 shared icon+text status mark. Standalone and `/embed/v1`
 * use this one component — do not fork an embed status tree.
 */
export function StatusMark({
  icon,
  label,
  description,
  className,
  role = "status",
}: StatusMarkProps) {
  return (
    <span
      role={role}
      data-ff-status={FF_STATUS_VALUE}
      className={`inline-flex items-center gap-1.5 ${className ?? ""}`.trim()}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {description ? <span className="sr-only">{description}</span> : null}
    </span>
  );
}
