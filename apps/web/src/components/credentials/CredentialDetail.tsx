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
  credentialHealthLabel,
  credentialPolicyLabel,
  credentialTypeLabel,
  formatTagsInput,
  parseTagsInput,
  recordHasAction,
} from "@/lib/credential";
import {
  deleteCredential,
  disableCredential,
  enableCredential,
  getCredential,
  getCredentialAudit,
  getCredentialDeletionImpact,
  getCredentialUsage,
  rotateCredential,
  testCredential,
  updateCredential,
} from "@/lib/credential-client";
import { emptySecretDraft, secretFieldsForType } from "@/lib/credential-contract";
import {
  CREDENTIAL_ALLOWED_USES,
  type CredentialAllowedUse,
  type CredentialAuditEvent,
  type CredentialDeletionImpact,
  type CredentialRecord,
  type CredentialSecretDraft,
  type CredentialTestResult,
  type CredentialUsage,
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
  const [displayName, setDisplayName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [rotateAfter, setRotateAfter] = useState("");
  const [allowedUse, setAllowedUse] = useState<CredentialAllowedUse[]>([]);
  const [secret, setSecret] = useState<CredentialSecretDraft>(emptySecretDraft());
  const [usage, setUsage] = useState<CredentialUsage | null>(null);
  const [audit, setAudit] = useState<CredentialAuditEvent[]>([]);
  const [impact, setImpact] = useState<CredentialDeletionImpact | null>(null);
  const [typedName, setTypedName] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);

  useEffect(() => {
    if (ready) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialId, ready]);

  async function load() {
    setPending("load");
    setProblem(null);
    const result = await getCredential(identity, credentialId);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  function applyRecord(next: CredentialRecord, stripped: string[]) {
    setRecord(next);
    setDisplayName(next.displayName);
    setTagsInput(formatTagsInput(next.tags));
    setRotateAfter(next.rotateAfter?.slice(0, 10) ?? "");
    setAllowedUse(next.allowedUse);
    setStrippedKeys(stripped);
  }

  async function saveMetadata() {
    setPending("save");
    setProblem(null);
    const result = await updateCredential(identity, credentialId, {
      displayName,
      tags: parseTagsInput(tagsInput),
      allowedUse,
      rotateAfter: rotateAfter || null,
    });
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  async function rotate() {
    if (!record) {
      return;
    }
    setPending("rotate");
    setProblem(null);
    const result = await rotateCredential(
      identity,
      credentialId,
      record.type,
      secret,
      false,
    );
    setSecret(clearSecretDraftAfterSubmit(secret));
    setLastRequestId(result.requestId);
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
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setTestResult(result.test);
    setStrippedKeys(result.strippedKeys);
    if (record) {
      setRecord({
        ...record,
        lastTestStatus: result.test.status,
        lastTestedAt: result.test.testedAt,
        health: result.test.status === "passed" ? "healthy" : "failed",
      });
    }
  }

  async function toggleDisabled() {
    if (!record) {
      return;
    }
    setPending("disable");
    setProblem(null);
    const result =
      record.status === "disabled"
        ? await enableCredential(identity, credentialId)
        : await disableCredential(identity, credentialId);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    applyRecord(result.credential, result.strippedKeys);
  }

  async function loadUsage() {
    setPending("usage");
    setProblem(null);
    const result = await getCredentialUsage(identity, credentialId);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setUsage(result.usage);
    setStrippedKeys(result.strippedKeys);
  }

  async function loadAudit() {
    setPending("audit");
    setProblem(null);
    const result = await getCredentialAudit(identity, credentialId);
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setAudit(result.items);
    setStrippedKeys(result.strippedKeys);
  }

  async function loadImpact() {
    setPending("impact");
    setProblem(null);
    const result = await getCredentialDeletionImpact(identity, credentialId);
    setLastRequestId(result.requestId);
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
    setLastRequestId(result.requestId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    router.replace("/credentials");
  }

  const secretKeys = record ? secretFieldsForType(record.type) : [];

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />
      <p>
        <Link
          href="/credentials"
          className="text-sm text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
        >
          Back to vault
        </Link>
      </p>
      {problem ? <ProblemBanner problem={problem} /> : null}
      {lastRequestId && !problem ? (
        <p className="font-mono text-xs text-zinc-500">
          last request_id {lastRequestId}
        </p>
      ) : null}
      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped: {strippedKeys.join(", ")}.
        </p>
      ) : null}

      {!record ? (
        <p className="text-sm text-zinc-600">
          {ready
            ? pending === "load"
              ? "Loading credential metadata…"
              : "Credential metadata is not loaded."
            : "Establish a cookie session and tenant + workbench first."}
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{record.displayName}</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  {credentialTypeLabel(record.type)} · {record.status}
                </p>
              </div>
              <dl className="grid gap-1 text-sm">
                <div>
                  <dt className="inline text-zinc-500">health </dt>
                  <dd className="inline font-medium">
                    {credentialHealthLabel(record.health)}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-zinc-500">policy </dt>
                  <dd className="inline font-medium">
                    {credentialPolicyLabel(record.policyState)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="font-medium">Display name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
              </label>
              <label className="text-sm">
                <span className="font-medium">Tags</span>
                <input
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
              </label>
              <label className="text-sm">
                <span className="font-medium">Rotate after</span>
                <input
                  type="date"
                  value={rotateAfter}
                  onChange={(event) => setRotateAfter(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                />
              </label>
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium">Allowed use</legend>
              <div className="mt-2 flex flex-wrap gap-3">
                {CREDENTIAL_ALLOWED_USES.map((use) => (
                  <label key={use} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allowedUse.includes(use)}
                      onChange={(event) => {
                        setAllowedUse((current) =>
                          event.target.checked
                            ? [...current, use]
                            : current.filter((item) => item !== use),
                        );
                      }}
                    />
                    <span className="font-mono text-xs">{use}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void saveMetadata()}
                disabled={pending !== null || !recordHasAction(record, "edit")}
                className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
              >
                {pending === "save" ? "Saving…" : "Save metadata"}
              </button>
              <button
                type="button"
                onClick={() => setTestOpen(true)}
                disabled={!recordHasAction(record, "test")}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                Test
              </button>
              <button
                type="button"
                onClick={() => void toggleDisabled()}
                disabled={
                  pending !== null ||
                  (!recordHasAction(record, "disable") &&
                    !recordHasAction(record, "enable"))
                }
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                {record.status === "disabled" ? "Enable" : "Disable"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTypedName("");
                  setDeleteOpen(true);
                }}
                disabled={!recordHasAction(record, "delete")}
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-60"
              >
                Delete…
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Rotate / replace</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Submit a new secret payload. After success the inputs are
              cleared and only metadata remains.
            </p>
            <div className="mt-4 space-y-4">
              {secretKeys.includes("kubeconfig") ? (
                <SecretField
                  id="rotate-kubeconfig"
                  label="Kubeconfig"
                  multiline
                  value={secret.kubeconfig ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, kubeconfig: value }))
                  }
                />
              ) : null}
              {secretKeys.includes("token") ? (
                <SecretField
                  id="rotate-token"
                  label="Token"
                  value={secret.token ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, token: value }))
                  }
                />
              ) : null}
              {secretKeys.includes("privateKey") ? (
                <SecretField
                  id="rotate-key"
                  label="SSH private key"
                  multiline
                  value={secret.privateKey ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, privateKey: value }))
                  }
                />
              ) : null}
              {secretKeys.includes("passphrase") ? (
                <SecretField
                  id="rotate-passphrase"
                  label="Key passphrase (optional)"
                  value={secret.passphrase ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, passphrase: value }))
                  }
                />
              ) : null}
              {secretKeys.includes("apiKey") ? (
                <SecretField
                  id="rotate-api-key"
                  label="API key"
                  value={secret.apiKey ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, apiKey: value }))
                  }
                />
              ) : null}
              {secretKeys.includes("secret") ? (
                <SecretField
                  id="rotate-secret"
                  label="Webhook secret"
                  value={secret.secret ?? ""}
                  onChange={(value) =>
                    setSecret((current) => ({ ...current, secret: value }))
                  }
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void rotate()}
              disabled={pending !== null || !recordHasAction(record, "rotate")}
              className="mt-4 rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending === "rotate" ? "Rotating…" : "Replace secret"}
            </button>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Permissions and usage</h2>
              <button
                type="button"
                onClick={() => void loadUsage()}
                disabled={pending !== null}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                {pending === "usage" ? "Loading…" : "Load usage"}
              </button>
            </div>
            {!usage ? (
              <p className="mt-2 text-sm text-zinc-600">
                Usage is loaded on demand. Rows are workflow names only.
              </p>
            ) : (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="text-sm font-medium">Grants</h3>
                  <ul className="mt-2 space-y-1 text-sm">
                    {usage.permissions.length === 0 ? (
                      <li className="text-zinc-600">No explicit grants returned.</li>
                    ) : (
                      usage.permissions.map((item) => (
                        <li key={`${item.principalDisplayName}-${item.permission}`}>
                          {item.principalDisplayName} · {item.permission}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-medium">Workflow references</h3>
                  <ul className="mt-2 space-y-1 text-sm">
                    {usage.usages.length === 0 ? (
                      <li className="text-zinc-600">No drafts or versions listed.</li>
                    ) : (
                      usage.usages.map((item) => (
                        <li key={`${item.workflowId}-${item.kind}-${item.nodeId ?? ""}`}>
                          {item.workflowName} · {item.kind}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Audit history</h2>
              <button
                type="button"
                onClick={() => void loadAudit()}
                disabled={pending !== null}
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-60"
              >
                {pending === "audit" ? "Loading…" : "Load audit"}
              </button>
            </div>
            {audit.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-600">
                Redacted events only. Secret values are never in the trail.
              </p>
            ) : (
              <ol className="mt-3 space-y-2 text-sm">
                {audit.map((event) => (
                  <li key={event.id} className="rounded-lg border border-zinc-100 p-3">
                    <p className="font-medium">{event.eventType}</p>
                    <p className="font-mono text-xs text-zinc-500">
                      {event.occurredAt}
                      {event.actorDisplayName ? ` · ${event.actorDisplayName}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
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
