"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  approvalStatusLabel,
  canSeeApprovalsNav,
  filterApprovalList,
  pendingApprovals,
} from "@/lib/approval";
import { listApprovals } from "@/lib/approval-client";
import { APPROVAL_STATUSES, type ApprovalRequest } from "@/lib/approval-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { callIdentityProxy } from "@/lib/identity-client";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function ApprovalList() {
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

  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [query, setQuery] = useState({ q: "", status: "pending" });
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<string[] | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  const visible = useMemo(
    () => filterApprovalList(items, query),
    [items, query],
  );

  async function refresh() {
    setPending(true);
    setProblem(null);
    const [list, workspace] = await Promise.all([
      listApprovals(identity, {
        status: query.status.trim() || undefined,
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
      return;
    }
    setItems(list.items);
  }

  useEffect(() => {
    if (!ready) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
    // Reload when session, workspace, or documented status filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [ready, identity, query.status]);

  const denied = ready && permissions != null && !canSeeApprovalsNav(permissions);

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and workspace lookup to list approvals.
        </p>
      ) : null}

      {denied ? (
        <p className="text-sm text-zinc-600">
          This role cannot view approvals (<code>approval.view</code> missing).
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="text-zinc-600">Filter</span>
          <input
            type="search"
            value={query.q}
            onChange={(event) =>
              setQuery((current) => ({ ...current, q: event.target.value }))
            }
            className="mt-1 w-64 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            placeholder="Operation, target, digest"
          />
        </label>
        <label className="block text-sm">
          <span className="text-zinc-600">Status</span>
          <select
            value={query.status}
            onChange={(event) =>
              setQuery((current) => ({ ...current, status: event.target.value }))
            }
            className="mt-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {APPROVAL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {approvalStatusLabel(status)}
              </option>
            ))}
          </select>
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

      <p className="text-sm text-zinc-600">
        {pendingApprovals(items).length} pending in the last list · status
        uses documented <code className="font-mono text-xs">?status=</code>
        {lastRequestId ? (
          <span className="font-mono text-xs"> · {lastRequestId}</span>
        ) : null}
      </p>

      {visible.length === 0 ? (
        <p className="text-sm text-zinc-600">
          No approvals match. Refresh after a policy evaluation requires one.
        </p>
      ) : (
        <ul className="grid gap-3">
          {visible.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">
                    <Link
                      href={`/approvals/${item.id}`}
                      className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                    >
                      {item.workflowName || item.binding.operation}
                    </Link>
                  </h2>
                  <p className="mt-1 font-mono text-xs text-zinc-600">
                    {item.binding.operation} · {item.binding.targetName || "no target"}
                  </p>
                </div>
                <p className="text-sm font-medium">
                  {approvalStatusLabel(item.status)}
                </p>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-zinc-500">
                expires {item.binding.expiresAt || "—"} · {item.id}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
