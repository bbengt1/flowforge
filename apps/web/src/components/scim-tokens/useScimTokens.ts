"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import {
  BLOCKED_QUERY_KEY,
  QueryCacheError,
  scimTokensListQueryKey,
  shouldRetryQuery,
  tryQueryScope,
} from "@/lib/query-cache";
import { scimTokenListProblemIsTerminal, type ScimTokenList } from "@/lib/scim-tokens";
import { listScimTokens } from "@/lib/scim-tokens-client";

function queryProblem(error: unknown): ProblemDetails | null {
  return error instanceof QueryCacheError ? error.problem : null;
}

/** Records only. The create plaintext never reaches this query. */
export function useScimTokenList(identity: DevIdentity, enabled: boolean) {
  const scope = tryQueryScope(identity);
  const key = useMemo(
    () => (scope == null ? null : scimTokensListQueryKey(scope)),
    [scope],
  );
  const query = useQuery({
    queryKey: key ?? BLOCKED_QUERY_KEY,
    enabled: enabled && key != null,
    // 501 (not built yet) and 503 scim_not_configured won't change on retry.
    retry: (failureCount, error) =>
      !scimTokenListProblemIsTerminal(queryProblem(error)) &&
      shouldRetryQuery(failureCount, error),
    queryFn: async (): Promise<ScimTokenList> => {
      const result = await listScimTokens(identity);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
      return result.list;
    },
  });
  return {
    list: query.data ?? null,
    problem: queryProblem(query.error),
    pending: query.isFetching,
    refresh: () => void query.refetch(),
  };
}

export async function invalidateScimTokens(
  client: QueryClient,
  identity: DevIdentity,
): Promise<void> {
  const scope = tryQueryScope(identity);
  const key = scope == null ? null : scimTokensListQueryKey(scope);
  if (!key) {
    return;
  }
  await client.invalidateQueries({ queryKey: key });
}
