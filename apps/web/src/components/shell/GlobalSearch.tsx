"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import { listAlerts } from "@/lib/alert-client";
import { canSeeAlertsNav } from "@/lib/alert";
import { listCredentials } from "@/lib/credential-client";
import { canSeeExecutionsNav } from "@/lib/execution";
import { listExecutions } from "@/lib/execution-client";
import { fetchWorkflowCatalog, listWorkflows } from "@/lib/workflow-client";
import type { CredentialRecord } from "@/lib/credential-types";
import type { ExecutionRecord } from "@/lib/execution-types";
import type { OperationalAlert } from "@/lib/alert-types";
import type { WorkflowCatalog, WorkflowRecord } from "@/lib/workflow-types";
import {
  buildSearchIndex,
  querySearchIndex,
  type SearchHit,
} from "@/lib/workspace-search";
import {
  canSeeCredentialsNav,
  canSeeWorkflowsNav,
} from "@/lib/workspace-nav";

type GlobalSearchProps = {
  swaggerUrl: string;
};

export function GlobalSearch({ swaggerUrl }: GlobalSearchProps) {
  const router = useRouter();
  const { identity, ready, permissions } = useWorkspace();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [alerts, setAlerts] = useState<OperationalAlert[]>([]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (canSeeWorkflowsNav(permissions)) {
        const [list, catalogResult] = await Promise.all([
          listWorkflows(identity),
          fetchWorkflowCatalog(identity),
        ]);
        if (cancelled) {
          return;
        }
        if (list.ok) {
          setWorkflows(list.items);
        }
        if (catalogResult.ok) {
          setCatalog(catalogResult.catalog);
        }
      }
      if (canSeeCredentialsNav(permissions)) {
        const result = await listCredentials(identity);
        if (!cancelled && result.ok) {
          setCredentials(result.items);
        }
      }
      if (canSeeExecutionsNav(permissions ?? [])) {
        const result = await listExecutions(identity, { limit: 50 });
        if (!cancelled && result.ok) {
          setExecutions(result.items);
        }
      }
      if (canSeeAlertsNav(permissions ?? [])) {
        const result = await listAlerts(identity, { limit: 20 });
        if (!cancelled && result.ok) {
          setAlerts(result.items);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [ready, identity, permissions]);

  const hits = useMemo<SearchHit[]>(() => {
    const index = buildSearchIndex(
      { workflows, catalog, credentials, executions, alerts, swaggerUrl },
      permissions,
    );
    return querySearchIndex(index, query);
  }, [workflows, catalog, credentials, executions, alerts, swaggerUrl, permissions, query]);

  function openHit(hit: SearchHit) {
    setOpen(false);
    setQuery("");
    if (hit.href.startsWith("http")) {
      window.open(hit.href, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(hit.href);
  }

  return (
    <div className="relative min-w-0 flex-1">
      <label className="block">
        <span className="sr-only">Search workspace</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150);
          }}
          placeholder="Search workflows, actions, credentials, executions, docs"
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          autoComplete="off"
        />
      </label>
      {open && query.trim() ? (
        <ul
          role="listbox"
          aria-label="Search results"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-zinc-500">No safe matches</li>
          ) : (
            hits.map((hit) => (
              <li key={`${hit.kind}:${hit.id}`}>
                <button
                  type="button"
                  className="flex w-full flex-col px-3 py-2 text-left hover:bg-zinc-50"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => openHit(hit)}
                >
                  <span className="text-sm font-medium text-zinc-900">{hit.title}</span>
                  <span className="text-xs text-zinc-500">
                    {hit.kind} · {hit.subtitle}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
