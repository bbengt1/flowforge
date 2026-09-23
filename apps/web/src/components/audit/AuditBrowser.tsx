"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CollectionLoadMore } from "@/components/CollectionLoadMore";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { auditRowAffordances, canSeeAuditNav } from "@/lib/alert";
import { listWorkspaceAuditEvents } from "@/lib/alert-client";
import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  appendCollectionItems,
} from "@/lib/collection-page";
import { AUDIT_APPEND_ONLY_HELP, AUDIT_NOT_ISOLATION_HELP } from "@/lib/alert-contract";
import type { WorkspaceAuditEvent } from "@/lib/alert-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { redactedJson } from "@/lib/execution";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { callIdentityProxy } from "@/lib/identity-client";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function AuditBrowser() {
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

  const [items, setItems] = useState<WorkspaceAuditEvent[]>([]);
  const [pageNext, setPageNext] = useState("");
  const [query, setQuery] = useState({
    resourceType: "",
    resourceId: "",
    action: "",
  });
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const affordances = auditRowAffordances();

  async function refresh() {
    setPending(true);
    setProblem(null);
    const [list, workspace] = await Promise.all([
      listWorkspaceAuditEvents(identity, {
        resourceType: query.resourceType.trim() || undefined,
        resourceId: query.resourceId.trim() || undefined,
        action: query.action.trim() || undefined,
        limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      }),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
    ]);
    setLastRequestId(list.requestId);
    setPending(false);
    if (workspace.ok) {
      setPermissions(workspace.data.permissions ?? []);
    }
    if (!list.ok) {
      setProblem(list.problem);
      setItems([]);
      setPageNext("");
      return;
    }
    setItems(list.items);
    setPageNext(list.next);
    setStrippedKeys(list.strippedKeys);
  }

  async function loadMore() {
    if (!pageNext) {
      return;
    }
    setPending(true);
    setProblem(null);
    const list = await listWorkspaceAuditEvents(identity, {
      resourceType: query.resourceType.trim() || undefined,
      resourceId: query.resourceId.trim() || undefined,
      action: query.action.trim() || undefined,
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      cursor: pageNext,
    });
    setPending(false);
    if (!list.ok) {
      setProblem(list.problem);
      return;
    }
    setItems((current) => appendCollectionItems(current, list.items));
    setPageNext(list.next);
  }

  useEffect(() => {
    if (!ready) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [ready, identity]);

  const denied = ready && permissions != null && !canSeeAuditNav(permissions);

  return (
    <div className="space-y-6">
      {!ready ? (
        <SessionSetupHint purpose="to browse workspace audit events." />
      ) : null}

      {denied ? (
        <p className="text-sm text-muted-foreground">
          This role cannot view workspace audit (
          <code className="font-mono text-xs">audit.view</code> /{" "}
          <code className="font-mono text-xs">execution.view</code> missing).
        </p>
      ) : null}

      <p className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground">
        {AUDIT_APPEND_ONLY_HELP} {AUDIT_NOT_ISOLATION_HELP}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="text-muted-foreground">Resource type</span>
          <input
            value={query.resourceType}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                resourceType: event.target.value,
              }))
            }
            className="mt-1 w-48 rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
            placeholder="execution"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Resource id</span>
          <input
            value={query.resourceId}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                resourceId: event.target.value,
              }))
            }
            className="mt-1 w-72 rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs"
            placeholder="UUID"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Action</span>
          <input
            value={query.action}
            onChange={(event) =>
              setQuery((current) => ({ ...current, action: event.target.value }))
            }
            className="mt-1 w-56 rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
            placeholder="execution.start"
          />
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={!ready || pending}
          className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Refresh"}
        </button>
      </div>

      {problem ? <ProblemBanner problem={problem} /> : null}

      {strippedKeys.length ? (
        <p role="status" className="text-sm text-warning-foreground">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {items.length} event{items.length === 1 ? "" : "s"} · read-only
        {affordances.canMutate ? " · mutable" : ""}
        {lastRequestId ? (
          <span className="font-mono text-xs"> · {lastRequestId}</span>
        ) : null}
      </p>

      {denied || items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {denied
            ? "No audit rows are shown for this role."
            : "No audit events match. Product audit is GET /audit-events, not the E2.2 isolation stub."}
        </p>
      ) : (
        <ul className="grid gap-3">
          {items.map((event) => (
            <li
              key={event.id}
              className="rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{event.action}</h2>
                  <p className="mt-1 text-sm text-foreground">
                    {event.outcome || "outcome unreported"}
                  </p>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {event.occurredAt || "—"}
                </p>
              </div>
              <dl className="mt-3 grid gap-1 font-mono text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  <dt className="inline text-muted-foreground">correlation </dt>
                  <dd className="inline break-all">
                    {event.correlationId || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">resource </dt>
                  <dd className="inline break-all">
                    {event.resourceType || "id"} {event.resourceId || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">actor </dt>
                  <dd className="inline break-all">{event.actorId || "—"}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">id </dt>
                  <dd className="inline break-all">{event.id}</dd>
                </div>
              </dl>
              {event.details != null ? (
                <pre className="mt-3 overflow-x-auto rounded-lg bg-background p-3 font-mono text-xs text-foreground">
                  {redactedJson(event.details)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <CollectionLoadMore
        next={pageNext}
        pending={pending}
        onLoadMore={() => void loadMore()}
      />
    </div>
  );
}
