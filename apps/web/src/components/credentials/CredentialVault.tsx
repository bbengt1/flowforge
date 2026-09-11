"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { CredentialCard } from "@/components/credentials/CredentialCard";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { filterCredentialList } from "@/lib/credential";
import { getCredentialCatalog, listCredentials } from "@/lib/credential-client";
import { FALLBACK_CREDENTIAL_CATALOG } from "@/lib/credential-contract";
import {
  CREDENTIAL_STATUSES,
  type CredentialCatalog,
  type CredentialListQuery,
  type CredentialRecord,
} from "@/lib/credential-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

export function CredentialVault() {
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

  const [items, setItems] = useState<CredentialRecord[]>([]);
  const [catalog, setCatalog] = useState<CredentialCatalog>(
    FALLBACK_CREDENTIAL_CATALOG,
  );
  const [query, setQuery] = useState<CredentialListQuery>({
    q: "",
    type: "",
    tag: "",
    status: "",
  });
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  const visible = useMemo(
    () => filterCredentialList(items, query),
    [items, query],
  );

  async function refresh() {
    setPending(true);
    setProblem(null);
    const [list, catalogResult] = await Promise.all([
      listCredentials(identity),
      getCredentialCatalog(identity),
    ]);
    setLastRequestId(list.requestId);
    setPending(false);
    if (!list.ok) {
      setProblem(list.problem);
      return;
    }
    setItems(list.items);
    setStrippedKeys(list.strippedKeys);
    if (catalogResult.ok) {
      setCatalog(catalogResult.catalog);
    }
  }

  return (
    <div className="space-y-6">
      {problem ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}
      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped from the API response:{" "}
          {strippedKeys.join(", ")}. Treat this as a backend contract bug.
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Workspace vault</h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600">
              <code className="font-mono text-xs">GET /credentials</code>{" "}
              returns metadata only. Filter by display name or tags in the
              browser. Plaintext is never queried, stored, or rendered.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/credentials/new"
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900"
            >
              Add credential
            </Link>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={pending || !ready}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
            >
              {pending ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        <form
          className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label className="text-sm">
            <span className="font-medium">Name or tag</span>
            <input
              value={query.q ?? ""}
              onChange={(event) =>
                setQuery((current) => ({ ...current, q: event.target.value }))
              }
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Type</span>
            <select
              value={query.type ?? ""}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  type: event.target.value as CredentialListQuery["type"],
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Any</option>
              {catalog.types.map((item) => (
                <option key={item.type} value={item.type}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium">Exact tag</span>
            <input
              value={query.tag ?? ""}
              onChange={(event) =>
                setQuery((current) => ({ ...current, tag: event.target.value }))
              }
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="text-sm">
            <span className="font-medium">Status</span>
            <select
              value={query.status ?? ""}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  status: event.target.value as CredentialListQuery["status"],
                }))
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Any</option>
              {CREDENTIAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </form>
      </section>

      {!ready ? (
        <SessionSetupHint purpose="before listing credentials." />
      ) : visible.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center">
          <h2 className="text-lg font-semibold">No credentials yet</h2>
          <p className="mt-2 text-sm text-zinc-600">
            Add a workspace credential to use from workflows. Secrets stay
            on the control plane after submit.
          </p>
          <p className="mt-4">
            <Link
              href="/credentials/new"
              className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
            >
              Open the add-credential wizard
            </Link>
          </p>
        </section>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {visible.map((credential) => (
            <li key={credential.id}>
              <CredentialCard credential={credential} catalog={catalog} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
