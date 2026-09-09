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
  compareOpsConfig,
  createOpsConfig,
  getOpsConfig,
  getOpsConfigDraft,
  listOpsConfigVersions,
  publishOpsConfig,
  restoreOpsConfigVersion,
  saveOpsConfigDraft,
} from "@/lib/ops-config-client";
import { descriptorForKind, emptySpecForKind } from "@/lib/ops-config-contract";
import { canPublishDraft, isDraftEditable } from "@/lib/ops-config";
import type {
  CompareConfigResult,
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
  const [compare, setCompare] = useState<CompareConfigResult | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const id = resource?.id ?? draft?.resourceId ?? resourceId;
  const readOnly = !isDraftEditable(resource?.status);

  const applyDraft = useCallback((next: OpsConfigDraft) => {
    setDraft(next);
    setName(next.name);
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
      if (draftResult.ok) {
        applyDraft(draftResult.draft);
      } else if (draftResult.statusCode !== 404) {
        setProblem(draftResult.problem);
      } else {
        setName(record.resource.name);
        setSpec(record.resource.spec);
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
    setPending("create");
    setProblem(null);
    const result = await createOpsConfig(identity, kind, name, spec);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyDraft(result.draft);
    if (result.resource) {
      setResource(result.resource);
    }
  }

  async function saveDraft() {
    if (!id || !draft) {
      return;
    }
    setPending("save");
    setProblem(null);
    const result = await saveOpsConfigDraft(
      identity,
      kind,
      id,
      draft.revision,
      name,
      spec,
    );
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyDraft(result.draft);
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
  }

  async function restore(version: OpsConfigVersion) {
    if (!id) {
      return;
    }
    setPending("restore");
    setProblem(null);
    const result = await restoreOpsConfigVersion(
      identity,
      kind,
      id,
      version.id,
      draft?.revision,
    );
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyDraft(result.draft);
    if (result.resource) {
      setResource(result.resource);
    }
  }

  async function runCompare() {
    if (!id) {
      return;
    }
    setPending("compare");
    setProblem(null);
    const left =
      compareLeft === "draft"
        ? ({ kind: "draft" } as const)
        : { kind: "version" as const, versionId: compareLeft };
    const result = await compareOpsConfig(identity, kind, id, left, {
      kind: "version",
      versionId: compareRight,
    });
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setCompare(result.compare);
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
              Save updates the mutable draft with revision / If-Match. Publish
              copies the last saved draft into an immutable revision. Unsaved
              buffer is not published.
            </p>
          </div>
          {resource?.latestVersionNumber ? (
            <VersionPinBadge
              name={resource.name}
              versionNumber={resource.latestVersionNumber}
              digest={resource.latestDigest}
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
              disabled={!ready || pending !== null || !name.trim()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "create" ? "Creating…" : "Create draft"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={!ready || pending !== null || !draft || readOnly}
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
              !canPublishDraft(draft, dirty)
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
          onCompare={() => void runCompare()}
          onRestore={(version) => void restore(version)}
        />
      ) : null}
    </div>
  );
}
