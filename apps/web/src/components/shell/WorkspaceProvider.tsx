"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { emptyStoredIdentity, loadDevIdentity, saveDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import {
  bindIdentityToVerified,
  emptyEmbedVerified,
  loadEmbedVerified,
  subscribeEmbedVerified,
} from "@/lib/embed-tenancy-client";
import {
  identityMatchesVerified,
  workspaceMatchesVerified,
} from "@/lib/embed-tenancy-contract";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import {
  clearWorkspaceLookup,
  pickDefaultWorkbench,
  stampSessionPrincipal,
  workspaceLookupBelongsToSession,
  workspaceLookupFromMembership,
} from "@/lib/default-workbench";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup, type DevIdentity } from "@/lib/identity-headers";
import type { CurrentWorkspace, ItemList, Membership } from "@/lib/identity-types";
import {
  capChromeCapabilities,
  isSessionEmbedMode,
} from "@/lib/session-embed-contract";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export type WorkspaceContextValue = {
  identity: DevIdentity;
  ready: boolean;
  permissions: string[] | null;
  roles: string[];
  current: CurrentWorkspace | null;
  memberships: Membership[];
  environment: string;
  switchWorkspace: (membership: Membership) => void;
  embedLocked: boolean;
  tenancyMismatch: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return value;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const embed = useEmbedMode();
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
  );
  const verified = useSyncExternalStore(
    subscribeEmbedVerified,
    loadEmbedVerified,
    emptyEmbedVerified,
  );
  const session = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const headerFallback = useSyncExternalStore(
    subscribeHeaderFallback,
    loadHeaderFallback,
    () => false,
  );
  const [current, setCurrent] = useState<CurrentWorkspace | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [tenancyMismatch, setTenancyMismatch] = useState(false);

  const sessionPrincipal = useMemo(
    () => ({
      active: session.active,
      issuer: session.session.issuer,
      subject: session.session.subject,
      displayName: session.session.displayName,
    }),
    [
      session.active,
      session.session.issuer,
      session.session.subject,
      session.session.displayName,
    ],
  );
  const canListMemberships =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    (!embed || Boolean(verified));
  const lookupOwned =
    hasWorkspaceLookup(identity) &&
    workspaceLookupBelongsToSession(identity, sessionPrincipal);
  const ready = canListMemberships && lookupOwned;

  useEffect(() => {
    if (!embed || !verified) {
      return;
    }
    if (!identityMatchesVerified(identity, verified)) {
      bindIdentityToVerified(identity, verified);
    }
  }, [embed, verified, identity]);

  useEffect(() => {
    if (!canListMemberships) {
      return;
    }
    if (
      session.active &&
      hasWorkspaceLookup(identity) &&
      !workspaceLookupBelongsToSession(identity, sessionPrincipal)
    ) {
      saveDevIdentity(
        clearWorkspaceLookup(stampSessionPrincipal(identity, sessionPrincipal)),
      );
      return;
    }
    let cancelled = false;
    const lookup = lookupOwned;
    void Promise.all([
      lookup
        ? callIdentityProxy<CurrentWorkspace>("/workspace", identity)
        : Promise.resolve(undefined),
      callIdentityProxy<ItemList<Membership>>("/workspaces", identity),
    ]).then(([workspace, list]) => {
      if (cancelled) {
        return;
      }
      if (list.ok) {
        const items = list.data.items ?? [];
        setMemberships(items);
        if (!embed && !lookup) {
          const pick = pickDefaultWorkbench(items);
          if (pick) {
            saveDevIdentity(
              stampSessionPrincipal(
                {
                  ...identity,
                  ...workspaceLookupFromMembership(pick),
                },
                sessionPrincipal,
              ),
            );
          }
        }
      }
      if (!workspace) {
        return;
      }
      if (workspace.ok) {
        if (
          embed &&
          verified &&
          !workspaceMatchesVerified(workspace.data.workspace, verified)
        ) {
          setTenancyMismatch(true);
          setCurrent(null);
          setPermissions([]);
          return;
        }
        setTenancyMismatch(false);
        setCurrent(workspace.data);
        setPermissions(workspace.data.permissions ?? []);
      } else if (workspace.statusCode === 401 || workspace.statusCode === 403) {
        setCurrent(null);
        setPermissions([]);
        if (embed && verified) {
          setTenancyMismatch(true);
        }
      } else {
        setPermissions([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canListMemberships, identity, embed, verified, lookupOwned, session.active, sessionPrincipal]);

  const switchWorkspace = useCallback(
    (membership: Membership) => {
      if (embed && verified) {
        return;
      }
      saveDevIdentity(
        stampSessionPrincipal(
          {
            ...identity,
            ...workspaceLookupFromMembership(membership),
          },
          sessionPrincipal,
        ),
      );
    },
    [embed, verified, identity, sessionPrincipal],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      identity,
      ready,
      permissions:
        ready && !tenancyMismatch
          ? embed
            ? capChromeCapabilities(
                permissions,
                isSessionEmbedMode(session.embedChrome)
                  ? session.embedChrome
                  : null,
              )
            : permissions
          : null,
      roles: ready && !tenancyMismatch ? current?.roles ?? [] : [],
      current: ready && !tenancyMismatch ? current : null,
      memberships: canListMemberships && !tenancyMismatch ? memberships : [],
      environment: identity.workbenchKey.trim(),
      switchWorkspace,
      embedLocked: embed && Boolean(session.embedChrome || verified),
      tenancyMismatch: embed && tenancyMismatch,
    }),
    [
      identity,
      ready,
      canListMemberships,
      permissions,
      current,
      memberships,
      switchWorkspace,
      embed,
      verified,
      session.embedChrome,
      tenancyMismatch,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}
