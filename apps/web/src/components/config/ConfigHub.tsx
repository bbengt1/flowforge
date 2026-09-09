"use client";

import Link from "next/link";
import { useMemo } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { OPS_CONFIG_KIND_CATALOG } from "@/lib/ops-config-contract";
import type { OpsConfigGroup } from "@/lib/ops-config-types";

const GROUPS: Array<{ id: OpsConfigGroup; title: string; blurb: string }> = [
  {
    id: "targets",
    title: "Targets",
    blurb: "Kubernetes clusters and SSH hosts. Endpoint metadata only — credentials stay in the vault.",
  },
  {
    id: "profiles",
    title: "Profiles",
    blurb: "Approved command templates and pinned script runtimes. Publish before a workflow can pin them.",
  },
  {
    id: "config",
    title: "Config",
    blurb: "Connections, recipient lists, templates, response schemas, and policies.",
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
          </div>
          <ul className="grid gap-4 md:grid-cols-2">
            {OPS_CONFIG_KIND_CATALOG.filter((kind) => kind.group === item.id).map(
              (kind) => (
                <li key={kind.kind}>
                  <Link
                    href={`/config/${kind.collection}`}
                    className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm hover:border-teal-700"
                  >
                    <h3 className="font-semibold">{kind.title}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{kind.summary}</p>
                    <p className="mt-3 font-mono text-xs text-zinc-500">
                      YAML {kind.yamlRef} · /{kind.collection}
                    </p>
                  </Link>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
