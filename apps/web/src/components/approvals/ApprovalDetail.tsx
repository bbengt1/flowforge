"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ApprovalBindingSnapshot } from "@/components/approvals/ApprovalBindingSnapshot";
import { ApprovalValidityBanner } from "@/components/approvals/ApprovalValidityBanner";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { ApprovalDecideControls } from "@/components/approvals/ApprovalDecideControls";
import {
  approvalStatusLabel,
  failClosedProblemTitle,
} from "@/lib/approval";
import {
  APPROVAL_BINDING_HELP,
  APPROVAL_WAIT_DURABLE_HELP,
} from "@/lib/approval-contract";
import { getApproval, getApprovalEvents } from "@/lib/approval-client";
import type { ApprovalEvent } from "@/lib/approval-types";
import type { ApprovalRequest } from "@/lib/approval-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { callIdentityProxy } from "@/lib/identity-client";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type ApprovalDetailProps = {
  approvalId: string;
};

export function ApprovalDetail({ approvalId }: ApprovalDetailProps) {
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

  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [events, setEvents] = useState<ApprovalEvent[]>([]);
  const [actorUserId, setActorUserId] = useState("");
  const [permissions, setPermissions] = useState<string[] | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  async function refresh() {
    setPending("load");
    setProblem(null);
    const [result, workspace] = await Promise.all([
      getApproval(identity, approvalId),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
    ]);
    setLastRequestId(result.requestId);
    setPending(null);
    if (workspace.ok) {
      setActorUserId(workspace.data.principal?.id ?? "");
      setPermissions(workspace.data.permissions ?? []);
    }
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setApproval(result.approval);
    setStrippedKeys(result.strippedKeys);
    const audit = await getApprovalEvents(identity, approvalId);
    if (audit.ok) {
      setEvents(audit.items);
    }
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
  }, [ready, identity, approvalId]);

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />

      <p className="text-sm">
        <Link
          href="/approvals"
          className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Back to approvals
        </Link>
      </p>

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and workspace lookup to load this approval.
        </p>
      ) : null}

      {problem ? (
        <ProblemBanner
          problem={{
            ...problem,
            title: failClosedProblemTitle(problem),
          }}
        />
      ) : null}

      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      {approval ? (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <header className="space-y-1">
            <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
              {approvalStatusLabel(approval.status)}
            </p>
            <h2 className="text-xl font-semibold">
              {approval.workflowName || approval.binding.operation}
            </h2>
            <p className="font-mono text-xs break-all text-zinc-500">
              {approval.id}
              {lastRequestId ? ` · ${lastRequestId}` : ""}
            </p>
          </header>

          <ApprovalValidityBanner approval={approval} />
          <ApprovalBindingSnapshot binding={approval.binding} />

          {approval.validity.currentBinding ? (
            <ApprovalBindingSnapshot
              binding={approval.validity.currentBinding}
              caption="Current server binding after recheck. This no longer matches the request snapshot."
            />
          ) : null}

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Requested by</dt>
              <dd>{approval.requestedBy || "—"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Requested at</dt>
              <dd className="font-mono text-xs">{approval.requestedAt || "—"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Decided by</dt>
              <dd>{approval.decidedBy || "—"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Decided at</dt>
              <dd className="font-mono text-xs">{approval.decidedAt || "—"}</dd>
            </div>
          </dl>

          <ApprovalDecideControls
            identity={identity}
            approval={approval}
            actorUserId={actorUserId}
            permissions={permissions}
            onUpdated={setApproval}
          />
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending !== null}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-60"
          >
            Recheck on server
          </button>
          <p className="text-sm text-zinc-600">
            {APPROVAL_BINDING_HELP} {APPROVAL_WAIT_DURABLE_HELP} The UI never
            stores an approval token or treats a previous local approve as
            sufficient.
          </p>
          {events.length ? (
            <ol className="space-y-1 text-sm text-zinc-600">
              {events.map((event) => (
                <li key={event.id} className="font-mono text-xs">
                  {event.eventType}
                  {event.occurredAt ? ` · ${event.occurredAt}` : ""}
                  {event.actorId ? ` · ${event.actorId}` : ""}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
