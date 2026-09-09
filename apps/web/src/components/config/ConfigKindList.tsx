"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { listOpsConfig } from "@/lib/ops-config-client";
import { descriptorForKind } from "@/lib/ops-config-contract";
import type { KindDescriptor, OpsConfigKind, OpsConfigSummary } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type ConfigKindListProps = {
  kind: OpsConfigKind;
};

export function ConfigKindList({ kind }: ConfigKindListProps) {
  const descriptor = descriptorForKind(kind);
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
  const [items, setItems] = useState<OpsConfigSummary[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  async function refresh() {
    setPending(true);
    setProblem(null);
    const result = await listOpsConfig(identity, kind);
    setLastRequestId(result.requestId);
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      setItems([]);
      return;
    }
    setItems(result.items);
  }

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />
      {problem ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{descriptor.title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600">
              {descriptor.summary} Drafts are editable; published versions are
              immutable pins for workflows.
              {kind === "cluster_target"
                ? " E7.1: bind a workspace kubernetes credential and optional policy. Kubeconfig never appears here."
                : kind === "policy"
                  ? " E7.1: kubernetes policies use namespace, kind, and verb allowlists plus approval-required actions."
                  : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/config/${descriptor.collection}/new`}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900"
            >
              New draft
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
      </section>

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and tenant + workbench before listing
          workspace config.
        </p>
      ) : items.length === 0 && !problem ? (
        <EmptyKindState descriptor={descriptor} />
      ) : items.length === 0 && problem ? (
        <p className="text-sm text-zinc-600">
          List and select fail closed when the API returns 403 or an empty
          published set. Pins come from POST …/select, not GET …/authorized.
        </p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/config/${descriptor.collection}/${item.id}`}
                className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm hover:border-teal-700"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold">{item.name}</h3>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
                    {item.status}
                  </span>
                </div>
                <p className="mt-3">
                  {item.latestVersionNumber ? (
                    <VersionPinBadge
                      name={item.name}
                      versionNumber={item.latestVersionNumber}
                      digest={item.latestVersionDigest}
                      readOnly
                    />
                  ) : (
                    <span className="text-sm text-zinc-600">Draft only — not pinned yet</span>
                  )}
                </p>
                <p className="mt-2 font-mono text-xs text-zinc-500">
                  draft rev {item.draftRevision ?? "—"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyKindState({ descriptor }: { descriptor: KindDescriptor }) {
  return (
    <section className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center">
      <h2 className="text-lg font-semibold">No {descriptor.title.toLowerCase()} yet</h2>
      <p className="mt-2 text-sm text-zinc-600">
        Create a draft, then publish an immutable revision. Workflows pin the
        published version, never a live draft.
      </p>
      <p className="mt-4">
        <Link
          href={`/config/${descriptor.collection}/new`}
          className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Create the first draft
        </Link>
      </p>
    </section>
  );
}
