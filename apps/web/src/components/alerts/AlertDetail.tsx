"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertSeverityBadge } from "@/components/alerts/AlertSeverityBadge";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import {
  alertKindLabel,
  alertStatusLabel,
  canAckAlert,
  canResolveAlert,
  listedResourceIds,
} from "@/lib/alert";
import { ackAlert, getAlert, resolveAlert } from "@/lib/alert-client";
import type { OperationalAlert } from "@/lib/alert-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { callIdentityProxy } from "@/lib/identity-client";
import type { CurrentWorkspace } from "@/lib/identity-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type AlertDetailProps = {
  alertId: string;
};

export function AlertDetail({ alertId }: AlertDetailProps) {
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

  const [alert, setAlert] = useState<OperationalAlert | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [outcome, setOutcome] = useState("");

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  async function refresh() {
    setPending("load");
    setProblem(null);
    const [result, workspace] = await Promise.all([
      getAlert(identity, alertId),
      callIdentityProxy<CurrentWorkspace>("/workspace", identity),
    ]);
    setLastRequestId(result.requestId);
    setPending(null);
    if (workspace.ok) {
      setPermissions(workspace.data.permissions ?? []);
    }
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setAlert(result.alert);
    setStrippedKeys(result.strippedKeys);
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
  }, [ready, identity, alertId]);

  async function mutate(action: "ack" | "resolve") {
    setPending(action);
    setProblem(null);
    setOutcome("");
    const result =
      action === "ack"
        ? await ackAlert(identity, alertId)
        : await resolveAlert(identity, alertId);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setOutcome(result.message);
    if (result.alert) {
      setAlert(result.alert);
      setStrippedKeys(result.strippedKeys);
      return;
    }
    await refresh();
  }

  const showAck = alert
    ? canAckAlert({
        permissions,
        status: alert.status,
        permittedActions: alert.permittedActions,
      })
    : false;
  const showResolve = alert
    ? canResolveAlert({
        permissions,
        status: alert.status,
        permittedActions: alert.permittedActions,
      })
    : false;
  const resourcePairs = alert ? listedResourceIds(alert.resourceIds) : [];

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />

      <p className="text-sm">
        <Link
          href="/alerts"
          className="text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Back to alerts
        </Link>
      </p>

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and workspace lookup to load this alert.
        </p>
      ) : null}

      {problem ? <ProblemBanner problem={problem} /> : null}

      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      {outcome ? (
        <p role="status" className="text-sm text-teal-900">
          {outcome}
        </p>
      ) : null}

      {alert ? (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <AlertSeverityBadge severity={alert.severity} />
              <p className="text-sm font-medium">
                {alertStatusLabel(alert.status)}
              </p>
            </div>
            <h2 className="text-xl font-semibold">
              {alertKindLabel(alert.kind)}
            </h2>
            <p className="text-sm text-zinc-700">
              {alert.message || "Safe message unavailable."}
            </p>
            <p className="font-mono text-xs break-all text-zinc-500">
              {alert.id}
              {lastRequestId ? ` · ${lastRequestId}` : ""}
            </p>
          </header>

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Correlation id</dt>
              <dd className="break-all font-mono text-xs">
                {alert.correlationId || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Occurred</dt>
              <dd className="font-mono text-xs">
                {alert.occurredAt || alert.createdAt || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Resource type</dt>
              <dd>{alert.resourceType || "—"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Resource id</dt>
              <dd className="break-all font-mono text-xs">
                {alert.resourceId || "—"}
              </dd>
            </div>
            {alert.acknowledgedAt ? (
              <div>
                <dt className="text-zinc-500">Acknowledged</dt>
                <dd className="font-mono text-xs">{alert.acknowledgedAt}</dd>
              </div>
            ) : null}
            {alert.resolvedAt ? (
              <div>
                <dt className="text-zinc-500">Resolved</dt>
                <dd className="font-mono text-xs">{alert.resolvedAt}</dd>
              </div>
            ) : null}
          </dl>

          {resourcePairs.length ? (
            <div>
              <h3 className="text-sm font-semibold">Resource ids</h3>
              <ul className="mt-2 grid gap-1 font-mono text-xs text-zinc-600 sm:grid-cols-2">
                {resourcePairs.map(([key, value]) => (
                  <li key={key} className="break-all">
                    {key} {value}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {showAck || showResolve ? (
            <div className="flex flex-wrap gap-2">
              {showAck ? (
                <button
                  type="button"
                  onClick={() => void mutate("ack")}
                  disabled={pending != null}
                  className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
                >
                  {pending === "ack" ? "Acknowledging…" : "Acknowledge"}
                </button>
              ) : null}
              {showResolve ? (
                <button
                  type="button"
                  onClick={() => void mutate("resolve")}
                  disabled={pending != null}
                  className="rounded-lg border border-zinc-400 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
                >
                  {pending === "resolve" ? "Resolving…" : "Resolve"}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">
              This alert is read-only for the current role, or ack/resolve is
              not published yet. Mutations use CSRF when the API provides them.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
