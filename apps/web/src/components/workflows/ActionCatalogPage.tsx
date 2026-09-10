"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActionLibrary } from "@/components/workflows/ActionLibrary";
import { ProblemBanner } from "@/components/ProblemBanner";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { loadDevIdentity, emptyStoredIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import { getKubernetesCatalog } from "@/lib/kubernetes-client";
import type { KubernetesEngineCatalog } from "@/lib/kubernetes-types";
import { getSshCatalog } from "@/lib/ssh-client";
import type { SshNodeCatalog } from "@/lib/ssh-node-contract";
import { getHttpNotificationCatalog } from "@/lib/core-http-notification-client";
import type { HttpNotificationCatalog } from "@/lib/core-http-notification-contract";
import { getScriptCatalog } from "@/lib/script-client";
import type { ScriptNodeCatalog } from "@/lib/script-contract";
import { adaptActionLibrary } from "@/lib/workflow-action-library";
import { fetchWorkflowCatalog } from "@/lib/workflow-client";
import type { WorkflowCatalog } from "@/lib/workflow-types";
import type { ProblemDetails } from "@/lib/problem";

export function ActionCatalogPage() {
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
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [engineCatalog, setEngineCatalog] = useState<KubernetesEngineCatalog | null>(
    null,
  );
  const [sshCatalog, setSshCatalog] = useState<SshNodeCatalog | null>(null);
  const [scriptCatalog, setScriptCatalog] = useState<ScriptNodeCatalog | null>(
    null,
  );
  const [httpCatalog, setHttpCatalog] = useState<HttpNotificationCatalog | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const canCall =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  async function loadCatalog() {
    setPending(true);
    setProblem(null);
    const [result, engine, ssh, script, http] = await Promise.all([
      fetchWorkflowCatalog(identity),
      getKubernetesCatalog(identity).catch(() => null),
      getSshCatalog(identity).catch(() => null),
      getScriptCatalog(identity).catch(() => null),
      getHttpNotificationCatalog(identity).catch(() => null),
    ]);
    setPending(false);
    setEngineCatalog(engine && engine.ok ? engine.catalog : null);
    setSshCatalog(ssh && ssh.ok ? ssh.nodeCatalog : null);
    setScriptCatalog(script && script.ok ? script.catalog : null);
    setHttpCatalog(http && http.ok ? http.catalog : null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setCatalog(result.catalog);
  }

  useEffect(() => {
    if (!canCall) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadCatalog();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCall]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          Catalog
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Actions</h1>
        <p className="text-base leading-7 text-zinc-600">
          Catalog reference for enabled implementations. Triggers stay
          workflow-level and are not placeable. Add actions from a workflow
          canvas at{" "}
          <code className="font-mono text-sm">/workflows/{"{id}"}</code>.
        </p>
      </header>
      <IsolationIdentityPanel />
      {problem ? <ProblemBanner problem={problem} /> : null}
      <ActionLibrary
        catalog={catalog}
        entries={adaptActionLibrary(
          catalog,
          engineCatalog,
          sshCatalog,
          scriptCatalog,
          httpCatalog,
        )}
        query={query}
        pending={pending}
        onQuery={setQuery}
        onRefresh={() => void loadCatalog()}
      />
      <p>
        <Link
          href="/workflows"
          className="text-sm font-medium text-teal-800 underline"
        >
          Back to workflow home
        </Link>
      </p>
    </main>
  );
}
