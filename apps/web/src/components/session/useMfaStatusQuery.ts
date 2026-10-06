"use client";

import { useQuery } from "@tanstack/react-query";
import { mfaStatusQueryOptions, type MfaStatus } from "@/lib/oidc-mfa";
import { loadMfaStatus } from "@/lib/oidc-mfa-client";
import { QueryCacheError } from "@/lib/query-cache";

/** Shared GET /session/mfa. Disabled callers do not start a fetch. */
export function useMfaStatusQuery(enabled: boolean) {
  return useQuery({
    ...mfaStatusQueryOptions(),
    enabled,
    queryFn: async (): Promise<MfaStatus> => {
      const result = await loadMfaStatus();
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
      return result.data;
    },
  });
}
