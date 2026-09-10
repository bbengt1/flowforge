"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { SecretField } from "@/components/credentials/SecretField";
import {
  clearSecretDraftAfterSubmit,
  credentialTypeLabel,
  formatTagsInput,
  parseTagsInput,
} from "@/lib/credential";
import { createCredential, getCredentialCatalog } from "@/lib/credential-client";
import {
  FALLBACK_CREDENTIAL_CATALOG,
  catalogTypeInfo,
  emptySecretDraft,
  forgetSecretDraft,
} from "@/lib/credential-contract";
import {
  WIZARD_STEPS,
  type CredentialCatalog,
  type CredentialCatalogField,
  type CredentialRecord,
  type CredentialSecretDraft,
  type CredentialType,
  type WizardStep,
} from "@/lib/credential-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";
import {
  inspectorEditorReturnHref,
  type InspectorCredentialReturnTo,
} from "@/lib/editor-credential";

const STEP_LABEL: Record<WizardStep, string> = {
  identity: "Name and tags",
  type: "Type",
  secret: "Secret fields",
  metadata: "Metadata",
  review: "Review",
};

export type CredentialWizardProps = {
  variant?: "page" | "modal";
  allowedTypes?: readonly CredentialType[];
  returnContext?: InspectorCredentialReturnTo | null;
  onCreated?: (credential: CredentialRecord) => void;
  onCancel?: () => void;
};

export function CredentialWizard({
  variant = "page",
  allowedTypes,
  returnContext = null,
  onCreated,
  onCancel,
}: CredentialWizardProps = {}) {
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

  const [catalog, setCatalog] = useState<CredentialCatalog>(
    FALLBACK_CREDENTIAL_CATALOG,
  );
  const [step, setStep] = useState<WizardStep>("identity");
  const [displayName, setDisplayName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [type, setType] = useState<CredentialType>(
    allowedTypes?.[0] ?? "kubernetes",
  );
  const [secret, setSecret] = useState<CredentialSecretDraft>(emptySecretDraft());
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [expiresAt, setExpiresAt] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const visibleTypes = useMemo(() => {
    if (!allowedTypes?.length) {
      return catalog.types;
    }
    const allowed = new Set(allowedTypes);
    return catalog.types.filter((item) => allowed.has(item.type));
  }, [allowedTypes, catalog.types]);
  const typeIsVisible = visibleTypes.some((item) => item.type === type);
  const activeType = typeIsVisible
    ? type
    : (visibleTypes[0]?.type ?? type);
  const activeSecret = typeIsVisible ? secret : emptySecretDraft();
  const typeInfo = useMemo(
    () => catalogTypeInfo(catalog, activeType),
    [catalog, activeType],
  );
  const secretFields = typeInfo?.secretFields ?? [];
  const metadataFields = typeInfo?.metadataFields ?? [];
  const secretRef = useRef(secret);

  useEffect(() => {
    if (!ready) {
      return;
    }
    void getCredentialCatalog(identity).then((result) => {
      if (result.ok) {
        setCatalog(result.catalog);
        setStrippedKeys(result.strippedKeys);
      }
    });
  }, [ready, identity]);

  useEffect(() => {
    secretRef.current = secret;
  }, [secret]);

  useEffect(() => {
    return () => {
      forgetSecretDraft(secretRef.current);
    };
  }, []);

  function setSecretField(key: string, value: string) {
    setSecret((current) => ({ ...current, [key]: value }));
  }

  function go(next: WizardStep) {
    setStep(next);
  }

  async function submit() {
    setPending(true);
    setProblem(null);
    const result = await createCredential(
      identity,
      {
        displayName,
        tags: parseTagsInput(tagsInput),
        type: activeType,
        secret: activeSecret,
        metadata,
        expiresAt: expiresAt.trim() || undefined,
      },
      catalog,
    );
    setSecret(clearSecretDraftAfterSubmit(secret));
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setStrippedKeys(result.strippedKeys);
    if (onCreated) {
      onCreated(result.credential);
      return;
    }
    if (returnContext) {
      router.replace(
        inspectorEditorReturnHref({
          ...returnContext,
          credentialId: result.credential.id,
        }),
      );
      return;
    }
    router.replace(`/credentials/${result.credential.id}`);
  }

  const modal = variant === "modal";

  return (
    <div className="space-y-6">
      {modal ? null : <IsolationIdentityPanel />}
      {problem ? <ProblemBanner problem={problem} /> : null}
      {strippedKeys.length ? (
        <p role="status" className="text-sm text-amber-900">
          Unexpected secret fields were stripped from the create response:{" "}
          {strippedKeys.join(", ")}.
        </p>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          Step {stepIndex + 1} of {WIZARD_STEPS.length}
        </p>
        <h2 className="mt-1 text-lg font-semibold">{STEP_LABEL[step]}</h2>
        <ol className="mt-3 flex flex-wrap gap-2 text-sm text-zinc-600">
          {WIZARD_STEPS.map((item, index) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => go(item)}
                className={
                  item === step
                    ? "rounded-full bg-teal-800 px-3 py-1.5 text-white"
                    : "rounded-full border border-zinc-200 px-3 py-1.5 hover:border-zinc-400"
                }
              >
                {index + 1}. {STEP_LABEL[item]}
              </button>
            </li>
          ))}
        </ol>

        <div className="mt-6 space-y-4">
          {step === "identity" ? (
            <>
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
                  placeholder="prod, cluster"
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
                <span className="mt-1 block text-xs text-zinc-500">
                  Comma-separated lowercase letters, digits, or hyphen. Used
                  for search — never secret values.
                </span>
              </label>
            </>
          ) : null}

          {step === "type" ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Credential type</legend>
              {visibleTypes.map((item) => (
                <label key={item.type} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="credential-type"
                    checked={activeType === item.type}
                    onChange={() => {
                      setType(item.type);
                      setSecret(emptySecretDraft());
                      setMetadata({});
                    }}
                  />
                  <span>
                    <span className="font-medium">{item.displayName}</span>
                    <span className="block text-xs text-zinc-500">
                      {item.type}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {step === "secret" ? (
            <div className="space-y-4">
              {secretFields.map((field) => (
                <CatalogSecretField
                  key={field.name}
                  field={field}
                  value={activeSecret[field.name] ?? ""}
                  onChange={(value) => setSecretField(field.name, value)}
                />
              ))}
            </div>
          ) : null}

          {step === "metadata" ? (
            <div className="space-y-4">
              {metadataFields.length === 0 ? (
                <p className="text-sm text-zinc-600">
                  This type has no catalog metadata fields.
                </p>
              ) : (
                metadataFields.map((field) => (
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
                ))
              )}
              <label className="block text-sm">
                <span className="font-medium">Expires at (optional)</span>
                <input
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  placeholder="2026-12-31T23:59:59Z"
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
                <span className="mt-1 block text-xs text-zinc-500">
                  RFC3339 only. Leave blank for no expiry.
                </span>
              </label>
            </div>
          ) : null}

          {step === "review" ? (
            <dl className="grid gap-2 text-sm">
              <ReviewRow label="Display name" value={displayName || "—"} />
              <ReviewRow
                label="Tags"
                value={formatTagsInput(parseTagsInput(tagsInput)) || "—"}
              />
              <ReviewRow
                label="Type"
                value={`${credentialTypeLabel(activeType, catalog)} (${activeType})`}
              />
              <ReviewRow
                label="Secret fields"
                value={
                  secretFields
                    .map((field) =>
                      activeSecret[field.name]?.trim()
                        ? `${field.name} · entered`
                        : `${field.name} · empty`,
                    )
                    .join(", ") || "—"
                }
              />
              <ReviewRow
                label="Metadata"
                value={
                  Object.entries(metadata)
                    .filter(([, value]) => value.trim())
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ") || "—"
                }
              />
              <ReviewRow label="Expires at" value={expiresAt || "—"} />
              <p className="text-xs text-zinc-500">
                Secret values are not shown on review and are cleared after
                submit. The UI never reads <code>CREDENTIAL_KEK</code>.
              </p>
            </dl>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={() => go(WIZARD_STEPS[stepIndex - 1] ?? "identity")}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Back
            </button>
          ) : null}
          {step !== "review" ? (
            <button
              type="button"
              onClick={() => go(WIZARD_STEPS[stepIndex + 1] ?? "review")}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending || !ready || !displayName.trim()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {pending ? "Creating…" : "Create credential"}
            </button>
          )}
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CatalogSecretField({
  field,
  value,
  onChange,
}: {
  field: CredentialCatalogField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SecretField
      id={`secret-${field.name}`}
      label={field.name}
      multiline={field.input === "textarea"}
      required={field.required}
      value={value}
      onChange={onChange}
    />
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-zinc-500">{label} </dt>
      <dd className="inline">{value}</dd>
    </div>
  );
}
