"use client";

import { useCallback, useSyncExternalStore } from "react";
import { IdentityBootstrap } from "@/components/membership/IdentityBootstrap";
import {
  clearDevIdentity,
  emptyStoredIdentity,
  loadDevIdentity,
  saveDevIdentity,
  subscribeDevIdentity,
} from "@/lib/dev-identity";
import { emptyDevIdentity, type DevIdentity } from "@/lib/identity-headers";

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

  const updateIdentity = useCallback((next: DevIdentity) => {
    saveDevIdentity(next);
  }, []);

  return (
    <IdentityBootstrap
      identity={identity}
      onChange={updateIdentity}
      onExample={() => updateIdentity({ ...EXAMPLE_IDENTITY })}
      onClear={() => {
        clearDevIdentity();
        updateIdentity(emptyDevIdentity());
      }}
    />
  );
}
