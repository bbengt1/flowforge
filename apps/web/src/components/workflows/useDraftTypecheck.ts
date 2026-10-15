"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DevIdentity } from "@/lib/identity-headers";
import { tryQueryScope } from "@/lib/query-cache";
import {
  createTypecheckDebouncer,
  typecheckErrorsByNode,
  typecheckView,
  typecheckWorkflowDraft,
  workflowTypecheckQueryKey,
  type TypecheckView,
  type TypecheckError,
} from "@/lib/editor-typecheck";

/**
 * Type-check the saved draft after each save or load (new revision),
 * debounced 1.5s. Keystrokes never trigger it: the route checks the stored
 * draft and is limited to 60 calls a minute per user. One query per
 * revision, so a late response for an older revision is never shown as
 * current.
 */
export function useDraftTypecheck(input: {
  identity: DevIdentity;
  workflowId: string | null;
  revision: number | null;
  dirty: boolean;
  enabled: boolean;
}): {
  view: TypecheckView;
  byNode: Map<string, TypecheckError[]>;
  workflowErrors: TypecheckError[];
} {
  const { identity, workflowId, revision, dirty, enabled } = input;
  const scope = tryQueryScope(identity);
  const [checkRevision, setCheckRevision] = useState<number | null>(null);
  const debouncer = useRef<ReturnType<typeof createTypecheckDebouncer<number>> | null>(null);

  useEffect(() => {
    const d = createTypecheckDebouncer<number>((rev) => setCheckRevision(rev));
    debouncer.current = d;
    return () => d.cancel();
  }, []);

  useEffect(() => {
    if (!enabled || revision === null || !workflowId) {
      debouncer.current?.cancel();
      return;
    }
    debouncer.current?.request(revision);
  }, [enabled, revision, workflowId]);

  const active =
    enabled && scope !== null && workflowId !== null && checkRevision !== null;
  const query = useQuery({
    queryKey: active
      ? workflowTypecheckQueryKey(scope, workflowId, checkRevision)
      : ["flowforge", "typecheck", "disabled"],
    enabled: active,
    // 429/503 are results, not retries: replaying would spend the budget.
    retry: false,
    staleTime: Infinity,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
    queryFn: () => typecheckWorkflowDraft(identity, workflowId as string),
  });

  const pendingDebounce = enabled && revision !== null && checkRevision !== revision;
  const view = typecheckView({
    outcome: active ? (query.data ?? null) : null,
    pending: pendingDebounce || (active && query.isFetching),
    savedRevision: revision,
    dirty,
  });
  const grouped = useMemo(
    () =>
      view.state === "failed"
        ? typecheckErrorsByNode(view.errors)
        : { byNode: new Map<string, TypecheckError[]>(), workflow: [] },
    [view],
  );
  return { view, byNode: grouped.byNode, workflowErrors: grouped.workflow };
}
