"use client";

import { useCallback, useSyncExternalStore } from "react";
import { IdentityBootstrap } from "@/components/membership/IdentityBootstrap";
import { SessionExpiryBanner } from "@/components/session/SessionExpiryBanner";
import { SessionPanel } from "@/components/session/SessionPanel";
import {
  clearDevIdentity,
  emptyStoredIdentity,
  loadDevIdentity,
  saveDevIdentity,
  subscribeDevIdentity,
} from "@/lib/dev-identity";
import {
  loadHeaderFallback,
  setHeaderFallback,
  subscribeHeaderFallback,
} from "@/lib/header-fallback";
import { emptyDevIdentity, type DevIdentity } from "@/lib/identity-headers";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

const EXAMPLE_IDENTITY: DevIdentity = {
  issuer: "https://flowforge.local",
  subject: "operator-chloe",
  displayName: "Chloe (dev)",
  tenantId: "",
  tenantSlug: "",
  workbenchKey: "",
};

export function IsolationIdentityPanel() {
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

  const updateIdentity = useCallback((next: DevIdentity) => {
    saveDevIdentity(next);
  }, []);

  return (
    <div className="space-y-6">
      <SessionPanel />
      <SessionExpiryBanner />
      <IdentityBootstrap
        identity={identity}
        onChange={updateIdentity}
        onExample={() => updateIdentity({ ...EXAMPLE_IDENTITY })}
        onClear={() => {
          clearDevIdentity();
          setHeaderFallback(false);
          updateIdentity(emptyDevIdentity());
        }}
        headerFallback={headerFallback}
        onHeaderFallbackChange={setHeaderFallback}
        sessionActive={session.active}
      />
    </div>
  );
}
