"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DeleteImpactDialog } from "@/components/credentials/DeleteImpactDialog";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
import { ProblemBanner } from "@/components/ProblemBanner";
import { SecretField } from "@/components/credentials/SecretField";
import {
  clearSecretDraftAfterSubmit,
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
} from "@/lib/credential-client";
import {
  FALLBACK_CREDENTIAL_CATALOG,
  catalogTypeInfo,
  emptySecretDraft,
  forgetSecretDraft,
} from "@/lib/credential-contract";
import {
  CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP,
  CREDENTIAL_DETAIL_HELP,
  CREDENTIAL_DETAIL_ROTATE_HELP,
  CREDENTIAL_DETAIL_STRIP_STOP_HELP,
  credentialDetailAfterMutate,
  credentialDetailDisableEnableLabel,
  credentialDetailHeaderMeta,
  credentialDetailImpactDisplay,
  credentialDetailIdentityText,
  credentialDetailListHref,
  credentialDetailMustStopAfterStrip,
  credentialDetailTestDisplay,
  credentialDetailUsageDisplay,
} from "@/lib/credential-detail";
import { isCredentialForbidden } from "@/lib/credential-vault";
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
import {
  DOHERTY_IDLE,
  dohertyBegin,
  dohertyFinish,
  type DohertyChrome,
} from "@/lib/doherty-pending-chrome";
import { DohertyStatus } from "@/components/chrome/DohertyStatus";
import {
  FF_VAULT_CONTROL_CLASS,
  FF_VAULT_DANGER_CLASS,
  FF_VAULT_GHOST_CLASS,
  FF_VAULT_LINK_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_PRIMARY_CLASS,
  FF_VAULT_ROOT_CLASS,
  FF_VAULT_TITLE_CLASS,
  FF_VAULT_UUID_CLASS,
  FF_VAULT_VALUE,
} from "@/lib/vault-executions-visual";

type CredentialDetailProps = {
  credentialId: string;
};

export function CredentialDetail({ credentialId }: CredentialDetailProps) {
  const router = useRouter();
  const pathname = usePathname();
  const embed = pathname.startsWith("/embed/v1");
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
  const [mutatedIdentity, setMutatedIdentity] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [doherty, setDoherty] = useState<DohertyChrome>(DOHERTY_IDLE);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const typeInfo = record ? catalogTypeInfo(catalog, record.type) : undefined;
  const secretFields = typeInfo?.secretFields ?? [];
  const metadataFields = typeInfo?.metadataFields ?? [];
  const secretRef = useRef(secret);
  const forbidden = isCredentialForbidden(problem);
  const stopAfterStrip = credentialDetailMustStopAfterStrip(strippedKeys);

  function applyRecord(next: CredentialRecord, extraKeys: string[] = []) {
    setRecord(next);
    setDisplayName(next.displayName);
    setTagsInput(formatTagsInput(next.tags));
    setMetadata({ ...next.metadata });
    setExpiresAt(next.expiresAt ?? "");
    setStrippedKeys(extraKeys);
  }

  function applyMutatedRecord(next: CredentialRecord, extraKeys: string[] = []) {
    applyRecord(next, extraKeys);
    if (extraKeys.length === 0) {
      setMutatedIdentity(
        credentialDetailIdentityText(credentialDetailAfterMutate(next)),
      );
    }
  }

  function mergeStripped(extraKeys: string[]) {
    setStrippedKeys((current) =>
      extraKeys.length === 0 ? current : [...new Set([...current, ...extraKeys])],
    );
  }

  async function refresh() {
    setPending("load");
    setProblem(null);
    const [result, catalogResult, usageResult, impactResult] = await Promise.all([
      getCredential(identity, credentialId),
      getCredentialCatalog(identity),
      getCredentialUsage(identity, credentialId),
      getCredentialDeletionImpact(identity, credentialId),
    ]);
    setPending(null);
    if (catalogResult.ok) {
      setCatalog(catalogResult.catalog);
    }
    const extraKeys = [
      ...(result.ok ? result.strippedKeys : []),
      ...(usageResult.ok ? usageResult.strippedKeys : []),
      ...(impactResult.ok ? impactResult.strippedKeys : []),
    ];
    setStrippedKeys(extraKeys);
    if (!result.ok) {
      setProblem(result.problem);
      if (isCredentialForbidden(result.problem)) {
        setRecord(null);
        setUsage(null);
        setImpact(null);
      }
      return;
    }
    applyRecord(result.credential, extraKeys);
    if (usageResult.ok) {
      setUsage(usageResult.usage);
    }
    if (impactResult.ok) {
      setImpact(impactResult.impact);
    }
  }

  useEffect(() => {
    if (!ready) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over identity
  }, [ready, credentialId, identity]);

  useEffect(() => {
    secretRef.current = secret;
  }, [secret]);

  useEffect(() => {
    return () => {
      forgetSecretDraft(secretRef.current);
    };
  }, []);

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
    applyMutatedRecord(result.credential, result.strippedKeys);
  }

  async function rotate() {
    if (!record || !recordHasAction(record, "rotate")) {
      return;
    }
    setDoherty(dohertyBegin("vault-rotate"));
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
    setDoherty(dohertyFinish("vault-rotate", result.ok));
    if (!result.ok) {
      setProblem(result.problem);
      mergeStripped(result.strippedKeys);
      return;
    }
    applyMutatedRecord(result.credential, result.strippedKeys);
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
    applyMutatedRecord(result.credential, result.strippedKeys);
  }

  async function runTest() {
    if (!record || !recordHasAction(record, "test")) {
      return;
    }
    setDoherty(dohertyBegin("vault-test"));
    setPending("test");
    setProblem(null);
    const result = await testCredential(identity, credentialId);
    setSecret(clearSecretDraftAfterSubmit(secret));
    setPending(null);
    setDoherty(dohertyFinish("vault-test", result.ok));
    if (!result.ok) {
      setProblem(result.problem);
      mergeStripped(result.strippedKeys);
      return;
    }
    setTestResult(result.test);
    if (result.credential) {
      applyMutatedRecord(result.credential, result.strippedKeys);
    } else {
      mergeStripped(result.strippedKeys);
    }
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
    mergeStripped(result.strippedKeys);
  }

  async function loadImpact() {
    setPending("impact");
    setProblem(null);
    const result = await getCredentialDeletionImpact(identity, credentialId);
    setPending(null);
    if (!result.ok) {
      setProblem(result.problem);
      mergeStripped(result.strippedKeys);
      return;
    }
    setImpact(result.impact);
    mergeStripped(result.strippedKeys);
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
    router.replace(credentialDetailListHref(embed));
  }

  const header = record ? credentialDetailHeaderMeta(record, catalog) : null;
  const testDisplay = credentialDetailTestDisplay(testResult, record);
  const usageDisplay = usage ? credentialDetailUsageDisplay(usage) : null;
  const impactDisplay = impact ? credentialDetailImpactDisplay(impact) : null;
  const disableEnableLabel = record
    ? credentialDetailDisableEnableLabel(record.status)
    : "Disable";

  return (
    <div data-ff-vault={FF_VAULT_VALUE} className={`${FF_VAULT_ROOT_CLASS} space-y-6`}>
      <p>
        <Link
          href={credentialDetailListHref(embed)}
          className={`text-sm font-medium ${FF_VAULT_LINK_CLASS}`}
        >
          Back to vault
        </Link>
      </p>
      {problem ? <ProblemBanner problem={problem} /> : null}
      {stopAfterStrip ? (
        <p role="alert" className={`text-sm ${FF_VAULT_DANGER_CLASS}`}>
          {CREDENTIAL_DETAIL_STRIP_STOP_HELP} Stripped keys:{" "}
          {strippedKeys.join(", ")}.
        </p>
      ) : null}

      {!ready ? (
        <SessionSetupHint purpose="before opening a credential." />
      ) : forbidden ? (
        <p className={`text-sm ${FF_VAULT_DANGER_CLASS}`}>
          This role cannot view this credential (
          <code className="font-mono text-xs">credential.view</code> missing).
        </p>
      ) : !record ? (
        <p className={`text-sm ${FF_VAULT_MUTED_CLASS}`} aria-live="polite">
          {pending === "load" ? "Loading credential…" : "Credential is not available."}
        </p>
      ) : (
        <>
          <section className={FF_VAULT_PANEL_CLASS}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className={`text-lg ${FF_VAULT_TITLE_CLASS}`}>{header?.identity.displayName}</h2>
                <p className={`mt-1 ${FF_VAULT_UUID_CLASS}`}>
                  {header?.identity.id}
                </p>
                <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>
                  {header?.typeLabel} · {header?.statusLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={pending === "load"}
                className={FF_VAULT_GHOST_CLASS}
              >
                {pending === "load" ? "Loading…" : "Reload"}
              </button>
            </div>
            <p className={`mt-3 max-w-3xl text-sm ${FF_VAULT_MUTED_CLASS}`}>
              {CREDENTIAL_DETAIL_HELP}
            </p>
            {mutatedIdentity && !stopAfterStrip ? (
              <p role="status" className="mt-3 text-sm">
                After mutate: <span className="font-medium">{mutatedIdentity}</span>
                {" — "}
                display-name + UUID only.
              </p>
            ) : null}
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              <Meta label="last test" value={header?.lastTestLabel ?? "—"} />
              <Meta label="rotated" value={header?.rotatedLabel ?? "—"} mono />
              <Meta label="expires" value={header?.expiresLabel ?? "—"} mono />
              <Meta label="use count" value={header?.useCountLabel ?? "0"} />
            </dl>
          </section>

          {stopAfterStrip ? null : (
            <>
              <section className={FF_VAULT_PANEL_CLASS}>
                <h3 className="text-base font-semibold">Operate</h3>
                <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>
                  {CREDENTIAL_DETAIL_DISABLE_ENABLE_HELP}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void runTest()}
                    disabled={pending === "test" || !recordHasAction(record, "test")}
                    aria-busy={pending === "test"}
                    className={FF_VAULT_PRIMARY_CLASS}
                  >
                    {pending === "test" ? "Testing…" : "Test"}
                  </button>
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
                    className={FF_VAULT_GHOST_CLASS}
                  >
                    {pending === "disable" || pending === "enable"
                      ? `${disableEnableLabel.slice(0, -1)}ing…`
                      : disableEnableLabel}
                  </button>
                </div>
                {doherty.gesture === "vault-test" ? (
                  <DohertyStatus chrome={doherty} className="mt-3" />
                ) : null}
                <dl className="mt-4 grid gap-1 text-sm">
                  <div>
                    <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>test status </dt>
                    <dd className="inline font-medium">{testDisplay.status}</dd>
                  </div>
                  {testDisplay.checkedAt !== "—" ? (
                    <div>
                      <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>checked </dt>
                      <dd className="inline font-mono text-xs">{testDisplay.checkedAt}</dd>
                    </div>
                  ) : null}
                  {testDisplay.reason ? (
                    <div>
                      <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>reason </dt>
                      <dd className="inline">{testDisplay.reason}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>

              <section className={FF_VAULT_PANEL_CLASS}>
                <h3 className="text-base font-semibold">Rotate secret</h3>
                <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>
                  {CREDENTIAL_DETAIL_ROTATE_HELP}
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
                    aria-busy={pending === "rotate"}
                    className={FF_VAULT_PRIMARY_CLASS}
                  >
                    {pending === "rotate" ? "Rotating…" : "Rotate"}
                  </button>
                  {doherty.gesture === "vault-rotate" ? (
                    <DohertyStatus chrome={doherty} />
                  ) : null}
                </div>
              </section>

              <section className={FF_VAULT_PANEL_CLASS}>
                <h3 className="text-base font-semibold">Usage</h3>
                {usageDisplay ? (
                  <>
                    <p className={`mt-1 font-mono text-xs ${FF_VAULT_MUTED_CLASS}`}>
                      count {usageDisplay.useCount}
                      {usageDisplay.lastUsedLabel !== "—"
                        ? ` · last ${usageDisplay.lastUsedLabel}`
                        : ""}
                      {usageDisplay.lastUsedBy !== "—"
                        ? ` · ${usageDisplay.lastUsedBy}`
                        : ""}
                    </p>
                    <RefList title="Drafts" refs={usageDisplay.drafts} empty="No drafts." />
                    <RefList
                      title="Versions"
                      refs={usageDisplay.versions}
                      empty="No published versions."
                    />
                    <RefList
                      title="Executions"
                      refs={usageDisplay.executions}
                      empty="No executions."
                    />
                  </>
                ) : (
                  <p className={`mt-2 text-sm ${FF_VAULT_MUTED_CLASS}`}>
                    {pending === "load" ? "Loading usage…" : "Usage is not available."}
                  </p>
                )}
              </section>

              <section className={FF_VAULT_PANEL_CLASS}>
                <h3 className="text-base font-semibold">Deletion impact</h3>
                {impactDisplay ? (
                  <div className="mt-2 space-y-3 text-sm">
                    <p className={FF_VAULT_MUTED_CLASS}>
                      {impactDisplay.canDelete
                        ? `${impactDisplay.displayName} can be deleted. Type the display name to confirm.`
                        : impactDisplay.blockReason ||
                          "Deletion is blocked by the control plane."}
                    </p>
                    <RefList
                      title="Affected drafts"
                      refs={impactDisplay.drafts}
                      empty="No drafts reference this credential."
                    />
                    <RefList
                      title="Affected published versions"
                      refs={impactDisplay.versions}
                      empty="No published versions reference this credential."
                    />
                    <RefList
                      title="Active executions"
                      refs={impactDisplay.activeExecutions}
                      empty="No active executions."
                    />
                  </div>
                ) : (
                  <p className={`mt-2 text-sm ${FF_VAULT_MUTED_CLASS}`}>
                    {pending === "load"
                      ? "Loading deletion impact…"
                      : "Deletion impact is not available."}
                  </p>
                )}
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteOpen(true);
                      setTypedName("");
                    }}
                    disabled={!recordHasAction(record, "delete")}
                    className={`${FF_VAULT_DANGER_CLASS} rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-60`}
                  >
                    Delete…
                  </button>
                </div>
              </section>

              <section className={FF_VAULT_PANEL_CLASS}>
                <h3 className="text-base font-semibold">Safe metadata</h3>
                <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>
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
                      className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="font-medium">Tags</span>
                    <input
                      value={tagsInput}
                      onChange={(event) => setTagsInput(event.target.value)}
                      autoComplete="off"
                      className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
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
                        className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
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
                      className={`mt-1 font-mono ${FF_VAULT_CONTROL_CLASS}`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void saveMetadata()}
                    disabled={pending === "save" || !recordHasAction(record, "manage")}
                    className={FF_VAULT_PRIMARY_CLASS}
                  >
                    {pending === "save" ? "Saving…" : "Save metadata"}
                  </button>
                </div>
              </section>

              <section className={FF_VAULT_PANEL_CLASS}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="text-base font-semibold">Events</h3>
                  <button
                    type="button"
                    onClick={() => void loadEvents()}
                    disabled={pending === "events"}
                    className={FF_VAULT_GHOST_CLASS}
                  >
                    {pending === "events" ? "Loading…" : "Load events"}
                  </button>
                </div>
                {events.length ? (
                  <ul className="mt-3 space-y-2 text-sm">
                    {events.map((event) => (
                      <li
                        key={event.id}
                        className={`${FF_VAULT_PANEL_CLASS} !p-3`}
                      >
                        <p className="font-medium">{event.eventType}</p>
                        <p className={`font-mono text-xs ${FF_VAULT_MUTED_CLASS}`}>
                          {event.occurredAt}
                          {event.actorId ? ` · ${event.actorId}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={`mt-2 text-sm ${FF_VAULT_MUTED_CLASS}`}>
                    Events stay on demand. They are metadata only — not{" "}
                    <code className="font-mono text-xs">/audit</code>.
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}

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
      <dt className={FF_VAULT_MUTED_CLASS}>{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "font-medium"}>
        {value}
      </dd>
    </div>
  );
}

function RefList({
  title,
  refs,
  empty,
}: {
  title: string;
  refs: readonly string[];
  empty: string;
}) {
  return (
    <div className="mt-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {refs.length === 0 ? (
        <p className={`mt-1 text-sm ${FF_VAULT_MUTED_CLASS}`}>{empty}</p>
      ) : (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {refs.map((ref) => (
            <li key={`${title}-${ref}`}>{ref}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
