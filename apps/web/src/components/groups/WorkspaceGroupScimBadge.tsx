import { StatusMark } from "@/components/chrome/StatusMark";
import type { TooltipAlign } from "@/lib/a11y-tooltip";
import { FF_STATUS_OTHER_CLASS } from "@/lib/status-embed-visual";
import {
  workspaceGroupScimBadge,
  type WorkspaceGroupManagement,
} from "@/lib/workspace-groups";

/**
 * Small chip for a group a SCIM token created. Uses the shared status
 * mark, so it is one keyboard stop with the plain explanation as its
 * tooltip (focus or hover opens it, Escape closes it). Nothing for a
 * local group.
 */
export function WorkspaceGroupScimBadge({
  management,
  tipAlign,
}: {
  management: WorkspaceGroupManagement;
  tipAlign?: TooltipAlign;
}) {
  const badge = workspaceGroupScimBadge(management);
  if (!badge) {
    return null;
  }
  return (
    <span data-group-scim-badge={management} className="inline-flex">
      <StatusMark
        icon="⇄"
        label={badge.label}
        description={badge.description}
        tipAlign={tipAlign}
        className={`rounded-full px-2.5 py-0.5 text-xs ${FF_STATUS_OTHER_CLASS}`}
      />
    </span>
  );
}
