"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ConfigSpecForm } from "@/components/config/ConfigSpecForm";
import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import { getOpsConfigVersion } from "@/lib/ops-config-client";
import { descriptorForKind, emptySpecForKind } from "@/lib/ops-config-contract";
import { isPublishedVersionReadOnly } from "@/lib/ops-config";
import type { OpsConfigKind, OpsConfigVersion } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type ConfigPublishedDetailProps = {
  kind: OpsConfigKind;
  resourceId: string;
  versionId: string;
};

export function ConfigPublishedDetail({
  kind,
  resourceId,
  versionId,
}: ConfigPublishedDetailProps) {
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
  const [version, setVersion] = useState<OpsConfigVersion | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void getOpsConfigVersion(identity, kind, resourceId, versionId).then(
      (result) => {
        if (cancelled) {
          return;
        }
        setLastRequestId(result.requestId);
        if (!result.ok) {
          setProblem(result.problem);
          return;
        }
        setVersion(result.version);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, identity, kind, resourceId, versionId]);

  const readOnly = isPublishedVersionReadOnly(version);

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
        <p className="text-sm text-zinc-500">
          <Link
            href={`/config/${descriptor.collection}/${resourceId}`}
            className="underline decoration-zinc-300 underline-offset-2"
          >
            Back to draft
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{descriptor.title}</h2>
          {version ? (
            <VersionPinBadge
              name={`v${version.versionNumber}`}
              versionNumber={version.versionNumber}
              digest={version.digest}
              readOnly
            />
          ) : null}
        </div>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600">
          Published revisions are immutable. Workflows and executions pin this
          exact version id and digest. Edit the draft instead of this snapshot.
        </p>
        {version?.publishNote ? (
          <p className="mt-3 text-sm text-zinc-700">{version.publishNote}</p>
        ) : null}

        <div className="mt-5">
          <ConfigSpecForm
            key={version?.id ?? "empty"}
            kind={kind}
            spec={version?.spec ?? emptySpecForKind(kind)}
            readOnly={readOnly || !version}
            identity={identity}
            ready={ready}
            onChange={() => undefined}
          />
        </div>
      </section>
    </div>
  );
}
