"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

function subscribeBrowserLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}
import { EmbedExchangeGate } from "@/components/embed/EmbedExchangeGate";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { GlobalSearch } from "@/components/shell/GlobalSearch";
import { NotificationCenter } from "@/components/shell/NotificationCenter";
import { WorkspaceNav } from "@/components/shell/WorkspaceNav";
import { WorkspaceProvider } from "@/components/shell/WorkspaceProvider";
import { WorkspaceSwitcher } from "@/components/shell/WorkspaceSwitcher";
import { SessionExpiryBanner } from "@/components/session/SessionExpiryBanner";
import { SessionStatusChip } from "@/components/session/SessionStatusChip";
import {
  EMBED_MOUNT_PREFIX,
  EMBED_URL_SECRET_MESSAGE,
  isEmbedUiPath,
  urlRejectedAssertion,
} from "@/lib/embed-contract";
import { loadCurrentSession } from "@/lib/session-client";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type WorkspaceShellProps = {
  swaggerUrl: string;
  children: ReactNode;
  embedMount?: boolean;
  rejectedAssertion?: boolean;
  hasSessionCookie?: boolean;
};

export function WorkspaceShell({
  swaggerUrl,
  children,
  embedMount = false,
  rejectedAssertion: rejectedAssertionProp = false,
  hasSessionCookie = false,
}: WorkspaceShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const [sessionChecked, setSessionChecked] = useState(
    !(embedMount && hasSessionCookie),
  );
  const search = useSyncExternalStore(
    subscribeBrowserLocation,
    () => window.location.search,
    () => "",
  );
  const hash = useSyncExternalStore(
    subscribeBrowserLocation,
    () => window.location.hash,
    () => "",
  );
  const embed = embedMount || isEmbedUiPath(pathname);
  const rejectedAssertion =
    (embed && urlRejectedAssertion(search, hash)) || rejectedAssertionProp;

  useEffect(() => {
    if (!embed) {
      return;
    }
    let cancelled = false;
    void loadCurrentSession().finally(() => {
      if (!cancelled) {
        setSessionChecked(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [embed]);

  if (embed) {
    return (
      <WorkspaceProvider>
        <div className="flex min-h-full flex-col">
          <header className="border-b border-zinc-200 bg-white/80">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link
                href={EMBED_MOUNT_PREFIX}
                className="text-sm font-semibold tracking-tight"
              >
                FlowForge embed
              </Link>
              <p className="text-xs text-zinc-500">
                {EMBED_MOUNT_PREFIX} · host identity is display-only until
                assertion exchange.
              </p>
              <div className="ml-auto">
                <SessionStatusChip />
              </div>
            </div>
            <div className="px-4 pb-2">
              <SessionExpiryBanner />
            </div>
          </header>
          {rejectedAssertion ? (
            <div
              role="alert"
              className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950"
            >
              {EMBED_URL_SECRET_MESSAGE}
            </div>
          ) : null}
          <div className="flex-1">
            {!sessionChecked ? (
              <p className="px-6 py-10 text-sm text-zinc-500">
                Checking FlowForge session…
              </p>
            ) : session.active ? (
              children
            ) : (
              <EmbedExchangeGate search={search} />
            )}
          </div>
        </div>
      </WorkspaceProvider>
    );
  }

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
