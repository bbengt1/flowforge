"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CredentialTestDialog } from "@/components/credentials/CredentialTestDialog";
import { DeleteImpactDialog } from "@/components/credentials/DeleteImpactDialog";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { SecretField } from "@/components/credentials/SecretField";
import {
  clearSecretDraftAfterSubmit,
  credentialStatusLabel,
  credentialTypeLabel,
  formatRef,
  formatTagsInput,
  parseTagsInput,
  recordHasAction,
} from "@/lib/credential";
import {
  deleteCredential,
  disableCredential,
  enableCredential,
  getCredential,
  getCredentialCatalog,
  getCredentialDeletionImpact,
  getCredentialEvents,
  getCredentialUsage,
  rotateCredential,
  testCredential,
  updateCredential,
  recordCredentialUse,
} from "@/lib/credential-client";
import {
  FALLBACK_CREDENTIAL_CATALOG,
  catalogTypeInfo,
  emptySecretDraft,
} from "@/lib/credential-contract";
import type {
  CredentialCatalog,
  CredentialDeletionImpact,
  CredentialEvent,
  CredentialRecord,
  CredentialSecretDraft,
  CredentialTestResult,
  CredentialUsage,
} from "@/lib/credential-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

type CredentialDetailProps = {
  credentialId: string;
};

export function CredentialDetail({ credentialId }: CredentialDetailProps) {
  const router = useRouter();
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

  const [record, setRecord] = useState<CredentialRecord | null>(null);
  const [catalog, setCatalog] = useState<CredentialCatalog>(
    FALLBACK_CREDENTIAL_CATALOG,
  );
  const [displayName, setDisplayName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState<CredentialSecretDraft>(emptySecretDraft());
  const [usage, setUsage] = useState<CredentialUsage | null>(null);
  const [events, setEvents] = useState<CredentialEvent[]>([]);
  const [impact, setImpact] = useState<CredentialDeletionImpact | null>(null);
  const [typedName, setTypedName] = useState("");
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [useAck, setUseAck] = useState<string | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const typeInfo = record ? catalogTypeInfo(catalog, record.type) : undefined;
  const secretFields = typeInfo?.secretFields ?? [];
  const metadataFields = typeInfo?.metadataFields ?? [];

  function applyRecord(next: CredentialRecord, extraKeys: string[] = []) {
    setRecord(next);
    setDisplayName(next.displayName);
    setTagsInput(formatTagsInput(next.tags));
    setMetadata({ ...next.metadata });
    setExpiresAt(next.expiresAt ?? "");
    setStrippedKeys(extraKeys);
  }

  async function refresh() {
    setPending("load");
    setProblem(null);
    const [result, catalogResult] = await Promise.all([
      getCredential(identity, credentialId),
      getCredentialCatalog(identity),
    ]);
    setPending(null);
    if (catalogResult.ok) {
      setCatalog(catalogResult.catalog);
    }
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  useEffect(() => {
    if (!ready) {
      return;
    }
    void getCredential(identity, credentialId).then((result) => {
      if (result.ok) {
        applyRecord(result.credential, result.strippedKeys);
      } else {
        setProblem(result.problem);
      }
    });
    void getCredentialCatalog(identity).then((result) => {
      if (result.ok) {
        setCatalog(result.catalog);
      }
    });
  }, [ready, credentialId, identity]);

  async function saveMetadata() {
    if (!record || !recordHasAction(record, "manage")) {
      return;
    }
    setPending("save");
    setProblem(null);
    const result = await updateCredential(identity, credentialId, {
      displayName,
      tags: parseTagsInput(tagsInput),
      metadata,
      expiresAt: expiresAt.trim() || null,
    });
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  async function rotate() {
    if (!record || !recordHasAction(record, "rotate")) {
      return;
    }
    setPending("rotate");
    setProblem(null);
    const result = await rotateCredential(
      identity,
      credentialId,
      record.type,
      secret,
      catalog,
    );
    setSecret(clearSecretDraftAfterSubmit(secret));
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  async function toggleStatus() {
    if (!record) {
      return;
    }
    const action = record.status === "disabled" ? "enable" : "disable";
    if (!recordHasAction(record, action)) {
      return;
    }
    setPending(action);
    setProblem(null);
    const result =
      action === "enable"
        ? await enableCredential(identity, credentialId)
        : await disableCredential(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  async function runTest() {
    setPending("test");
    setProblem(null);
    const result = await testCredential(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setTestResult(result.test);
    setStrippedKeys(result.strippedKeys);
    if (result.credential) {
      applyRecord(result.credential, result.strippedKeys);
    }
  }

  async function recordUse() {
    setPending("use");
    setProblem(null);
    setUseAck(null);
    const result = await recordCredentialUse(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setUseAck("Use recorded (204 empty).");
    void refresh();
  }

  async function loadUsage() {
    setPending("usage");
    setProblem(null);
    const result = await getCredentialUsage(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setUsage(result.usage);
    setStrippedKeys(result.strippedKeys);
  }

  async function loadEvents() {
    setPending("events");
    setProblem(null);
    const result = await getCredentialEvents(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setEvents(result.items);
    setStrippedKeys(result.strippedKeys);
  }

  async function loadImpact() {
    setPending("impact");
    setProblem(null);
    const result = await getCredentialDeletionImpact(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setImpact(result.impact);
    setStrippedKeys(result.strippedKeys);
  }

  async function confirmDelete() {
    setPending("delete");
    setProblem(null);
    const result = await deleteCredential(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    router.replace("/credentials");
  }

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />
      <p>
        <Link
          href="/credentials"
          className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Back to vault
        </Link>
      </p>
      {problem ? <ProblemBanner problem={problem} /> : null}
      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped: {strippedKeys.join(", ")}.
        </p>
      ) : null}

      {!ready ? (
        <p className="text-sm text-zinc-600">
          Establish a cookie session and tenant + workbench before opening a
          credential.
        </p>
      ) : !record ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={pending === "load"}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
          >
            {pending === "load" ? "Loading…" : "Load credential"}
          </button>
        </div>
      ) : (
        <>
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{record.displayName}</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  {credentialTypeLabel(record.type, catalog)} ·{" "}
                  {credentialStatusLabel(record.status)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
              >
                Reload
              </button>
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              <Meta label="fingerprint" value={record.fingerprint || "—"} mono />
              <Meta label="last test" value={record.lastTestStatus} />
              <Meta label="last tested" value={record.lastTestedAt ?? "—"} mono />
              <Meta label="last test reason" value={record.lastTestReason ?? "—"} />
              <Meta label="rotated" value={record.rotatedAt ?? "—"} mono />
              <Meta label="expires" value={record.expiresAt ?? "—"} mono />
              <Meta label="use count" value={String(record.useCount)} />
              <Meta label="last used" value={record.lastUsedAt ?? "—"} mono />
              <Meta
                label="key reference"
                value={record.keyReference || "—"}
                mono
              />
            </dl>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold">Safe metadata</h3>
            <p className="mt-1 text-sm text-zinc-600">
              <code className="font-mono text-xs">PATCH /credentials/{"{id}"}</code>{" "}
              accepts displayName, tags, metadata, and expiresAt. Sending{" "}
              <code className="font-mono text-xs">secret</code> is 400.
            </p>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="font-medium">Display name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium">Tags</span>
                <input
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
              </label>
              {metadataFields.map((field) => (
                <label key={field.name} className="block text-sm">
                  <span className="font-medium">{field.name}</span>
                  <input
                    value={metadata[field.name] ?? ""}
                    onChange={(event) =>
                      setMetadata((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                  />
                </label>
              ))}
              <label className="block text-sm">
                <span className="font-medium">Expires at</span>
                <input
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  placeholder="2026-12-31T23:59:59Z"
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
              </label>
              <button
                type="button"
                onClick={() => void saveMetadata()}
                disabled={pending === "save" || !recordHasAction(record, "manage")}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                {pending === "save" ? "Saving…" : "Save metadata"}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold">Rotate secret</h3>
            <p className="mt-1 text-sm text-zinc-600">
              <code className="font-mono text-xs">POST .../rotate</code>{" "}
              {"{secret}"}. Fields clear after submit.
            </p>
            <div className="mt-4 space-y-3">
              {secretFields.map((field) => (
                <SecretField
                  key={field.name}
                  id={`rotate-${field.name}`}
                  label={field.name}
                  multiline={field.input === "textarea"}
                  required={field.required}
                  value={secret[field.name] ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, [field.name]: value }))
                  }
                />
              ))}
              <button
                type="button"
                onClick={() => void rotate()}
                disabled={pending === "rotate" || !recordHasAction(record, "rotate")}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                {pending === "rotate" ? "Rotating…" : "Rotate"}
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold">Actions</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void toggleStatus()}
                disabled={
                  pending === "disable" ||
                  pending === "enable" ||
                  (record.status === "disabled"
                    ? !recordHasAction(record, "enable")
                    : !recordHasAction(record, "disable"))
                }
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                {record.status === "disabled" ? "Enable" : "Disable"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTestOpen(true);
                  setTestResult(null);
                }}
                disabled={!recordHasAction(record, "test")}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                Test
              </button>
              <button
                type="button"
                onClick={() => void recordUse()}
                disabled={pending === "use" || !recordHasAction(record, "use")}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                {pending === "use" ? "Recording…" : "Record use"}
              </button>
              <button
                type="button"
                onClick={() => void loadUsage()}
                disabled={pending === "usage"}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                {pending === "usage" ? "Loading…" : "Load usage"}
              </button>
              <button
                type="button"
                onClick={() => void loadEvents()}
                disabled={pending === "events"}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                {pending === "events" ? "Loading…" : "Load events"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(true);
                  setImpact(null);
                  setTypedName("");
                }}
                disabled={!recordHasAction(record, "delete")}
                className="rounded-lg border border-red-800 bg-red-800 px-3 py-2 text-sm font-medium text-white hover:bg-red-900 disabled:opacity-60"
              >
                Delete…
              </button>
            </div>
            {useAck ? (
              <p role="status" className="mt-3 text-sm text-zinc-600">
                {useAck}
              </p>
            ) : null}
          </section>

          {usage ? (
            <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <h3 className="text-base font-semibold">Usage</h3>
              <p className="mt-1 font-mono text-xs text-zinc-500">
                count {usage.useCount}
                {usage.lastUsedAt ? ` · last ${usage.lastUsedAt}` : ""}
                {usage.lastUsedBy ? ` · ${usage.lastUsedBy}` : ""}
              </p>
              <RefList title="Drafts" refs={usage.drafts} />
              <RefList title="Versions" refs={usage.versions} />
              <RefList title="Executions" refs={usage.executions} />
            </section>
          ) : null}

          {events.length ? (
            <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <h3 className="text-base font-semibold">Events</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2"
                  >
                    <p className="font-medium">{event.eventType}</p>
                    <p className="font-mono text-xs text-zinc-500">
                      {event.occurredAt}
                      {event.actorId ? ` · ${event.actorId}` : ""}
                    </p>
                    {Object.keys(event.details).length ? (
                      <p className="mt-1 text-xs text-zinc-600">
                        {Object.entries(event.details)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(" · ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <CredentialTestDialog
        open={testOpen}
        pending={pending === "test"}
        result={testResult}
        onTest={() => void runTest()}
        onClose={() => setTestOpen(false)}
      />
      <DeleteImpactDialog
        open={deleteOpen}
        pending={pending === "impact" || pending === "delete"}
        impact={impact}
        typedName={typedName}
        onTypedName={setTypedName}
        onLoadImpact={() => void loadImpact()}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "font-medium"}>
        {value}
      </dd>
    </div>
  );
}

function RefList({
  title,
  refs,
}: {
  title: string;
  refs: CredentialUsage["drafts"];
}) {
  return (
    <div className="mt-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {refs.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-600">None.</p>
      ) : (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {refs.map((ref) => (
            <li key={`${ref.kind}-${ref.workflowId}-${ref.versionId ?? ref.executionId ?? ""}`}>
              {formatRef(ref)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
