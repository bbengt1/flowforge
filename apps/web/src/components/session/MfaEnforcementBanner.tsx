"use client";

import { useSyncExternalStore } from "react";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useMfaStatusQuery } from "@/components/session/useMfaStatusQuery";
import {
  MFA_ENFORCEMENT_OFF_BANNER,
  showMfaEnforcementOffBanner,
} from "@/lib/oidc-mfa";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { FF_LOUD_WARNING_CLASS } from "@/lib/vault-executions-visual";

/**
 * Persistent development warning. Not dismissible and not focused.
 * Embed mode and enforcement other than "off" render nothing.
 */
export function MfaEnforcementBanner() {
  const embed = useEmbedMode();
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  const query = useMfaStatusQuery(!embed && snapshot.active);
  if (
    !showMfaEnforcementOffBanner({
      embed,
      sessionActive: snapshot.active,
      enforcement: query.data?.enforcement,
    })
  ) {
    return null;
  }

  return (
    <div
      role="status"
      data-mfa-enforcement="off"
      className={`${FF_LOUD_WARNING_CLASS} mb-2 px-4 py-3 text-sm`}
    >
      <p>{MFA_ENFORCEMENT_OFF_BANNER}</p>
    </div>
  );
}
