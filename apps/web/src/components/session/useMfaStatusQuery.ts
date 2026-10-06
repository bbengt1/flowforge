"use client";

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { loadMfaStatus } from "@/lib/oidc-mfa-client";
import {
  mfaStatusQueryOptions,
  type MfaStatus,
} from "@/lib/oidc-mfa";
import { QueryCacheError } from "@/lib/query-cache";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

/** Shared GET /session/mfa for the signed-in identity. Disabled callers do not fetch. */
export function useMfaStatusQuery(enabled: boolean) {
  const snapshot = useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    getSessionSnapshot,
  );
  return useQuery({
    ...mfaStatusQueryOptions(snapshot.session),
    enabled: enabled && snapshot.active,
    queryFn: async (): Promise<MfaStatus> => {
      const result = await loadMfaStatus();
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
      return result.data;
    },
  });
}
