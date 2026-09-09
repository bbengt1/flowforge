"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import {
  navItemIsActive,
  visibleWorkspaceNav,
  type WorkspaceNavItem,
} from "@/lib/workspace-nav";

const groupLabel: Record<WorkspaceNavItem["group"], string> = {
  primary: "Authoring",
  ops: "Operations",
  foundation: "Workspace",
};

export function WorkspaceNav() {
  const pathname = usePathname();
  const { permissions } = useWorkspace();
  const items = visibleWorkspaceNav(permissions);
  const groups: WorkspaceNavItem["group"][] = ["primary", "ops", "foundation"];

  return (
    <nav aria-label="Workspace" className="flex flex-col gap-4">
      {groups.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) {
          return null;
        }
        return (
          <div key={group}>
            <p className="px-2 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
              {groupLabel[group]}
            </p>
            <ul className="mt-1 space-y-0.5">
              {groupItems.map((item) => {
                const active = navItemIsActive(item.href, pathname);
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={
                        active
                          ? "flex items-center justify-between rounded-lg bg-teal-50 px-2 py-1.5 text-sm font-medium text-teal-950"
                          : "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
                      }
                    >
                      <span>{item.label}</span>
                      {item.placeholder ? (
                        <span className="text-[10px] font-medium text-zinc-500">
                          soon
                        </span>
                      ) : null}
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
