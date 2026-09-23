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
import { BootstrapGate } from "@/components/bootstrap/BootstrapGate";
import { MfaStepUpHost } from "@/components/session/MfaStepUpHost";
import { MustChangePasswordGate } from "@/components/session/MustChangePasswordGate";
import { SignedOutGate } from "@/components/session/SignedOutGate";
import { EmbedChrome } from "@/components/embed/EmbedChrome";
import { EmbedDeepLinkGuard } from "@/components/embed/EmbedDeepLinkGuard";
import { EmbedExchangeGate } from "@/components/embed/EmbedExchangeGate";
import { EmbedModeProvider } from "@/components/embed/EmbedMode";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { GlobalSearch } from "@/components/shell/GlobalSearch";
import { NotificationCenter } from "@/components/shell/NotificationCenter";
import { WorkspaceNav } from "@/components/shell/WorkspaceNav";
import { useWorkspace, WorkspaceProvider } from "@/components/shell/WorkspaceProvider";
import { WorkspaceSwitcher } from "@/components/shell/WorkspaceSwitcher";
import { SessionExpiryBanner } from "@/components/session/SessionExpiryBanner";
import { SessionStatusChip } from "@/components/session/SessionStatusChip";
import { ThemePreferenceControl } from "@/components/theme/ThemePreference";
import type { ColorTheme } from "@/lib/theme-preference";
import { editorNavMode, isWorkflowEditorPath } from "@/lib/editor-chrome";
import {
  FF_SHELL_ASIDE_CLASS,
  FF_SHELL_HEADER_CLASS,
  FF_SHELL_VALUE,
} from "@/lib/shell-restyle";
import {
  FF_SHELL_ROOT_CLASS,
  FF_SHELL_ROOT_VALUE,
} from "@/lib/visual-tokens";
import {
  isEmbedUiPath,
  urlRejectedAssertion,
} from "@/lib/embed-contract";
import { isPortalHostPath } from "@/lib/portal-adapter-contract";
import {
  emptyEmbedVerified,
  loadEmbedVerified,
  subscribeEmbedVerified,
} from "@/lib/embed-tenancy-client";
import {
  EMBED_TENANCY_MISMATCH_MESSAGE,
  hostDisplayFromSearch,
} from "@/lib/embed-tenancy-contract";
import { isOidcCallbackPath } from "@/lib/oidc-mfa";
import { loadCurrentSession } from "@/lib/session-client";
import { isSessionEmbedMode } from "@/lib/session-embed-contract";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type WorkspaceShellProps = {
  swaggerUrl: string;
  colorTheme?: ColorTheme;
  children: ReactNode;
  embedMount?: boolean;
  rejectedAssertion?: boolean;
  hasSessionCookie?: boolean;
  /** Configured PORTAL_ISSUER (server env). */
  portalIssuer?: string;
  /** Configured EMBED_ISSUER (server env). */
  embedIssuer?: string;
  portalReferrerAllowlist?: readonly string[];
};

export function WorkspaceShell({
  swaggerUrl,
  colorTheme = "dark",
  children,
  embedMount = false,
  rejectedAssertion: rejectedAssertionProp = false,
  hasSessionCookie = false,
  portalIssuer = "",
  embedIssuer = "",
  portalReferrerAllowlist = [],
}: WorkspaceShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();
  const [navPath, setNavPath] = useState(pathname);
  if (navPath !== pathname) {
    setNavPath(pathname);
    setNavOpen(false);
  }
  const editorRoute = isWorkflowEditorPath(pathname);
  const navMode = editorNavMode({
    pathname,
    overlayOpen: navOpen,
    compact: editorRoute && navOpen,
  });
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
  // Mount prefix selects the embed layout. Chrome mode is session.embed only.
  const embed = embedMount || isEmbedUiPath(pathname);
  const portalHost = isPortalHostPath(pathname);
  const rejectedAssertion =
    (embed && urlRejectedAssertion(search, hash)) || rejectedAssertionProp;
  const verified = useSyncExternalStore(
    subscribeEmbedVerified,
    loadEmbedVerified,
    emptyEmbedVerified,
  );
  const hostDisplay = hostDisplayFromSearch(search);

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

  if (portalHost) {
    return <>{children}</>;
  }

  // IdP redirect lands here signed-out. Skip Login, the wizard, and MFA.
  if (!embed && isOidcCallbackPath(pathname)) {
    return <EmbedModeProvider embed={false}>{children}</EmbedModeProvider>;
  }

  const skipLink = (
    <a href="#main-content" className="skip-link">
      Skip to main content
    </a>
  );

  const shell = embed ? (
    <WorkspaceProvider>
      <EmbedDeepLinkGuard>
        <div
          className={`${FF_SHELL_ROOT_CLASS} flex h-full min-h-0 flex-col overflow-hidden`}
          data-ff-tokens={FF_SHELL_ROOT_VALUE}
        >
          {skipLink}
          <EmbedChrome
            hostDisplay={hostDisplay}
            sessionEmbed={session.embedChrome}
            rejectedAssertion={rejectedAssertion}
            sessionActive={session.active}
            sessionChecked={sessionChecked}
            swaggerUrl={swaggerUrl}
          />
          <div id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-auto outline-none">
            {!sessionChecked ? (
              <p className="ff-shell-muted px-6 py-10 text-sm">
                Checking FlowForge session…
              </p>
            ) : session.active &&
              isSessionEmbedMode(session.embedChrome) &&
              verified ? (
              <EmbedTenancyGate>{children}</EmbedTenancyGate>
            ) : (
              <EmbedExchangeGate
                search={search}
                portalIssuer={portalIssuer}
                embedIssuer={embedIssuer}
                portalReferrerAllowlist={portalReferrerAllowlist}
              />
            )}
          </div>
        </div>
      </EmbedDeepLinkGuard>
    </WorkspaceProvider>
  ) : (
    <WorkspaceProvider>
      <BootstrapGate>
      <SignedOutGate>
      <MustChangePasswordGate>
      <div
        className={`${FF_SHELL_ROOT_CLASS} flex h-full min-h-0 overflow-hidden`}
        data-ff-tokens={FF_SHELL_ROOT_VALUE}
      >
        {skipLink}
        {editorRoute && navOpen ? (
          <button
            type="button"
            className="ff-shell-scrim fixed inset-0 z-10 lg:hidden"
            aria-label="Close workspace navigation"
            onClick={() => setNavOpen(false)}
          />
        ) : null}
        <aside
          id="workspace-nav"
          aria-label="Workspace navigation"
          data-nav-mode={navMode}
          data-ff-shell={FF_SHELL_VALUE}
          className={
            editorRoute
              ? navOpen
                ? `${FF_SHELL_ASIDE_CLASS} fixed inset-y-0 start-0 z-20 flex w-64 flex-col gap-4 p-4 lg:static lg:flex lg:w-14 lg:items-center lg:gap-3 lg:p-2`
                : `${FF_SHELL_ASIDE_CLASS} hidden w-14 shrink-0 flex-col items-center gap-3 p-2 lg:flex`
              : navOpen
                ? `${FF_SHELL_ASIDE_CLASS} fixed inset-y-0 start-0 z-20 flex w-64 flex-col gap-4 p-4 lg:static lg:flex`
                : `${FF_SHELL_ASIDE_CLASS} hidden w-64 shrink-0 flex-col gap-4 p-4 lg:flex`
          }
        >
          <Link
            href="/workflows"
            className={
              editorRoute && !navOpen
                ? "ff-shell-brand text-xs font-semibold tracking-tight"
                : "ff-shell-brand text-sm font-semibold tracking-tight"
            }
            onClick={() => setNavOpen(false)}
          >
            {editorRoute && !navOpen ? "FF" : "FlowForge"}
          </Link>
          {!editorRoute || navOpen ? <WorkspaceSwitcher /> : null}
          <WorkspaceNav
            variant={editorRoute && !navOpen ? "rail" : "full"}
            onNavigate={() => setNavOpen(false)}
          />
          {editorRoute && !navOpen ? (
            <p className="sr-only">Workflows is the way back to workflow home.</p>
          ) : (
            <p className="ff-shell-muted mt-auto text-[11px]">
              <Link
                className="underline decoration-[var(--ff-border)] hover:decoration-[var(--ff-muted)]"
                href="/settings"
              >
                Health / OpenAPI
              </Link>
            </p>
          )}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            className={FF_SHELL_HEADER_CLASS}
            data-ff-shell={FF_SHELL_VALUE}
          >
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <button
                type="button"
                className="ff-shell-control px-2 py-1 text-xs lg:hidden"
                onClick={() => setNavOpen((open) => !open)}
                aria-expanded={navOpen}
                aria-controls="workspace-nav"
                aria-label={navOpen ? "Close workspace navigation" : "Open workspace navigation"}
              >
                Menu
              </button>
              {editorRoute ? <WorkspaceSwitcher compact /> : null}
              <GlobalSearch swaggerUrl={swaggerUrl} />
              <CommandPalette />
              <NotificationCenter />
              <ThemePreferenceControl theme={colorTheme} />
              <SessionStatusChip />
            </div>
            <div className="px-4 pb-2">
              <SessionExpiryBanner />
            </div>
          </header>
          <div id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-auto outline-none">
            <MfaStepUpHost />
            {children}
          </div>
        </div>
      </div>
      </MustChangePasswordGate>
      </SignedOutGate>
      </BootstrapGate>
    </WorkspaceProvider>
  );

  return <EmbedModeProvider embed={embed}>{shell}</EmbedModeProvider>;
}

function EmbedTenancyGate({ children }: { children: ReactNode }) {
  const { tenancyMismatch } = useWorkspace();
  if (tenancyMismatch) {
    return (
      <p className="ff-shell-muted px-6 py-10 text-sm">
        {EMBED_TENANCY_MISMATCH_MESSAGE}
      </p>
    );
  }
  return children;
}
