"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { GlobalSearch } from "@/components/shell/GlobalSearch";
import { NotificationCenter } from "@/components/shell/NotificationCenter";
import { WorkspaceNav } from "@/components/shell/WorkspaceNav";
import { WorkspaceProvider } from "@/components/shell/WorkspaceProvider";
import { WorkspaceSwitcher } from "@/components/shell/WorkspaceSwitcher";
import { SessionExpiryBanner } from "@/components/session/SessionExpiryBanner";
import { SessionStatusChip } from "@/components/session/SessionStatusChip";

type WorkspaceShellProps = {
  swaggerUrl: string;
  children: ReactNode;
};

export function WorkspaceShell({ swaggerUrl, children }: WorkspaceShellProps) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <WorkspaceProvider>
      <div className="flex min-h-full">
        <aside
          className={
            navOpen
              ? "fixed inset-y-0 left-0 z-20 flex w-64 flex-col gap-4 border-r border-zinc-200 bg-[var(--background)] p-4 lg:static lg:flex"
              : "hidden w-64 shrink-0 flex-col gap-4 border-r border-zinc-200 bg-[var(--background)] p-4 lg:flex"
          }
        >
          <Link href="/workflows" className="text-sm font-semibold tracking-tight">
            FlowForge
          </Link>
          <WorkspaceSwitcher />
          <WorkspaceNav />
          <p className="mt-auto text-[11px] text-zinc-500">
            <a className="underline decoration-zinc-300 hover:decoration-zinc-600" href={swaggerUrl}>
              OpenAPI / Swagger
            </a>
          </p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-zinc-200 bg-white/80">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-2 py-1 text-xs lg:hidden"
                onClick={() => setNavOpen((open) => !open)}
                aria-expanded={navOpen}
              >
                Menu
              </button>
              <GlobalSearch swaggerUrl={swaggerUrl} />
              <CommandPalette />
              <NotificationCenter />
              <SessionStatusChip />
            </div>
            <div className="px-4 pb-2">
              <SessionExpiryBanner />
            </div>
          </header>
          <div className="flex-1">{children}</div>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
