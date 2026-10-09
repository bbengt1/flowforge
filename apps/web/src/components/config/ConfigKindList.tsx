"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { RequestReference } from "@/components/RequestReference";
import { CollectionLoadMore } from "@/components/CollectionLoadMore";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import {
  COLLECTION_PAGE_DEFAULT_LIMIT,
  appendCollectionItems,
} from "@/lib/collection-page";
import { listOpsConfig } from "@/lib/ops-config-client";
import { CONFIG_LIST_EXTRA_HELP, CONFIG_LIST_PROBLEM_HELP } from "@/lib/config-plain-copy";
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
  const [pageNext, setPageNext] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState(false);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  async function refresh() {
    setPending(true);
    setProblem(null);
    const result = await listOpsConfig(identity, kind, {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    });
    setLastRequestId(result.requestId);
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      setItems([]);
      setPageNext("");
      return;
    }
    setItems(result.items);
    setPageNext(result.next);
  }

  async function loadMore() {
    if (!pageNext) {
      return;
    }
    setPending(true);
    setProblem(null);
    const result = await listOpsConfig(identity, kind, {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      cursor: pageNext,
    });
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setItems((current) => appendCollectionItems(current, result.items));
    setPageNext(result.next);
  }

  return (
    <div className="space-y-6">
      {problem ? <ProblemBanner problem={problem} /> : null}
      {!problem ? <RequestReference id={lastRequestId} /> : null}

      <section className="rounded-2xl border border-border bg-bg p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{descriptor.title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-fg">
              {descriptor.summary} Drafts can change; workflows use published
              versions, which never change.
              {CONFIG_LIST_EXTRA_HELP[kind] ? ` ${CONFIG_LIST_EXTRA_HELP[kind]}` : ""}
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
              className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg disabled:opacity-60"
            >
              {pending ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
      </section>

      {!ready ? (
        <SessionSetupHint purpose="before listing workspace config." />
      ) : items.length === 0 && !problem ? (
        <EmptyKindState descriptor={descriptor} />
      ) : items.length === 0 && problem ? (
        <p className="text-sm text-fg">{CONFIG_LIST_PROBLEM_HELP}</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/config/${descriptor.collection}/${item.id}`}
                className="block rounded-2xl border border-border bg-bg p-5 shadow-sm hover:border-teal-700"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold">{item.name}</h3>
                  <span className="rounded-full bg-bg px-2 py-0.5 text-xs text-fg">
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
                    <span className="text-sm text-fg">Draft only — not pinned yet</span>
                  )}
                </p>
                <p className="mt-2 font-mono text-xs text-fg">
                  Draft revision {item.draftRevision ?? "—"}
                </p>
              </Link>
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

function EmptyKindState({ descriptor }: { descriptor: KindDescriptor }) {
  return (
    <section className="rounded-2xl border border-dashed border-border bg-bg/60 p-8 text-center">
      <h2 className="text-lg font-semibold">No {descriptor.title.toLowerCase()} yet</h2>
      <p className="mt-2 text-sm text-fg">
        Create a draft, then publish it to make a fixed version. Workflows use
        the published version, never a draft.
      </p>
      <p className="mt-4">
        <Link
          href={`/config/${descriptor.collection}/new`}
          className="text-sm font-medium text-fg underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Create the first draft
        </Link>
      </p>
    </section>
  );
}
