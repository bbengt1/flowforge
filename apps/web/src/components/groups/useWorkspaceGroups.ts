"use client";

import {
  useInfiniteQuery,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { COLLECTION_PAGE_DEFAULT_LIMIT } from "@/lib/collection-page";
import type { DevIdentity } from "@/lib/identity-headers";
import type { Member } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import {
  BLOCKED_QUERY_KEY,
  QueryCacheError,
  tryQueryScope,
  workspaceGroupDetailQueryKey,
  workspaceGroupPickerQueryKey,
  workspaceGroupsListQueryKey,
  workspaceGroupsRootQueryKey,
} from "@/lib/query-cache";
import type { WorkspaceGroup, WorkspaceGroupDetail } from "@/lib/workspace-groups";
import {
  getWorkspaceGroup,
  listWorkspaceGroups,
  listWorkspaceMembersPage,
} from "@/lib/workspace-groups-client";

function queryProblem(error: unknown): ProblemDetails | null {
  return error instanceof QueryCacheError ? error.problem : null;
}

export function useWorkspaceGroupsScope(identity: DevIdentity): string | null {
  return tryQueryScope(identity);
}

export function useWorkspaceGroupsList(identity: DevIdentity, enabled: boolean) {
  const scope = useWorkspaceGroupsScope(identity);
  const key = useMemo(
    () => (scope == null ? null : workspaceGroupsListQueryKey(scope)),
    [scope],
  );
  const query = useInfiniteQuery({
    queryKey: key ?? BLOCKED_QUERY_KEY,
    enabled: enabled && key != null,
    initialPageParam: "",
    getNextPageParam: (last: { next: string }) => last.next || undefined,
    queryFn: async ({ pageParam }) => {
      const page = await listWorkspaceGroups(identity, {
        limit: COLLECTION_PAGE_DEFAULT_LIMIT,
        cursor: pageParam,
      });
      if (!page.ok) {
        throw new QueryCacheError(page.problem);
      }
      return { items: page.items, next: page.next };
    },
  });
  const groups = useMemo(() => {
    const seen = new Set<string>();
    const out: WorkspaceGroup[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
      }
    }
    return out;
  }, [query.data]);
  return {
    groups,
    loaded: query.isSuccess,
    pending: query.isFetching,
    problem: queryProblem(query.error),
    hasMore: Boolean(query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    refresh: () => void query.refetch(),
  };
}

export function useWorkspaceGroupDetail(
  identity: DevIdentity,
  groupId: string,
  enabled: boolean,
) {
  const scope = useWorkspaceGroupsScope(identity);
  const key = useMemo(
    () => (scope == null ? null : workspaceGroupDetailQueryKey(scope, groupId)),
    [scope, groupId],
  );
  const query = useQuery({
    queryKey: key ?? BLOCKED_QUERY_KEY,
    enabled: enabled && key != null,
    queryFn: async (): Promise<WorkspaceGroupDetail> => {
      const result = await getWorkspaceGroup(identity, groupId);
      if (!result.ok) {
        throw new QueryCacheError(result.problem);
      }
      return result.group;
    },
  });
  return {
    group: query.data ?? null,
    loaded: query.isSuccess,
    pending: query.isFetching,
    problem: queryProblem(query.error),
    refresh: () => void query.refetch(),
  };
}

/** Pages of GET /workspace/members while the add-member picker is open. */
export function useWorkspaceGroupPicker(identity: DevIdentity, enabled: boolean) {
  const scope = useWorkspaceGroupsScope(identity);
  const key = useMemo(
    () => (scope == null ? null : workspaceGroupPickerQueryKey(scope)),
    [scope],
  );
  const query = useInfiniteQuery({
    queryKey: key ?? BLOCKED_QUERY_KEY,
    enabled: enabled && key != null,
    staleTime: 0,
    initialPageParam: "",
    getNextPageParam: (last: { next: string }) => last.next || undefined,
    queryFn: async ({ pageParam }) => {
      const page = await listWorkspaceMembersPage(identity, pageParam);
      if (!page.ok) {
        throw new QueryCacheError(page.problem);
      }
      return { items: page.items, next: page.next };
    },
  });
  const members = useMemo(() => {
    const out: Member[] = [];
    for (const page of query.data?.pages ?? []) {
      out.push(...page.items);
    }
    return out;
  }, [query.data]);
  return {
    members,
    loaded: query.isSuccess,
    pending: query.isFetching,
    problem: queryProblem(query.error),
    hasMore: Boolean(query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    refresh: () => void query.refetch(),
  };
}

/** Drop every cached groups query for this scope after a change. */
export async function invalidateWorkspaceGroups(
  client: QueryClient,
  identity: DevIdentity,
): Promise<void> {
  const scope = tryQueryScope(identity);
  const key = scope == null ? null : workspaceGroupsRootQueryKey(scope);
  if (!key) {
    return;
  }
  await client.invalidateQueries({ queryKey: key });
}

/**
 * After a delete: refresh the list and mark the deleted detail stale
 * without refetching it here (the page is leaving), so a later visit
 * asks the server again and lands on not-found.
 */
export async function afterWorkspaceGroupDeleted(
  client: QueryClient,
  identity: DevIdentity,
  groupId: string,
): Promise<void> {
  const scope = tryQueryScope(identity);
  if (scope == null) {
    return;
  }
  const detailKey = workspaceGroupDetailQueryKey(scope, groupId);
  if (detailKey) {
    await client.invalidateQueries({ queryKey: detailKey, exact: true, refetchType: "none" });
  }
  const listKey = workspaceGroupsListQueryKey(scope);
  if (listKey) {
    await client.invalidateQueries({ queryKey: listKey });
  }
}
