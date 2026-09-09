"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { getOpsConfigCatalog } from "@/lib/ops-config-client";
import { OPS_CONFIG_KIND_CATALOG } from "@/lib/ops-config-contract";
import type { OpsConfigCatalogKind, OpsConfigGroup } from "@/lib/ops-config-types";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

const GROUPS: Array<{ id: OpsConfigGroup; title: string; blurb: string }> = [
  {
    id: "targets",
    title: "Targets",
    blurb:
      "Kubernetes clusters and SSH hosts. Cluster targets bind a workspace vault credential and optional E7.1 Kubernetes policy. Endpoint metadata only — kubeconfig stays in the vault.",
  },
  {
    id: "profiles",
    title: "Profiles",
    blurb: "Approved command templates and pinned script runtimes. Publish before a workflow can pin them.",
  },
  {
    id: "config",
    title: "Config",
    blurb:
      "Connections, recipient lists, templates, response schemas, and policies. Kubernetes policies use namespace/kind/verb allowlists.",
  },
];

type ConfigHubProps = {
  group?: string;
};

export function ConfigHub({ group }: ConfigHubProps) {
  const selected = useMemo<OpsConfigGroup>(() => {
    if (group === "targets" || group === "profiles" || group === "config") {
      return group;
    }
    return "targets";
  }, [group]);
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
  const [catalogKinds, setCatalogKinds] = useState<OpsConfigCatalogKind[]>([]);
  const [engineNote, setEngineNote] = useState<string | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void getOpsConfigCatalog(identity).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      setCatalogKinds(result.catalog.kinds);
      const notes = result.catalog.kubernetesEngine?.serviceAccount;
      const note =
        notes && typeof notes === "object" && !Array.isArray(notes)
          ? String((notes as { notes?: unknown }).notes ?? "").trim()
          : "";
      setEngineNote(note || null);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, ready]);

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />

      <nav aria-label="Config groups" className="flex flex-wrap gap-2">
        {GROUPS.map((item) => (
          <Link
            key={item.id}
            href={`/config?group=${item.id}`}
            className={`rounded-full px-3 py-1.5 text-sm ${
              selected === item.id
                ? "bg-teal-800 text-white"
                : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
            }`}
          >
            {item.title}
          </Link>
        ))}
      </nav>

      {GROUPS.map((item) => (
        <section
          key={item.id}
          id={item.id}
          hidden={selected !== item.id}
          className="space-y-4"
        >
          <div>
            <h2 className="text-lg font-semibold">{item.title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-zinc-600">{item.blurb}</p>
            {item.id === "targets" && engineNote ? (
              <p className="mt-2 max-w-3xl text-xs text-zinc-500">{engineNote}</p>
            ) : null}
          </div>
          <ul className="grid gap-4 md:grid-cols-2">
            {OPS_CONFIG_KIND_CATALOG.filter((kind) => kind.group === item.id).map(
              (kind) => {
                const remote = catalogKinds.find((row) => row.kind === kind.kind);
                const title = remote?.displayName ?? kind.title;
                const yamlRef = remote?.yamlFields?.[0] ?? kind.yamlRef;
                const collection = remote?.collection ?? kind.collection;
                return (
                  <li key={kind.kind}>
                    <Link
                      href={`/config/${collection}`}
                      className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm hover:border-teal-700"
                    >
                      <h3 className="font-semibold">{title}</h3>
                      <p className="mt-1 text-sm text-zinc-600">{kind.summary}</p>
                      <p className="mt-3 font-mono text-xs text-zinc-500">
                        YAML {yamlRef} · /{collection}
                        {remote?.usePermission ? ` · ${remote.usePermission}` : ""}
                      </p>
                    </Link>
                  </li>
                );
              },
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
