import type { QueryClient } from "@tanstack/react-query";
import {
  MFA_STATUS_QUERY_ROOT,
  mfaStatusIdentity,
  type MfaStatusIdentity,
} from "./oidc-mfa.ts";
import { getSessionSnapshot, subscribeSession } from "./session-store.ts";

function sameMfaStatusIdentity(
  left: MfaStatusIdentity,
  right: MfaStatusIdentity,
): boolean {
  return (
    left.issuer === right.issuer &&
    left.subject === right.subject &&
    left.sessionId === right.sessionId
  );
}

/**
 * Drop cached GET /session/mfa when the signed-in identity changes.
 * markSessionStale, logout (clearSession), and login (setActiveSession)
 * all publish through the session snapshot.
 */
export function bindMfaStatusCache(client: QueryClient): () => void {
  let previous = mfaStatusIdentity(getSessionSnapshot().session);
  return subscribeSession(() => {
    const next = mfaStatusIdentity(getSessionSnapshot().session);
    if (sameMfaStatusIdentity(previous, next)) {
      return;
    }
    previous = next;
    client.removeQueries({ queryKey: MFA_STATUS_QUERY_ROOT });
  });
}

/** Step-up opened on 403 mfa-required. Refetch so a 60s "off" cannot stick. */
export function invalidateMfaStatusQueries(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: MFA_STATUS_QUERY_ROOT });
}
