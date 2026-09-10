"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { embedDeepLinkIsActive } from "@/lib/embed-tenancy-contract";
import {
  editorWorkspaceNav,
  workspaceNavMark,
  type WorkspaceNavItem,
} from "@/lib/workspace-nav";

const groupLabel: Record<WorkspaceNavItem["group"], string> = {
  primary: "Authoring",
  ops: "Operations",
  foundation: "Workspace",
};

type WorkspaceNavProps = {
  variant?: "full" | "rail";
  onNavigate?: () => void;
};

export function WorkspaceNav({ variant = "full", onNavigate }: WorkspaceNavProps) {
  const pathname = usePathname();
  const embed = useEmbedMode();
  const { permissions } = useWorkspace();
  const items = editorWorkspaceNav(permissions, { embed });
  const groups: WorkspaceNavItem["group"][] = ["primary", "ops", "foundation"];
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
                  : "px-2 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
              }
            >
              {groupLabel[group]}
            </p>
            <ul className={rail ? "mt-0 space-y-0.5" : "mt-1 space-y-0.5"}>
              {groupItems.map((item) => {
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
                            ? "flex h-9 w-full items-center justify-center rounded-lg bg-teal-50 text-xs font-semibold text-teal-950"
                            : "flex h-9 w-full items-center justify-center rounded-lg text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
                          : active
                            ? "flex items-center justify-between rounded-lg bg-teal-50 px-2 py-1.5 text-sm font-medium text-teal-950"
                            : "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
                      }
                    >
                      {rail ? (
                        <span aria-hidden="true">{workspaceNavMark(item.id)}</span>
                      ) : (
                        <>
                          <span>{item.label}</span>
                          {item.placeholder ? (
                            <span className="text-[10px] font-medium text-zinc-500">
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
