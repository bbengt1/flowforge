"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ConfigSpecForm } from "@/components/config/ConfigSpecForm";
import { ConfigVersionHistory } from "@/components/config/ConfigVersionHistory";
import { VersionPinBadge } from "@/components/config/VersionPinBadge";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import {
  createOpsConfig,
  getOpsConfig,
  getOpsConfigDraft,
  listOpsConfigVersions,
  publishOpsConfig,
  saveOpsConfigDraft,
} from "@/lib/ops-config-client";
import { descriptorForKind, emptySpecForKind } from "@/lib/ops-config-contract";
import { publishInvalidatesApprovals } from "@/lib/approval";
import {
  clusterTargetPublishGap,
  hostSuppliedIdentityKeys,
  hostSuppliedIdentityProblem,
  isKubernetesPolicySpec,
  kubernetesPolicyPublishGap,
  parseKubernetesPolicy,
} from "@/lib/kubernetes";
import { canPublishDraft, clientCompareSpecs, isDraftEditable } from "@/lib/ops-config";
import type {
  OpsConfigDraft,
  OpsConfigKind,
  OpsConfigRecord,
  OpsConfigSpec,
  OpsConfigVersion,
} from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type ConfigDraftEditorProps = {
  kind: OpsConfigKind;
  resourceId?: string;
};

type ClientCompare = ReturnType<typeof clientCompareSpecs>;

export function ConfigDraftEditor({ kind, resourceId }: ConfigDraftEditorProps) {
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

  const [name, setName] = useState("");
  const [spec, setSpec] = useState<OpsConfigSpec>(emptySpecForKind(kind));
  const [draft, setDraft] = useState<OpsConfigDraft | null>(null);
  const [resource, setResource] = useState<OpsConfigRecord | null>(null);
  const [versions, setVersions] = useState<OpsConfigVersion[]>([]);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [compareLeft, setCompareLeft] = useState("draft");
  const [compareRight, setCompareRight] = useState("");
  const [compare, setCompare] = useState<ClientCompare | null>(null);
  const [approvalsInvalidated, setApprovalsInvalidated] = useState(false);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const id = resource?.id ?? draft?.resourceId ?? resourceId;
  const hostKeys = hostSuppliedIdentityKeys(spec);
  const hostProblem =
    hostKeys.length > 0 ? hostSuppliedIdentityProblem(hostKeys) : null;
  const publishGap =
    kind === "cluster_target"
      ? clusterTargetPublishGap(spec)
      : kind === "policy" && isKubernetesPolicySpec(spec)
        ? kubernetesPolicyPublishGap(parseKubernetesPolicy(spec))
        : null;
  const readOnly = !isDraftEditable(resource?.status);

  const applyDraft = useCallback((next: OpsConfigDraft, nextName?: string) => {
    setDraft(next);
    if (nextName !== undefined) {
      setName(nextName);
    }
    setSpec(next.spec);
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!ready || !resourceId) {
      return;
    }
    let cancelled = false;
    void Promise.all([
      getOpsConfig(identity, kind, resourceId),
      getOpsConfigDraft(identity, kind, resourceId),
      listOpsConfigVersions(identity, kind, resourceId),
    ]).then(([record, draftResult, history]) => {
      if (cancelled) {
        return;
      }
      setLastRequestId(draftResult.requestId);
      if (!record.ok) {
        setProblem(record.problem);
        return;
      }
      setResource(record.resource);
      setName(record.resource.name);
      if (draftResult.ok) {
        applyDraft(draftResult.draft, record.resource.name);
      } else if (draftResult.statusCode !== 404) {
        setProblem(draftResult.problem);
      } else {
        setSpec(emptySpecForKind(kind));
        setDirty(false);
      }
      if (history.ok) {
        setVersions(history.items);
        setCompareRight(history.items[0]?.id ?? "");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applyDraft, identity, kind, ready, resourceId]);

  async function createDraft() {
    if (hostProblem) {
      setProblem(hostProblem);
      return;
    }
    setPending("create");
    setProblem(null);
    const result = await createOpsConfig(identity, kind, name, spec);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyDraft(result.draft, result.resource?.name ?? name);
    if (result.resource) {
      setResource(result.resource);
    }
  }

  async function saveDraft() {
    if (!id || !draft) {
      return;
    }
    if (hostProblem) {
      setProblem(hostProblem);
      return;
    }
    setPending("save");
    setProblem(null);
    const result = await saveOpsConfigDraft(
      identity,
      kind,
      id,
      draft.revision,
      spec,
      name,
    );
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyDraft(result.draft, result.resource?.name ?? name);
    if (result.resource) {
      setResource(result.resource);
    }
  }

  async function publish() {
    if (!id || !draft) {
      return;
    }
    setPending("publish");
    setProblem(null);
    const result = await publishOpsConfig(identity, kind, id, draft.revision, note);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setResource(result.resource);
    setVersions((current) => [result.version, ...current]);
    setCompareRight(result.version.id);
    setNote("");
    setApprovalsInvalidated(publishInvalidatesApprovals(kind));
  }

  async function restore(version: OpsConfigVersion) {
    if (!id || !draft) {
      return;
    }
    setPending("restore");
    setProblem(null);
    const result = await saveOpsConfigDraft(
      identity,
      kind,
      id,
      draft.revision,
      version.spec,
      name,
    );
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyDraft(result.draft, result.resource?.name ?? name);
    if (result.resource) {
      setResource(result.resource);
    }
  }

  function runCompare() {
    const leftSpec =
      compareLeft === "draft"
        ? spec
        : versions.find((item) => item.id === compareLeft)?.spec;
    const rightSpec = versions.find((item) => item.id === compareRight)?.spec;
    if (!leftSpec || !rightSpec) {
      return;
    }
    setCompare(clientCompareSpecs(leftSpec, rightSpec));
  }

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />
      {problem ? <ProblemBanner problem={problem} /> : null}
      {hostProblem && !problem ? <ProblemBanner problem={hostProblem} /> : null}
      {publishGap ? (
        <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {publishGap}
        </p>
      ) : null}
      {approvalsInvalidated ? (
        <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Publishing this {kind === "policy" ? "policy" : "target"} invalidates
          prior pending and approved rows bound to the previous revision.
          Re-evaluate policy and request a new approval before dispatch.
        </p>
      ) : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-zinc-500">
              <Link
                href={`/config/${descriptor.collection}`}
                className="underline decoration-zinc-300 underline-offset-2"
              >
                {descriptor.title}
              </Link>
            </p>
            <h2 className="mt-1 text-lg font-semibold">
              {resourceId ? "Edit draft" : "Create draft"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600">
              Save updates the mutable draft with body{" "}
              <code className="font-mono text-xs">revision</code> (no If-Match).
              Publish copies the last saved draft into an immutable revision.
              Unsaved buffer is not published.
            </p>
          </div>
          {resource?.latestVersionNumber ? (
            <VersionPinBadge
              name={resource.name}
              versionNumber={resource.latestVersionNumber}
              digest={resource.latestVersionDigest}
              readOnly
            />
          ) : (
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700">
              unpublished draft
            </span>
          )}
        </div>

        <label className="mt-5 block text-sm">
          <span className="font-medium">Display name</span>
          <input
            value={name}
            disabled={readOnly}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:bg-zinc-50"
          />
        </label>

        <div className="mt-4">
          <ConfigSpecForm
            key={`${draft?.revision ?? "new"}-${id ?? "create"}`}
            kind={kind}
            spec={spec}
            readOnly={readOnly}
            identity={identity}
            ready={ready}
            onChange={(next) => {
              setSpec(next);
              setDirty(true);
            }}
          />
        </div>

        <div className="mt-5 flex flex-wrap items-end gap-3">
          {!id ? (
            <button
              type="button"
              onClick={() => void createDraft()}
              disabled={!ready || pending !== null || !name.trim() || Boolean(hostProblem)}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "create" ? "Creating…" : "Create draft"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={!ready || pending !== null || !draft || readOnly || Boolean(hostProblem)}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "save" ? "Saving…" : `Save draft${draft ? ` (rev ${draft.revision})` : ""}`}
            </button>
          )}
          <label className="text-sm">
            <span className="font-medium">Publish note</span>
            <input
              value={note}
              disabled={!id || readOnly}
              onChange={(event) => setNote(event.target.value)}
              className="mt-1 w-56 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => void publish()}
            disabled={
              !ready ||
              pending !== null ||
              readOnly ||
              Boolean(hostProblem) ||
              Boolean(publishGap) ||
              !canPublishDraft(draft, name, dirty)
            }
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending === "publish" ? "Publishing…" : "Publish immutable revision"}
          </button>
        </div>
        {dirty && draft ? (
          <p className="mt-3 text-sm text-amber-900">
            Unsaved edits are not published. Save the draft first.
          </p>
        ) : null}
      </section>

      {id ? (
        <ConfigVersionHistory
          kind={kind}
          resourceId={id}
          versions={versions}
          pending={pending !== null}
          compareLeft={compareLeft}
          compareRight={compareRight}
          compare={compare}
          onCompareLeft={setCompareLeft}
          onCompareRight={setCompareRight}
          onCompare={runCompare}
          onRestore={(version) => void restore(version)}
        />
      ) : null}
    </div>
  );
}
