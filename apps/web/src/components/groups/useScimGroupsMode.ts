"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  BLOCKED_QUERY_KEY,
  QueryCacheError,
  scimGroupsModeQueryKey,
  shouldRetryQuery,
  tryQueryScope,
} from "@/lib/query-cache";
import { scimTokenListProblemIsTerminal, type ScimGroupsMode } from "@/lib/scim-tokens";
import { listScimTokens } from "@/lib/scim-tokens-client";

function queryProblem(error: unknown): ProblemDetails | null {
  return error instanceof QueryCacheError ? error.problem : null;
}

/**
 * SCIM Groups mode for the groups screens, read from the token list's
 * `groupsMode`. The list needs MFA step-up, so this read is quiet: a 403
 * `mfa-required` leaves the mode unknown (null) instead of opening the
 * step-up dialog on a page that didn't ask for it. Only the mode is
 * cached under this key, never a token record.
 */
export function useScimGroupsMode(identity: DevIdentity, enabled: boolean) {
  const scope = tryQueryScope(identity);
  const key = useMemo(
    () => (scope == null ? null : scimGroupsModeQueryKey(scope)),
    [scope],
  );
  const query = useQuery({
    queryKey: key ?? BLOCKED_QUERY_KEY,
    enabled: enabled && key != null,
    retry: (failureCount, error) =>
      !scimTokenListProblemIsTerminal(queryProblem(error)) &&
      shouldRetryQuery(failureCount, error),
    queryFn: async (): Promise<ScimGroupsMode | null> => {
      const result = await listScimTokens(identity, { quietMfa: true });
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
      return result.list.groupsMode;
    },
  });
  return {
    mode: query.data ?? null,
    loaded: query.isSuccess,
  };
}

/**
 * A 409 `group_managed_by_scim` proves the instance is in `groups` mode.
 * Record just that mode so the groups screens in this scope lock managed
 * groups even when the token list couldn't be read.
 */
export function noteScimGroupsMode(
  client: QueryClient,
  identity: DevIdentity,
  mode: ScimGroupsMode,
): void {
  const scope = tryQueryScope(identity);
  const key = scope == null ? null : scimGroupsModeQueryKey(scope);
  if (!key) {
    return;
  }
  client.setQueryData(key, mode);
}
