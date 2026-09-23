"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Field } from "@/components/a11y/Field";
import { SessionSetupHint } from "@/components/session/SessionSetupHint";
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
import { type InspectorCredentialReturnTo } from "@/lib/editor-credential";
import {
  CREDENTIAL_NDV_ADD_STRIP_STOP_HELP,
  credentialNdvEditorReturnHref,
  credentialNdvMustStopAfterStrip,
} from "@/lib/credential-ndv-add";
import {
  FF_VAULT_CHIP_ACCENT_CLASS,
  FF_VAULT_CHIP_CLASS,
  FF_VAULT_CONTROL_CLASS,
  FF_VAULT_DANGER_CLASS,
  FF_VAULT_GHOST_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_PANEL_CLASS,
  FF_VAULT_PRIMARY_CLASS,
  FF_VAULT_ROOT_CLASS,
  FF_VAULT_TITLE_CLASS,
} from "@/lib/vault-executions-visual";

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
        credentialNdvEditorReturnHref({
          ...returnContext,
          credentialId: result.credential.id,
          displayName: result.credential.displayName,
          type: result.credential.type,
        }),
      );
      return;
    }
    router.replace(`/credentials/${result.credential.id}`);
  }

  const modal = variant === "modal";

  return (
    <div className={`${FF_VAULT_ROOT_CLASS} space-y-6`}>
      {!modal && !ready ? (
        <SessionSetupHint purpose="before adding a credential." />
      ) : null}
      {problem ? <ProblemBanner problem={problem} /> : null}
      {credentialNdvMustStopAfterStrip(strippedKeys) ? (
        <p role="alert" className={`text-sm ${FF_VAULT_DANGER_CLASS}`}>
          {CREDENTIAL_NDV_ADD_STRIP_STOP_HELP} Stripped keys:{" "}
          {strippedKeys.join(", ")}.
        </p>
      ) : null}

      <section className={FF_VAULT_PANEL_CLASS}>
        <p className={`text-sm font-medium tracking-wide uppercase ${FF_VAULT_MUTED_CLASS}`}>
          Step {stepIndex + 1} of {WIZARD_STEPS.length}
        </p>
        <h2 className={`mt-1 text-lg ${FF_VAULT_TITLE_CLASS}`}>{STEP_LABEL[step]}</h2>
        <ol className={`mt-3 flex flex-wrap gap-2 text-sm ${FF_VAULT_MUTED_CLASS}`}>
          {WIZARD_STEPS.map((item, index) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => go(item)}
                className={
                  item === step
                    ? FF_VAULT_CHIP_ACCENT_CLASS
                    : FF_VAULT_CHIP_CLASS
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
              <Field id="credential-display-name" label="Display name">
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="off"
                  className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
                />
              </Field>
              <Field
                id="credential-tags"
                label="Tags"
                hint="Comma-separated lowercase letters, digits, or hyphen. Used for search — never secret values."
                hintClassName={`mt-1 block text-xs ${FF_VAULT_MUTED_CLASS}`}
              >
                <input
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  placeholder="prod, cluster"
                  autoComplete="off"
                  className={`mt-1 ${FF_VAULT_CONTROL_CLASS}`}
                />
              </Field>
            </>
          ) : null}

          {step === "type" ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Credential type</legend>
              {visibleTypes.map((item) => (
                <Field
                  key={item.type}
                  id={`credential-type-${item.type}`}
                  controlPlacement="before-label"
                  className="flex items-start gap-2 text-sm"
                  labelClassName=""
                  label={
                    <>
                      <span className="font-medium">{item.displayName}</span>
                      <span className={`block text-xs ${FF_VAULT_MUTED_CLASS}`}>
                        {item.type}
                      </span>
                    </>
                  }
                >
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
                </Field>
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
                <p className={`text-sm ${FF_VAULT_MUTED_CLASS}`}>
                  This type has no catalog metadata fields.
                </p>
              ) : (
                metadataFields.map((field) => (
                  <Field key={field.name} id={`credential-meta-${field.name}`} label={field.name}>
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
                  </Field>
                ))
              )}
              <Field
                id="credential-expires-at"
                label="Expires at (optional)"
                hint="RFC3339 only. Leave blank for no expiry."
                hintClassName={`mt-1 block text-xs ${FF_VAULT_MUTED_CLASS}`}
              >
                <input
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  placeholder="2026-12-31T23:59:59Z"
                  autoComplete="off"
                  className={`mt-1 font-mono ${FF_VAULT_CONTROL_CLASS}`}
                />
              </Field>
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
              <p className={`text-xs ${FF_VAULT_MUTED_CLASS}`}>
                Secret values are not shown on review and are cleared after
                submit. Display-name + UUID only.
              </p>
            </dl>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={() => go(WIZARD_STEPS[stepIndex - 1] ?? "identity")}
              className={FF_VAULT_GHOST_CLASS}
            >
              Back
            </button>
          ) : null}
          {step !== "review" ? (
            <button
              type="button"
              onClick={() => go(WIZARD_STEPS[stepIndex + 1] ?? "review")}
              className={FF_VAULT_PRIMARY_CLASS}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending || !ready || !displayName.trim()}
              className={FF_VAULT_PRIMARY_CLASS}
            >
              {pending ? "Creating…" : "Create credential"}
            </button>
          )}
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className={FF_VAULT_GHOST_CLASS}
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
      <dt className={`inline ${FF_VAULT_MUTED_CLASS}`}>{label} </dt>
      <dd className="inline">{value}</dd>
    </div>
  );
}
