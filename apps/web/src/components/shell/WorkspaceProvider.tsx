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
import { emptyStoredIdentity, loadDevIdentity, saveDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { callIdentityProxy } from "@/lib/identity-client";
import { hasOperatorCaller, hasWorkspaceLookup, type DevIdentity } from "@/lib/identity-headers";
import type { CurrentWorkspace, ItemList, Membership } from "@/lib/identity-types";
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
  const identity = useSyncExternalStore(
    subscribeDevIdentity,
    loadDevIdentity,
    emptyStoredIdentity,
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

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void Promise.all([
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
      callIdentityProxy<ItemList<Membership>>("/workspaces", identity),
    ]).then(([workspace, list]) => {
      if (cancelled) {
        return;
      }
      if (workspace.ok) {
        setCurrent(workspace.data);
        setPermissions(workspace.data.permissions ?? []);
      } else if (workspace.statusCode === 401 || workspace.statusCode === 403) {
        setCurrent(null);
        setPermissions([]);
      } else {
        setPermissions([]);
      }
      if (list.ok) {
        setMemberships(list.data.items ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready, identity]);

  const switchWorkspace = useCallback(
    (membership: Membership) => {
      saveDevIdentity({
        ...identity,
        tenantId: membership.workspace.tenant_id,
        tenantSlug: membership.tenant.slug,
        workbenchKey: membership.workspace.workbench_key,
      });
    },
    [identity],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      identity,
      ready,
      permissions: ready ? permissions : null,
      roles: ready ? current?.roles ?? [] : [],
      current: ready ? current : null,
      memberships: ready ? memberships : [],
      environment: identity.workbenchKey.trim(),
      switchWorkspace,
    }),
    [identity, ready, permissions, current, memberships, switchWorkspace],
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}
