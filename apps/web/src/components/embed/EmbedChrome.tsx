"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { SessionExpiryBanner } from "@/components/session/SessionExpiryBanner";
import { SessionStatusChip } from "@/components/session/SessionStatusChip";
import {
  EMBED_HOST_DISPLAY_HELP,
  EMBED_MOUNT_PREFIX,
  EMBED_URL_SECRET_MESSAGE,
  type EmbedHostDisplay,
} from "@/lib/embed-contract";
import {
  EMBED_HOST_MISMATCH_MESSAGE,
  EMBED_LOCKED_MESSAGE,
  EMBED_TENANCY_MISMATCH_MESSAGE,
  embedDeepLink,
  embedDeepLinkIsActive,
  embedVerifiedLabel,
  hostDisplayConflictsWithVerified,
} from "@/lib/embed-tenancy-contract";
import {
  SESSION_EMBED_CHROME_HELP,
  SESSION_EMBED_ROUTE_MAP_SOURCE,
  SESSION_EMBED_WAITING_HELP,
  sessionEmbedAsVerifiedWorkspace,
  sessionEmbedChromeLabel,
  type SessionEmbedChrome,
} from "@/lib/session-embed-contract";
import { visibleWorkspaceNav } from "@/lib/workspace-nav";

/**
 * ADV-021: retarget this chrome from GET /session via
 * `parseEmbedChromeFromSession` / `EMBED_CHROME_FROM_SESSION`. Host query,
 * assertion leftovers, and catalog guesses are not chrome authority.
 */
type EmbedChromeProps = {
  hostDisplay: EmbedHostDisplay;
  sessionEmbed: SessionEmbedChrome | null;
  rejectedAssertion: boolean;
  sessionActive: boolean;
};

export function EmbedChrome({
  hostDisplay,
  sessionEmbed,
  rejectedAssertion,
  sessionActive,
}: EmbedChromeProps) {
  const pathname = usePathname();
  const { permissions, tenancyMismatch, current } = useWorkspace();
  const chromeVerified = Boolean(sessionActive && sessionEmbed);
  const verified = sessionEmbed
    ? sessionEmbedAsVerifiedWorkspace(sessionEmbed, {
        tenantSlug: current?.tenant.slug,
        workspaceName: current?.workspace.name,
      })
    : null;
  const items = useMemo(
    () =>
      chromeVerified && !tenancyMismatch
        ? visibleWorkspaceNav(permissions).map((item) => ({
            ...item,
            href: embedDeepLink(item.href),
          }))
        : [],
    [permissions, chromeVerified, tenancyMismatch],
  );
  const hostConflict =
    Boolean(verified) && hostDisplayConflictsWithVerified(hostDisplay, verified!);
  const hostPreview =
    !sessionEmbed &&
    Boolean(
      hostDisplay.host ||
        hostDisplay.tenant ||
        hostDisplay.tenantId ||
        hostDisplay.workbench ||
        hostDisplay.displayName,
    );

  return (
    <header className="border-b border-zinc-200 bg-white/80">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Link
          href={EMBED_MOUNT_PREFIX}
          className="text-sm font-semibold tracking-tight"
        >
          FlowForge embed
        </Link>
        {sessionEmbed ? (
          <p
            className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-0.5 font-mono text-xs font-medium text-teal-950"
            title={SESSION_EMBED_CHROME_HELP}
          >
            Verified · {sessionEmbedChromeLabel(sessionEmbed)}
            {verified?.workspaceName ? ` · ${verified.workspaceName}` : ""}
          </p>
        ) : (
          <p className="text-xs text-zinc-500">
            {EMBED_MOUNT_PREFIX} · {SESSION_EMBED_ROUTE_MAP_SOURCE} ·{" "}
            {SESSION_EMBED_WAITING_HELP}
          </p>
        )}
        <div className="ml-auto">
          <SessionStatusChip />
        </div>
      </div>
      {sessionEmbed ? (
        <p className="px-4 pb-2 text-[11px] text-zinc-500">
          {EMBED_LOCKED_MESSAGE} {SESSION_EMBED_CHROME_HELP}
        </p>
      ) : null}
      {items.length > 0 ? (
        <nav
          aria-label="Embed workspace"
          className="flex flex-wrap gap-1 border-t border-zinc-100 px-4 py-2"
        >
          {items.map((item) => {
            const active = embedDeepLinkIsActive(item.href, pathname);
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "rounded-lg bg-teal-50 px-2 py-1 text-xs font-medium text-teal-950"
                    : "rounded-lg px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
      <div className="px-4 pb-2">
        <SessionExpiryBanner />
      </div>
      {rejectedAssertion ? (
        <div
          role="alert"
          className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950"
        >
          {EMBED_URL_SECRET_MESSAGE}
        </div>
      ) : null}
      {tenancyMismatch ? (
        <div
          role="alert"
          className="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950"
        >
          {EMBED_TENANCY_MISMATCH_MESSAGE}
        </div>
      ) : null}
      {hostConflict ? (
        <div
          role="status"
          className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          {EMBED_HOST_MISMATCH_MESSAGE} GET /session verified{" "}
          {verified ? embedVerifiedLabel(verified) : ""}.
          {current?.workspace.workbench_key
            ? ` GET /workspace is ${current.tenant.slug || current.workspace.tenant_id} / ${current.workspace.workbench_key}.`
            : ""}
        </div>
      ) : null}
      {hostPreview ? (
        <p className="px-4 pb-3 text-xs text-zinc-500">
          {EMBED_HOST_DISPLAY_HELP} Host shows{" "}
          {[
            hostDisplay.tenant || hostDisplay.tenantId,
            hostDisplay.workbench,
          ]
            .filter(Boolean)
            .join(" / ") || hostDisplay.host}{" "}
          until GET /session.
        </p>
      ) : null}
      {!sessionActive && !hostPreview ? (
        <p className="px-4 pb-3 text-xs text-zinc-500">{EMBED_HOST_DISPLAY_HELP}</p>
      ) : null}
    </header>
  );
}
