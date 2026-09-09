"use client";

import { useEffect, useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import { PreRunPolicyReview } from "@/components/approvals/PreRunPolicyReview";
import { listCredentials } from "@/lib/credential-client";
import type { CredentialRecord } from "@/lib/credential-types";
import type { DevIdentity } from "@/lib/identity-headers";
import { KubernetesLeastPrivilegeNotes } from "@/components/config/KubernetesLeastPrivilegeNotes";
import { getKubernetesCatalog } from "@/lib/kubernetes-client";
import { authorizedClusterTargets } from "@/lib/kubernetes";
import {
  KUBERNETES_FIELD_MANAGER,
  KUBERNETES_NODE_POLICY_NOTES,
  applyRulesFromCatalog,
  engineErrorShapes,
  isKubernetesConfigurableType,
  waitReadyMessage,
} from "@/lib/kubernetes-node-contract";
import {
  KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE,
  effectiveWaitReady,
  isKubernetesRolloutType,
  rolloutNodeDescription,
} from "@/lib/kubernetes-rollout-contract";
import type { KubernetesEngineCatalog } from "@/lib/kubernetes-types";
import { listOpsConfig, selectOpsConfig } from "@/lib/ops-config-client";
import type { OpsConfigKind, OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { authorizedCommandProfiles, authorizedSshTargets } from "@/lib/ssh";
import type { PolicyEvaluation } from "@/lib/approval-types";
import {
  ACTION_FAMILY_ORDER,
  actionFamilyLabel,
  type ActionLibraryEntry,
} from "@/lib/workflow-action-library";
import {
  ACTION_WIZARD_STEPS,
  applyCredentialRef,
  applyTargetPin,
  applyWizardToYaml,
  authorizedCredentialOptions,
  compatibleUpstreamOutputs,
  credentialTypesForAction,
  emptyActionWizardDraft,
  feedbackLabel,
  nextWizardStep,
  opsConfigKindsForAction,
  prevWizardStep,
  publishedPinsFromList,
  recommendActions,
  redactedYamlPreview,
  namespacesForWizardTarget,
  validateWizardDraft,
  wizardConfigFields,
  wizardNeedsTargetStep,
  wizardPolicyPreview,
  type ActionWizardDraft,
  type ActionWizardStep,
  type WizardFeedback,
} from "@/lib/workflow-action-wizard";
import type { CatalogPort, WorkflowCatalog } from "@/lib/workflow-types";
import type { YamlWorkflowNode } from "@/lib/workflow-yaml-nodes";

const STEP_LABEL: Record<ActionWizardStep, string> = {
  type: "Choose type",
  target: "Target and credential",
  configure: "Configure",
  connect: "Connect data",
  review: "Review",
};

type ActionWizardProps = {
  open: boolean;
  identity: DevIdentity;
  ready: boolean;
  catalog: WorkflowCatalog | null;
  entries: ActionLibraryEntry[];
  yaml: string;
  nodes: YamlWorkflowNode[];
  initialType?: string;
  upstream?: { type: string; port: CatalogPort } | null;
  permissions?: readonly string[] | null;
  evaluation?: PolicyEvaluation | null;
  evaluationPending?: boolean;
  evaluationProblem?: ProblemDetails | null;
  feedback: WizardFeedback;
  onClose: () => void;
  onAdd: (yaml: string, nodeId: string) => void;
};

export function ActionWizard({
  open,
  identity,
  ready,
  catalog,
  entries,
  yaml,
  nodes,
  initialType,
  upstream,
  permissions,
  evaluation,
  evaluationPending,
  evaluationProblem,
  feedback,
  onClose,
  onAdd,
}: ActionWizardProps) {
  const [step, setStep] = useState<ActionWizardStep>("type");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ActionWizardDraft>(() =>
    emptyActionWizardDraft(initialType ?? "", entryName(entries, initialType)),
  );
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [credentialProblem, setCredentialProblem] = useState<ProblemDetails | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<number | undefined>();
  const [pins, setPins] = useState<Partial<Record<OpsConfigKind, OpsConfigPin[]>>>({});
  const [pinProblems, setPinProblems] = useState<Partial<Record<OpsConfigKind, ProblemDetails>>>({});
  const [pinStatus, setPinStatus] = useState<Partial<Record<OpsConfigKind, number>>>({});
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const [engineCatalog, setEngineCatalog] = useState<KubernetesEngineCatalog | null>(
    null,
  );

  const entry = entries.find((item) => item.type === draft.type);
  const fields = wizardConfigFields(entry, draft.type, engineCatalog);
  const targetKinds = opsConfigKindsForAction(draft.type);
  const enabledTargetKinds = (Object.entries(pins) as [OpsConfigKind, OpsConfigPin[]][])
    .filter(([, items]) => items.length > 0)
    .map(([kind]) => kind);
  const { recommended, visible } = recommendActions({
    entries,
    query,
    upstream,
    permissions,
    enabledTargetKinds,
  });
  const credentialOptions = authorizedCredentialOptions({
    items: credentials,
    problem: credentialProblem,
    statusCode: credentialStatus,
    allowedTypes: credentialTypesForAction(draft.type),
  });
  const selectedClusterTarget = (pins.cluster_target ?? []).find(
    (pin) => pin.resourceId === draft.with.clusterTargetId,
  );
  const clusterTargetsLoaded = pinStatus.cluster_target !== undefined;
  const targetSelectorClosed =
    isKubernetesConfigurableType(draft.type) &&
    clusterTargetsLoaded &&
    ((pins.cluster_target ?? []).length === 0 || Boolean(pinProblems.cluster_target));
  const wizardContext = {
    allowedNamespaces: namespacesForWizardTarget(selectedClusterTarget),
    targetSelectorClosed,
    engineCatalog,
  };
  const applyRules = applyRulesFromCatalog(engineCatalog);
  const engineErrors = engineErrorShapes(engineCatalog);
  const validation = validateWizardDraft(draft, catalog, entry, wizardContext);
  const policy = wizardPolicyPreview({ entry, evaluation });
  const preview = redactedYamlPreview(draft, "new-action");

  // Remount via parent key when the wizard opens so draft/step reset
  // without a setState-in-effect.

  useEffect(() => {
    if (!open || !ready) {
      return;
    }
    let cancelled = false;
    void getKubernetesCatalog(identity).then((result) => {
      if (cancelled) {
        return;
      }
      setEngineCatalog(result.ok ? result.catalog : null);
    });
    void listCredentials(identity).then((result) => {
      if (cancelled) {
        return;
      }
      setCredentialStatus(result.statusCode);
      if (!result.ok) {
        setCredentialProblem(result.problem);
        setCredentials([]);
        return;
      }
      setCredentialProblem(null);
      setCredentials(result.items);
    });
    const kinds = new Set<OpsConfigKind>([
      "cluster_target",
      "ssh_target",
      "command_profile",
      "runtime_profile",
      "connection",
      "recipient_list",
      "message_template",
      "response_schema",
    ]);
    void Promise.all(
      [...kinds].map(async (kind) => {
        const result = await listOpsConfig(identity, kind);
        return [kind, result] as const;
      }),
    ).then((rows) => {
      if (cancelled) {
        return;
      }
      const nextPins: Partial<Record<OpsConfigKind, OpsConfigPin[]>> = {};
      const nextProblems: Partial<Record<OpsConfigKind, ProblemDetails>> = {};
      const nextStatus: Partial<Record<OpsConfigKind, number>> = {};
      for (const [kind, result] of rows) {
        nextStatus[kind] = result.statusCode;
        if (!result.ok) {
          nextProblems[kind] = result.problem;
          nextPins[kind] = [];
          continue;
        }
        nextPins[kind] =
          kind === "cluster_target"
            ? authorizedClusterTargets({ items: result.items }).options
            : kind === "ssh_target"
              ? authorizedSshTargets({ items: result.items }).options
              : kind === "command_profile"
                ? authorizedCommandProfiles({ items: result.items }).options
                : publishedPinsFromList({ items: result.items }).options;
      }
      setPins(nextPins);
      setPinProblems(nextProblems);
      setPinStatus(nextStatus);
    });
    return () => {
      cancelled = true;
    };
  }, [open, ready, identity]);

  const stepIndex = ACTION_WIZARD_STEPS.indexOf(step);

  function chooseType(type: string) {
    const selected = entries.find((item) => item.type === type);
    setDraft(emptyActionWizardDraft(type, selected?.name ?? type));
    setLocalErrors([]);
  }

  async function choosePin(kind: OpsConfigKind, pin: OpsConfigPin | null) {
    if (!pin) {
      setDraft((current) => applyTargetPin(current, kind, null));
      return;
    }
    const result = await selectOpsConfig(identity, kind, pin.resourceId, pin.versionId);
    if (!result.ok) {
      setPinProblems((current) => ({ ...current, [kind]: result.problem }));
      setPinStatus((current) => ({ ...current, [kind]: result.statusCode }));
      setDraft((current) => applyTargetPin(current, kind, null));
      return;
    }
    setPinProblems((current) => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
    setDraft((current) => applyTargetPin(current, kind, result.pin));
  }

  function submit() {
    const result = applyWizardToYaml(yaml, draft, catalog, entry, wizardContext);
    setLocalErrors(result.errors.length ? result.errors : validation.errors);
    if (result.errors.length > 0 || !result.node.id) {
      return;
    }
    onAdd(result.yaml, result.node.id);
  }

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-wizard-heading"
      className="fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-zinc-900/40 p-4"
    >
      <div className="my-8 w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-lg">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          Add action · step {stepIndex + 1} of {ACTION_WIZARD_STEPS.length}
        </p>
        <div className="mt-1 flex items-start justify-between gap-3">
          <h2 id="action-wizard-heading" className="text-lg font-semibold">
            {STEP_LABEL[step]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Close
          </button>
        </div>
        <p className="mt-1 text-sm text-zinc-600">
          Inserts a canonical YAML node on the canvas. Secrets stay in the
          vault — selectors show display names only.
        </p>
        <ol className="mt-3 flex flex-wrap gap-2 text-sm text-zinc-600">
          {ACTION_WIZARD_STEPS.map((item, index) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => setStep(item)}
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

        {feedback !== "idle" ? (
          <p
            role="status"
            className={`mt-4 text-sm ${
              feedback === "error" ? "text-rose-900" : "text-teal-900"
            }`}
          >
            {feedbackLabel(feedback)}
          </p>
        ) : null}

        <div className="mt-6 space-y-4">
          {step === "type" ? (
            <TypeStep
              query={query}
              onQuery={setQuery}
              recommended={recommended}
              visible={visible}
              selected={draft.type}
              onChoose={chooseType}
            />
          ) : null}
          {step === "target" ? (
            <TargetStep
              draft={draft}
              kinds={targetKinds}
              pins={pins}
              pinProblems={pinProblems}
              pinStatus={pinStatus}
              credentialOptions={credentialOptions}
              hideCredentialSelect={isKubernetesConfigurableType(draft.type)}
              onPin={choosePin}
              onCredential={(id) => {
                const next = credentialOptions.options.find((item) => item.id === id) ?? null;
                setDraft((current) => applyCredentialRef(current, next));
              }}
            />
          ) : null}
          {step === "configure" ? (
            <ConfigureStep
              draft={draft}
              fields={fields}
              allowedNamespaces={wizardContext.allowedNamespaces}
              applyRules={applyRules}
              engineErrors={engineErrors}
              engineCatalog={engineCatalog}
              waitReadyCopy={waitReadyMessage(engineCatalog)}
              onChange={setDraft}
            />
          ) : null}
          {step === "connect" ? (
            <ConnectStep
              draft={draft}
              entry={entry}
              nodes={nodes}
              catalog={catalog}
              entries={entries}
              onChange={setDraft}
            />
          ) : null}
          {step === "review" ? (
            <ReviewStep
              draft={draft}
              validation={validation}
              localErrors={localErrors}
              policy={policy}
              preview={preview}
              applyRules={applyRules}
              engineErrors={engineErrors}
              engineCatalog={engineCatalog}
              evaluation={evaluation ?? null}
              evaluationPending={Boolean(evaluationPending)}
              evaluationProblem={evaluationProblem ?? null}
            />
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={() => setStep(prevWizardStep(step))}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Back
            </button>
          ) : null}
          {step !== "review" ? (
            <button
              type="button"
              onClick={() => {
                if (step === "type" && !draft.type) {
                  setLocalErrors(["Choose an action type."]);
                  return;
                }
                if (step === "type" && !wizardNeedsTargetStep(draft.type)) {
                  setStep("configure");
                  return;
                }
                setLocalErrors([]);
                setStep(nextWizardStep(step));
              }}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!validation.ok || feedback === "pending"}
              className="rounded-lg border border-teal-800 bg-teal-800 px-3 py-2 text-sm font-medium text-white hover:bg-teal-900 disabled:opacity-60"
            >
              {feedback === "pending" ? "Adding…" : "Add action"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TypeStep({
  query,
  onQuery,
  recommended,
  visible,
  selected,
  onChoose,
}: {
  query: string;
  onQuery: (value: string) => void;
  recommended: { type: string; reasons: string[] }[];
  visible: ActionLibraryEntry[];
  selected: string;
  onChoose: (type: string) => void;
}) {
  const recEntries = recommended
    .map((item) => visible.find((entry) => entry.type === item.type))
    .filter((item): item is ActionLibraryEntry => Boolean(item));

  return (
    <div className="space-y-4">
      <label className="block text-sm">
        <span className="font-medium">Search types</span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="kubernetes, ssh, delay…"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>
      {recEntries.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">Recommended</h3>
          <ul className="mt-2 space-y-2">
            {recEntries.map((entry) => {
              const reasons = recommended.find((item) => item.type === entry.type)?.reasons ?? [];
              return (
                <TypeCard
                  key={`rec-${entry.type}`}
                  entry={entry}
                  selected={selected === entry.type}
                  reason={reasons[0]}
                  onChoose={onChoose}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
      {ACTION_FAMILY_ORDER.map((family) => {
        const items = visible.filter((entry) => entry.family === family);
        if (items.length === 0) {
          return null;
        }
        return (
          <div key={family}>
            <h3 className="text-sm font-medium">{actionFamilyLabel(family)}</h3>
            <ul className="mt-2 space-y-2">
              {items.map((entry) => (
                <TypeCard
                  key={entry.type}
                  entry={entry}
                  selected={selected === entry.type}
                  onChoose={onChoose}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TypeCard({
  entry,
  selected,
  reason,
  onChoose,
}: {
  entry: ActionLibraryEntry;
  selected: boolean;
  reason?: string;
  onChoose: (type: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onChoose(entry.type)}
        className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
          selected
            ? "border-teal-800 bg-teal-50"
            : "border-zinc-200 hover:border-zinc-400"
        }`}
      >
        <span className="font-medium">{entry.name}</span>
        <span className="ml-2 font-mono text-xs text-zinc-600">{entry.type}</span>
        {entry.source === "contract-fallback" ? (
          <span className="ml-2 text-xs text-zinc-500">contract-fallback</span>
        ) : null}
        {reason ? <span className="mt-1 block text-xs text-zinc-600">{reason}</span> : null}
      </button>
    </li>
  );
}

function TargetStep({
  draft,
  kinds,
  pins,
  pinProblems,
  pinStatus,
  credentialOptions,
  hideCredentialSelect,
  onPin,
  onCredential,
}: {
  draft: ActionWizardDraft;
  kinds: OpsConfigKind[];
  pins: Partial<Record<OpsConfigKind, OpsConfigPin[]>>;
  pinProblems: Partial<Record<OpsConfigKind, ProblemDetails>>;
  pinStatus: Partial<Record<OpsConfigKind, number>>;
  credentialOptions: ReturnType<typeof authorizedCredentialOptions>;
  hideCredentialSelect?: boolean;
  onPin: (kind: OpsConfigKind, pin: OpsConfigPin | null) => void;
  onCredential: (id: string) => void;
}) {
  if (kinds.length === 0 && credentialOptions.options.length === 0 && credentialOptions.closed) {
    return (
      <p className="text-sm text-zinc-600">
        This action has no authorized target or credential selectors. Continue
        to configure.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {kinds.length === 0 ? (
        <p className="text-sm text-zinc-600">
          No cluster/SSH/profile selector for this type. Credentials below are
          display names only.
        </p>
      ) : null}
      {kinds.map((kind) => {
        const field =
          kind === "cluster_target"
            ? "clusterTargetId"
            : kind === "ssh_target"
              ? "sshTargetId"
              : kind === "command_profile"
                ? "commandProfileId"
                : kind === "runtime_profile"
                  ? "runtimeProfileId"
                  : kind === "connection"
                    ? "connectionId"
                    : kind === "recipient_list"
                      ? "recipientListId"
                      : kind === "message_template"
                        ? "templateId"
                        : "responseSchemaRef";
        const value = typeof draft.with[field] === "string" ? String(draft.with[field]) : "";
        const selected = (pins[kind] ?? []).find(
          (pin) => pin.resourceId === value || pin.versionId === value,
        );
        return (
          <AuthorizedResourceSelect
            key={kind}
            kind={kind}
            label={
              kind === "cluster_target"
                ? "Published kubernetes cluster target"
                : kind.replaceAll("_", " ")
            }
            value={selected?.versionId ?? ""}
            pins={pins[kind] ?? []}
            problem={pinProblems[kind] ?? null}
            statusCode={pinStatus[kind]}
            onChange={(pin) => void onPin(kind, pin)}
          />
        );
      })}
      {isKubernetesConfigurableType(draft.type) ? (
        <p className="text-xs text-zinc-500">
          Display name + id only. Workspace <code className="font-mono">type=kubernetes</code>{" "}
          targets; the target binds a vault credential. The UI never receives kubeconfig
          or plaintext.
        </p>
      ) : null}
      {credentialTypesForAction(draft.type).length > 0 && !hideCredentialSelect ? (
        <label className="block text-sm">
          <span className="font-medium">Credential (display name)</span>
          <select
            value={draft.credentialId}
            disabled={credentialOptions.closed}
            onChange={(event) => onCredential(event.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-50"
          >
            <option value="">
              {credentialOptions.closed
                ? "No authorized credentials"
                : "Select by display name"}
            </option>
            {credentialOptions.options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName} ({item.type})
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-zinc-500">
            Vault metadata only. YAML stores target/profile UUIDs — never
            plaintext. {draft.credentialDisplayName
              ? `Selected ${draft.credentialDisplayName}.`
              : "The target pin binds the credential server-side."}
          </span>
          {credentialOptions.closed ? (
            <span role="status" className="mt-1 block text-sm text-zinc-600">
              {credentialOptions.reason}
            </span>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}

function ConfigureStep({
  draft,
  fields,
  allowedNamespaces,
  applyRules,
  engineErrors,
  engineCatalog,
  waitReadyCopy,
  onChange,
}: {
  draft: ActionWizardDraft;
  fields: ReturnType<typeof wizardConfigFields>;
  allowedNamespaces: readonly string[];
  applyRules: ReturnType<typeof applyRulesFromCatalog>;
  engineErrors: ReturnType<typeof engineErrorShapes>;
  engineCatalog: KubernetesEngineCatalog | null;
  waitReadyCopy: string;
  onChange: (draft: ActionWizardDraft) => void;
}) {
  const inferred = fields.some((field) => field.inferred);
  const kubernetes = isKubernetesConfigurableType(draft.type);
  const visible = fields.filter((field) => !field.selectorKind);
  const primary = visible.filter((field) => !field.advanced);
  const advanced = visible.filter((field) => field.advanced);
  function patchWith(name: string, value: unknown) {
    onChange({
      ...draft,
      with: { ...draft.with, [name]: value },
    });
  }
  return (
    <div className="space-y-4">
      <label className="block text-sm">
        <span className="font-medium">Name</span>
        <input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>
      {inferred && !kubernetes ? (
        <p className="text-xs text-zinc-500">
          Configure fields are inferred from phase/ports and the YAML schema
          until catalog <code className="font-mono">allowedWith</code> is
          richer (jonny follow-up).
        </p>
      ) : null}
      {inferred && kubernetes ? (
        <p className="text-xs text-zinc-500">
          Kubernetes <code className="font-mono">with</code> fields prefer{" "}
          <code className="font-mono">GET /kubernetes/catalog</code>{" "}
          <code className="font-mono">nodes[]</code> from #78, then{" "}
          <code className="font-mono">GET /workflows/catalog</code>, then the
          marked contract fallback.
        </p>
      ) : null}
      {isKubernetesRolloutType(draft.type) ? (
        <p className="rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-2 text-sm text-teal-950">
          {rolloutNodeDescription(engineCatalog)} {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
        </p>
      ) : null}
      {kubernetes ? (
        <details className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-teal-950">
            Policy constraints (fail closed)
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-teal-950">
            {KUBERNETES_NODE_POLICY_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-teal-950">
            Apply uses FieldManager={applyRules.fieldManager}, Force=
            {String(applyRules.force)}, serverDryRunAlways=
            {String(applyRules.serverDryRunAlways)}. wait=ready →{" "}
            {effectiveWaitReady(engineCatalog)} (bounded watch of
            Deployment/StatefulSet/DaemonSet/Job; other kinds skip).{" "}
            {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
          </p>
          {engineErrors.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-teal-900">
              {engineErrors.slice(0, 8).map((item) => (
                <li key={item.code}>
                  <code className="font-mono">{item.code}</code> ({item.status}):{" "}
                  {item.meaning}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3">
            <KubernetesLeastPrivilegeNotes />
          </div>
        </details>
      ) : null}
      {kubernetes && draft.with.wait === "ready" ? (
        <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
          {waitReadyCopy}
        </p>
      ) : null}
      {primary.map((field) => (
        <ConfigField
          key={field.name}
          field={field}
          value={draft.with[field.name]}
          allowedNamespaces={field.name === "namespace" ? allowedNamespaces : undefined}
          onChange={(value) => patchWith(field.name, value)}
        />
      ))}
      {advanced.length > 0 ? (
        <details className="rounded-xl border border-zinc-200 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced
          </summary>
          <div className="mt-3 space-y-4">
            {advanced.map((field) => (
              <ConfigField
                key={field.name}
                field={field}
                value={draft.with[field.name]}
                onChange={(value) => patchWith(field.name, value)}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ConfigField({
  field,
  value,
  allowedNamespaces,
  onChange,
}: {
  field: ReturnType<typeof wizardConfigFields>[number];
  value: unknown;
  allowedNamespaces?: readonly string[];
  onChange: (value: unknown) => void;
}) {
  const text =
    value == null || value === ""
      ? field.readOnly
        ? String(field.defaultValue ?? KUBERNETES_FIELD_MANAGER)
        : ""
      : String(value);
  const label = field.label || field.name;
  if (field.readOnly) {
    return (
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <input
          value={text}
          readOnly
          disabled
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          {field.description ||
            "Service-owned. FieldManager is flowforge and Force=false."}
        </span>
      </label>
    );
  }
  if (field.name === "namespace" && allowedNamespaces && allowedNamespaces.length > 0) {
    return (
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <select
          value={text}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="">Select an allowed namespace</option>
          {allowedNamespaces.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-zinc-500">
          Allowlisted on the selected cluster target. Empty allowlists fail closed.
        </span>
      </label>
    );
  }
  if (field.control === "enum") {
    return (
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <select
          value={text}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        >
          {(field.enumValues ?? []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        {field.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
        ) : null}
      </label>
    );
  }
  if (field.control === "textarea" || field.control === "object-lines") {
    return (
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <textarea
          value={
            field.control === "object-lines" && value && typeof value === "object"
              ? Object.entries(value as Record<string, unknown>)
                  .map(([key, nested]) => `${key}=${String(nested)}`)
                  .join("\n")
              : text
          }
          onChange={(event) => {
            if (field.control === "object-lines") {
              const next: Record<string, string> = {};
              for (const line of event.target.value.split("\n")) {
                const cut = line.indexOf("=");
                if (cut <= 0) {
                  continue;
                }
                next[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
              }
              onChange(next);
              return;
            }
            onChange(event.target.value);
          }}
          rows={field.name === "manifests" ? 12 : 6}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm"
        />
        {field.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
        ) : null}
      </label>
    );
  }
  if (field.control === "number") {
    return (
      <label className="block text-sm">
        <span className="font-medium">{label}</span>
        <input
          type="number"
          value={text}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />
        {field.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
        ) : null}
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <input
        value={text}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
      />
      {field.description ? (
        <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
      ) : null}
    </label>
  );
}

function ConnectStep({
  draft,
  entry,
  nodes,
  catalog,
  entries,
  onChange,
}: {
  draft: ActionWizardDraft;
  entry?: ActionLibraryEntry;
  nodes: YamlWorkflowNode[];
  catalog: WorkflowCatalog | null;
  entries: ActionLibraryEntry[];
  onChange: (draft: ActionWizardDraft) => void;
}) {
  const inputs = entry?.inputs ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600">
        Map upstream typed outputs onto this action&apos;s inputs. Sensitive
        preview values are redacted.
      </p>
      {inputs.length === 0 ? (
        <p className="text-sm text-zinc-600">This action has no input ports.</p>
      ) : (
        inputs.map((port) => {
          const options = compatibleUpstreamOutputs(nodes, catalog, entries, port);
          const current = draft.mappings.find((item) => item.toPort === port.name)?.from ?? "";
          return (
            <label key={port.name} className="block text-sm">
              <span className="font-medium">
                {port.name}{" "}
                <span className="font-mono text-xs text-zinc-500">({port.kind})</span>
              </span>
              <select
                value={current}
                onChange={(event) => {
                  const from = event.target.value;
                  const rest = draft.mappings.filter((item) => item.toPort !== port.name);
                  onChange({
                    ...draft,
                    mappings: from ? [...rest, { from, toPort: port.name }] : rest,
                  });
                }}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">No mapping</option>
                {options.map((option) => (
                  <option key={option.from} value={option.from}>
                    {option.nodeName} · {option.from}
                  </option>
                ))}
              </select>
            </label>
          );
        })
      )}
      {draft.mappings.length > 0 ? (
        <pre className="overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
          {JSON.stringify(
            draft.mappings.map((item) => ({ from: item.from, to: item.toPort })),
            null,
            2,
          )}
        </pre>
      ) : null}
    </div>
  );
}

function ReviewStep({
  draft,
  validation,
  localErrors,
  policy,
  preview,
  evaluation,
  evaluationPending,
  evaluationProblem,
  applyRules,
  engineErrors,
  engineCatalog,
}: {
  draft: ActionWizardDraft;
  validation: ReturnType<typeof validateWizardDraft>;
  localErrors: string[];
  policy: ReturnType<typeof wizardPolicyPreview>;
  preview: string;
  evaluation: PolicyEvaluation | null;
  evaluationPending: boolean;
  evaluationProblem: ProblemDetails | null;
  applyRules: ReturnType<typeof applyRulesFromCatalog>;
  engineErrors: ReturnType<typeof engineErrorShapes>;
  engineCatalog: KubernetesEngineCatalog | null;
}) {
  const errors = [...validation.errors, ...localErrors];
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="inline text-zinc-500">Type </dt>
          <dd className="inline font-mono text-xs">{draft.type || "—"}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-500">Name </dt>
          <dd className="inline">{draft.name || "—"}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-500">Credential </dt>
          <dd className="inline">{draft.credentialDisplayName || "bound via target"}</dd>
        </div>
      </dl>
      <section className="rounded-xl border border-zinc-200 px-4 py-3">
        <h3 className="text-sm font-semibold">Policy impact</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Permissions: {policy.permissions.join(", ") || "—"}. {policy.retryHint}{" "}
          {policy.approvalHint}
        </p>
        {policy.catalogSource === "inferred" ? (
          <p className="mt-1 text-xs text-zinc-500">
            Policy metadata inferred from the catalog stub. Richer{" "}
            <code className="font-mono">allowedWith</code> / policy is a jonny
            follow-up.
          </p>
        ) : null}
        {draft.type.startsWith("kubernetes.") ? (
          <p className="mt-2 text-xs text-zinc-600">
            SSA FieldManager={applyRules.fieldManager} Force={String(applyRules.force)}.
            Server dry-run always runs before persist. wait=ready →{" "}
            {effectiveWaitReady(engineCatalog)} (observable kinds only;
            others observation=skipped). {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
            {engineErrors.some((item) => item.code === "ownership-conflict")
              ? " Ownership conflicts return 409; force is never applied."
              : ""}
          </p>
        ) : null}
      </section>
      <PreRunPolicyReview
        evaluation={evaluation}
        pending={evaluationPending}
        problem={evaluationProblem}
      />
      <section className="rounded-xl border border-zinc-200 px-4 py-3">
        <h3 className="text-sm font-semibold">Redacted YAML preview</h3>
        <pre className="mt-2 overflow-auto font-mono text-xs text-zinc-800">{preview}</pre>
      </section>
      {errors.length > 0 ? (
        <ul className="space-y-1 text-sm text-rose-900">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-600">Validation passed. Add writes this node into the draft YAML.</p>
      )}
    </div>
  );
}

function entryName(entries: ActionLibraryEntry[], type?: string): string {
  if (!type) {
    return "";
  }
  return entries.find((item) => item.type === type)?.name ?? type;
}
