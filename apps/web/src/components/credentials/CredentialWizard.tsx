"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { IsolationIdentityPanel } from "@/components/isolation/IsolationIdentityPanel";
import { ProblemBanner } from "@/components/ProblemBanner";
import { SecretField } from "@/components/credentials/SecretField";
import {
  clearSecretDraftAfterSubmit,
  credentialTypeLabel,
  formatTagsInput,
  parseTagsInput,
} from "@/lib/credential";
import { createCredential } from "@/lib/credential-client";
import { emptySecretDraft, secretFieldsForType } from "@/lib/credential-contract";
import {
  CREDENTIAL_ALLOWED_USES,
  CREDENTIAL_MVP_TYPES,
  WIZARD_STEPS,
  type CredentialAllowedUse,
  type CredentialSecretDraft,
  type CredentialTargetMetadata,
  type CredentialType,
  type WizardStep,
} from "@/lib/credential-types";
import { emptyStoredIdentity, loadDevIdentity, subscribeDevIdentity } from "@/lib/dev-identity";
import { loadHeaderFallback, subscribeHeaderFallback } from "@/lib/header-fallback";
import { hasOperatorCaller, hasWorkspaceLookup } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { getSessionSnapshot, subscribeSession } from "@/lib/session-store";

const STEP_LABEL: Record<WizardStep, string> = {
  identity: "Name and tags",
  type: "Type",
  secret: "Secret fields",
  target: "Target metadata",
  policy: "Ownership and use",
  review: "Review",
};

export function CredentialWizard() {
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

  const [step, setStep] = useState<WizardStep>("identity");
  const [displayName, setDisplayName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [type, setType] = useState<CredentialType>("kubernetes_target");
  const [secret, setSecret] = useState<CredentialSecretDraft>(emptySecretDraft());
  const [target, setTarget] = useState<CredentialTargetMetadata>({});
  const [allowedUse, setAllowedUse] = useState<CredentialAllowedUse[]>([
    "credential.use",
  ]);
  const [rotateAfter, setRotateAfter] = useState("");
  const [testOnCreate, setTestOnCreate] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [strippedKeys, setStrippedKeys] = useState<string[]>([]);

  const ready =
    hasOperatorCaller(session.active, identity, headerFallback) &&
    hasWorkspaceLookup(identity);
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const secretKeys = useMemo(() => secretFieldsForType(type), [type]);

  function setSecretField(key: keyof CredentialSecretDraft, value: string) {
    setSecret((current) => ({ ...current, [key]: value }));
  }

  function go(next: WizardStep) {
    setStep(next);
  }

  async function submit() {
    setPending(true);
    setProblem(null);
    const result = await createCredential(identity, {
      displayName,
      tags: parseTagsInput(tagsInput),
      type,
      secret,
      targetMetadata: target,
      ownership: {
        ownerDisplayName: identity.displayName || session.session.displayName,
      },
      allowedUse,
      rotateAfter,
      testOnCreate,
    });
    setSecret(clearSecretDraftAfterSubmit(secret));
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setStrippedKeys(result.strippedKeys);
    router.replace(`/credentials/${result.credential.id}`);
  }

  return (
    <div className="space-y-6">
      <IsolationIdentityPanel />
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
        <ol className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-600">
          {WIZARD_STEPS.map((item, index) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => go(item)}
                className={
                  item === step
                    ? "rounded-full bg-teal-800 px-2 py-0.5 text-white"
                    : "rounded-full border border-zinc-200 px-2 py-0.5"
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
                  Comma-separated. Used for search — never secret values.
                </span>
              </label>
            </>
          ) : null}

          {step === "type" ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Credential type</legend>
              {CREDENTIAL_MVP_TYPES.map((item) => (
                <label key={item} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="credential-type"
                    checked={type === item}
                    onChange={() => {
                      setType(item);
                      setSecret(emptySecretDraft());
                    }}
                  />
                  <span>
                    <span className="font-medium">{credentialTypeLabel(item)}</span>
                    <span className="block text-xs text-zinc-500">{item}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {step === "secret" ? (
            <div className="space-y-4">
              {secretKeys.includes("kubeconfig") ? (
                <SecretField
                  id="kubeconfig"
                  label="Kubeconfig"
                  multiline
                  value={secret.kubeconfig ?? ""}
                  onChange={(value) => setSecretField("kubeconfig", value)}
                />
              ) : null}
              {secretKeys.includes("token") ? (
                <SecretField
                  id="token"
                  label="Token"
                  value={secret.token ?? ""}
                  onChange={(value) => setSecretField("token", value)}
                />
              ) : null}
              {secretKeys.includes("privateKey") ? (
                <SecretField
                  id="private-key"
                  label="SSH private key"
                  multiline
                  value={secret.privateKey ?? ""}
                  onChange={(value) => setSecretField("privateKey", value)}
                />
              ) : null}
              {secretKeys.includes("passphrase") ? (
                <SecretField
                  id="passphrase"
                  label="Key passphrase (optional)"
                  value={secret.passphrase ?? ""}
                  onChange={(value) => setSecretField("passphrase", value)}
                />
              ) : null}
              {secretKeys.includes("apiKey") ? (
                <SecretField
                  id="api-key"
                  label="API key"
                  value={secret.apiKey ?? ""}
                  onChange={(value) => setSecretField("apiKey", value)}
                />
              ) : null}
              {secretKeys.includes("secret") ? (
                <SecretField
                  id="webhook-secret"
                  label="Webhook secret"
                  value={secret.secret ?? ""}
                  onChange={(value) => setSecretField("secret", value)}
                />
              ) : null}
            </div>
          ) : null}

          {step === "target" ? (
            <TargetMetadataFields type={type} value={target} onChange={setTarget} />
          ) : null}

          {step === "policy" ? (
            <div className="space-y-4">
              <fieldset>
                <legend className="text-sm font-medium">Allowed use</legend>
                <div className="mt-2 space-y-2">
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
              <label className="block text-sm">
                <span className="font-medium">Rotate after</span>
                <input
                  type="date"
                  value={rotateAfter}
                  onChange={(event) => setRotateAfter(event.target.value)}
                  className="mt-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={testOnCreate}
                  onChange={(event) => setTestOnCreate(event.target.checked)}
                />
                Test connection after create
              </label>
            </div>
          ) : null}

          {step === "review" ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <ReviewRow label="Display name" value={displayName || "—"} />
              <ReviewRow label="Type" value={credentialTypeLabel(type)} />
              <ReviewRow label="Tags" value={formatTagsInput(parseTagsInput(tagsInput)) || "—"} />
              <ReviewRow
                label="Secret fields prepared"
                value={
                  secretKeys
                    .filter((key) => Boolean(secret[key as keyof CredentialSecretDraft]))
                    .join(", ") || "none"
                }
              />
              <ReviewRow
                label="Allowed use"
                value={allowedUse.join(", ") || "—"}
              />
              <ReviewRow label="Rotate after" value={rotateAfter || "—"} />
              <ReviewRow
                label="Test on create"
                value={testOnCreate ? "yes" : "no"}
              />
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
              disabled={step === "identity" && !displayName.trim()}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
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
        </div>
      </section>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function TargetMetadataFields({
  type,
  value,
  onChange,
}: {
  type: CredentialType;
  value: CredentialTargetMetadata;
  onChange: (next: CredentialTargetMetadata) => void;
}) {
  function set<K extends keyof CredentialTargetMetadata>(
    key: K,
    next: CredentialTargetMetadata[K],
  ) {
    onChange({ ...value, [key]: next });
  }

  if (type === "kubernetes_target") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Cluster name"
          value={value.clusterName ?? ""}
          onChange={(next) => set("clusterName", next)}
        />
        <TextField
          label="API server host"
          value={value.apiServerHost ?? ""}
          onChange={(next) => set("apiServerHost", next)}
          hint="Hostname only — not a connection string."
        />
      </div>
    );
  }
  if (type === "ssh_private_key") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Hostname"
          value={value.hostname ?? ""}
          onChange={(next) => set("hostname", next)}
        />
        <TextField
          label="Port"
          value={value.port ? String(value.port) : ""}
          onChange={(next) =>
            set("port", next ? Number.parseInt(next, 10) : undefined)
          }
        />
        <TextField
          label="Username"
          value={value.username ?? ""}
          onChange={(next) => set("username", next)}
        />
        <TextField
          label="Host key fingerprint"
          value={value.hostKeyFingerprint ?? ""}
          onChange={(next) => set("hostKeyFingerprint", next)}
        />
      </div>
    );
  }
  if (type === "token") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Issuer hint"
          value={value.issuerHint ?? ""}
          onChange={(next) => set("issuerHint", next)}
        />
        <TextField
          label="Audience hint"
          value={value.audienceHint ?? ""}
          onChange={(next) => set("audienceHint", next)}
        />
      </div>
    );
  }
  return (
    <TextField
      label="Destination label"
      value={value.destinationLabel ?? ""}
      onChange={(next) => set("destinationLabel", next)}
      hint="Safe label only. Do not paste webhook URLs that embed secrets."
    />
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
      />
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}
