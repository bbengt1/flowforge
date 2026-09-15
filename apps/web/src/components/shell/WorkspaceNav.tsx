"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { embedDeepLinkIsActive } from "@/lib/embed-tenancy-contract";
import {
  FF_NAV_GROUP_LABEL_CLASS,
  FF_NAV_ITEM_ACTIVE_CLASS,
  FF_NAV_ITEM_CLASS,
  SHELL_NAV_GROUP_LABELS,
  SHELL_NAV_GROUP_ORDER,
} from "@/lib/shell-restyle";
import {
  editorWorkspaceNav,
  workspaceNavMark,
  type WorkspaceNavItem,
} from "@/lib/workspace-nav";

type WorkspaceNavProps = {
  variant?: "full" | "rail";
  onNavigate?: () => void;
};

export function WorkspaceNav({ variant = "full", onNavigate }: WorkspaceNavProps) {
  const pathname = usePathname();
  const embed = useEmbedMode();
  const { permissions } = useWorkspace();
  const items = editorWorkspaceNav(permissions, { embed });
  const groups = SHELL_NAV_GROUP_ORDER;
  const rail = variant === "rail";

  return (
    <nav
      aria-label="Workspace"
      data-nav-variant={variant}
      className={rail ? "flex flex-col items-center gap-1" : "flex flex-col gap-4"}
    >
      {groups.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) {
          return null;
        }
        return (
          <div key={group} className={rail ? "w-full" : undefined}>
            <p
              className={
                rail
                  ? "sr-only"
                  : `px-2 text-[11px] font-medium tracking-wide uppercase ${FF_NAV_GROUP_LABEL_CLASS}`
              }
            >
              {SHELL_NAV_GROUP_LABELS[group]}
            </p>
            <ul className={rail ? "mt-0 space-y-0.5" : "mt-1 space-y-0.5"}>
              {groupItems.map((item: WorkspaceNavItem) => {
                const active = embedDeepLinkIsActive(item.href, pathname);
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      title={item.label}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={
                        rail
                          ? active
                            ? `flex h-9 w-full items-center justify-center text-xs font-semibold ${FF_NAV_ITEM_CLASS} ${FF_NAV_ITEM_ACTIVE_CLASS}`
                            : `flex h-9 w-full items-center justify-center text-xs font-semibold ${FF_NAV_ITEM_CLASS}`
                          : active
                            ? `flex items-center justify-between px-2 py-1.5 text-sm font-medium ${FF_NAV_ITEM_CLASS} ${FF_NAV_ITEM_ACTIVE_CLASS}`
                            : `flex items-center justify-between px-2 py-1.5 text-sm ${FF_NAV_ITEM_CLASS}`
                      }
                    >
                      {rail ? (
                        <span aria-hidden="true">{workspaceNavMark(item.id)}</span>
                      ) : (
                        <>
                          <span>{item.label}</span>
                          {item.placeholder ? (
                            <span className="text-[10px] font-medium ff-shell-muted">
                              soon
                            </span>
                          ) : null}
                        </>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
