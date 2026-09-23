"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CollectionLoadMore } from "@/components/CollectionLoadMore";
import { AlertSeverityBadge } from "@/components/alerts/AlertSeverityBadge";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  alertKindLabel,
  alertStatusLabel,
  canSeeAlertsNav,
  filterAlertList,
} from "@/lib/alert";
import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  appendCollectionItems,
} from "@/lib/collection-page";
import { listAlerts } from "@/lib/alert-client";
import { executionCorrelateHref } from "@/lib/alert-contract";
import {
  ALERT_KINDS,
  ALERT_STATUSES,
  type OperationalAlert,
} from "@/lib/alert-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { callIdentityProxy } from "@/lib/identity-client";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function AlertList() {
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

  const [items, setItems] = useState<OperationalAlert[]>([]);
  const [pageNext, setPageNext] = useState("");
  const [query, setQuery] = useState({
    q: "",
    kind: "",
    status: "open",
    resourceType: "",
    resourceId: "",
  });
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  const visible = useMemo(
    () => filterAlertList(items, query),
    [items, query],
  );

  async function refresh() {
    setPending(true);
    setProblem(null);
    const [list, workspace] = await Promise.all([
      listAlerts(identity, {
        kind: query.kind.trim() || undefined,
        status: query.status.trim() || undefined,
        resourceType: query.resourceType.trim() || undefined,
        resourceId: query.resourceId.trim() || undefined,
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
    const list = await listAlerts(identity, {
      kind: query.kind.trim() || undefined,
      status: query.status.trim() || undefined,
      resourceType: query.resourceType.trim() || undefined,
      resourceId: query.resourceId.trim() || undefined,
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
    // Reload when session, workspace, or documented #58 filters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [
    ready,
    identity,
    query.kind,
    query.status,
    query.resourceType,
    query.resourceId,
  ]);

  const denied = ready && permissions != null && !canSeeAlertsNav(permissions);

  return (
    <div className="space-y-6">
      {!ready ? (
        <SessionSetupHint purpose="to list operational alerts." />
      ) : null}

      {denied ? (
        <p className="text-sm text-fg">
          This role cannot view alerts (
          <code className="font-mono text-xs">alert.view</code> missing).
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="text-fg">Filter</span>
          <input
            type="search"
            value={query.q}
            onChange={(event) =>
              setQuery((current) => ({ ...current, q: event.target.value }))
            }
            className="mt-1 w-64 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
            placeholder="Kind, action, correlation, resource id"
          />
        </label>
        <label className="block text-sm">
          <span className="text-fg">Kind</span>
          <select
            value={query.kind}
            onChange={(event) =>
              setQuery((current) => ({ ...current, kind: event.target.value }))
            }
            className="mt-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {ALERT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {alertKindLabel(kind)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-fg">Status</span>
          <select
            value={query.status}
            onChange={(event) =>
              setQuery((current) => ({ ...current, status: event.target.value }))
            }
            className="mt-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {ALERT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {alertStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-fg">Resource type</span>
          <input
            type="text"
            value={query.resourceType}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                resourceType: event.target.value,
              }))
            }
            className="mt-1 w-40 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm"
            placeholder="execution"
          />
        </label>
        <label className="block text-sm">
          <span className="text-fg">Resource id</span>
          <input
            type="text"
            value={query.resourceId}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                resourceId: event.target.value,
              }))
            }
            className="mt-1 w-64 rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-xs"
            placeholder="UUID"
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
        <p role="status" className="text-sm text-fg">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      <p className="text-sm text-fg">
        {visible.length} alert{visible.length === 1 ? "" : "s"} · identifiers
        only, never secrets
        {lastRequestId ? (
          <span className="font-mono text-xs"> · {lastRequestId}</span>
        ) : null}
      </p>

      {denied || visible.length === 0 ? (
        <p className="text-sm text-fg">
          {denied
            ? "No alerts are shown for this role."
            : "No alerts match. Authorization, replay, policy, and redaction failures appear here when the API emits them."}
        </p>
      ) : (
        <ul className="grid gap-3">
          {visible.map((item) => {
            const executionHref = executionCorrelateHref(
              item.resourceType,
              item.resourceId,
            );
            return (
              <li
                key={item.id}
                className="rounded-xl border border-border bg-bg p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">
                      <Link
                        href={`/alerts/${item.id}`}
                        className="underline decoration-border underline-offset-2 hover:decoration-muted-foreground"
                      >
                        {alertKindLabel(item.kind)}
                      </Link>
                    </h2>
                    <p className="mt-1 text-sm text-fg">
                      {[item.action, item.outcome, item.code]
                        .filter(Boolean)
                        .join(" · ") || "Identifiers only."}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <AlertSeverityBadge
                      severity={item.severity}
                      kind={item.kind}
                    />
                    <p className="text-sm font-medium">
                      {alertStatusLabel(item.status)}
                    </p>
                  </div>
                </div>
                <dl className="mt-3 grid gap-1 font-mono text-xs text-fg sm:grid-cols-2">
                  <div>
                    <dt className="inline text-fg">correlation </dt>
                    <dd className="inline break-all">
                      {item.correlationId || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-fg">request </dt>
                    <dd className="inline break-all">
                      {item.requestId || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-fg">resource </dt>
                    <dd className="inline break-all">
                      {executionHref ? (
                        <Link
                          href={executionHref}
                          className="underline decoration-border underline-offset-2 hover:decoration-muted-foreground"
                        >
                          {item.resourceType} {item.resourceId}
                        </Link>
                      ) : (
                        <>
                          {item.resourceType || "id"} {item.resourceId || "—"}
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-fg">occurred </dt>
                    <dd className="inline">{item.occurredAt || "—"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-fg">id </dt>
                    <dd className="inline break-all">{item.id}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
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
