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

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity) &&
    (!embed || Boolean(verified));

  useEffect(() => {
    if (!embed || !verified) {
      return;
    }
    if (!identityMatchesVerified(identity, verified)) {
      bindIdentityToVerified(identity, verified);
    }
  }, [embed, verified, identity]);

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
      if (list.ok) {
        setMemberships(list.data.items ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready, identity, embed, verified]);

  const switchWorkspace = useCallback(
    (membership: Membership) => {
      if (embed && verified) {
        return;
      }
      saveDevIdentity({
        ...identity,
        tenantId: membership.workspace.tenant_id,
        tenantSlug: membership.tenant.slug,
        workbenchKey: membership.workspace.workbench_key,
      });
    },
    [embed, verified, identity],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      identity,
      ready,
      permissions: ready && !tenancyMismatch ? permissions : null,
      roles: ready && !tenancyMismatch ? current?.roles ?? [] : [],
      current: ready && !tenancyMismatch ? current : null,
      memberships: ready && !tenancyMismatch ? memberships : [],
      environment: identity.workbenchKey.trim(),
      switchWorkspace,
      embedLocked: embed && Boolean(verified),
      tenancyMismatch: embed && tenancyMismatch,
    }),
    [
      identity,
      ready,
      permissions,
      current,
      memberships,
      switchWorkspace,
      embed,
      verified,
      tenancyMismatch,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}
