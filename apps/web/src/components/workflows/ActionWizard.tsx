"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import { Field } from "@/components/a11y/Field";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import { PreRunPolicyReview } from "@/components/approvals/PreRunPolicyReview";
import { listCredentials } from "@/lib/credential-client";
import type { CredentialRecord } from "@/lib/credential-types";
import type { DevIdentity } from "@/lib/identity-headers";
import { KubernetesLeastPrivilegeNotes } from "@/components/config/KubernetesLeastPrivilegeNotes";
import { ScriptIsolationNotes } from "@/components/config/ScriptIsolationNotes";
import { ScriptIoFields } from "@/components/workflows/ScriptIoFields";
import { ScriptRetryFields } from "@/components/workflows/ScriptRetryFields";
import { SshSafetyNotes } from "@/components/config/SshSafetyNotes";
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
import { loadPublishedScriptRuntimeProfiles } from "@/lib/script-runtime-client";
import type { OpsConfigKind, OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { getSshCatalog } from "@/lib/ssh-client";
import { authorizedCommandProfiles, authorizedSshTargets } from "@/lib/ssh";
import {
  SSH_NODE_POLICY_NOTES,
  commandProfileParameterConstraints,
  commandProfileRetrySafe,
  commandProfileVerificationDeclared,
  isSshConfigurableType,
  pruneSshParameters,
  sshNodeErrorShapes,
  sshRetryRules,
  type SshNodeCatalog,
} from "@/lib/ssh-node-contract";
import { getHttpNotificationCatalog } from "@/lib/core-http-notification-client";
import {
  HTTP_NOTIFICATION_NODE_POLICY_NOTES,
  HTTP_NOTIFICATION_ROUTE_MAP_SOURCE,
  HTTP_PIN_ONLY_HELP,
  HTTP_REDACTION_HELP,
  authorizedHttpConnections,
  connectionSelectorLabel,
  httpNotificationErrorShapes,
  httpNotificationPolicyRules,
  isHttpConfigurableType,
  type HttpNotificationCatalog,
} from "@/lib/core-http-notification-contract";
import { getScriptCatalog } from "@/lib/script-client";
import {
  SCRIPT_DRAFT_NOT_EXECUTABLE_HELP,
  SCRIPT_EXECUTE_FAIL_CLOSED_HELP,
  SCRIPT_MUTABLE_REJECT_HELP,
  SCRIPT_NODE_POLICY_NOTES,
  SCRIPT_PUBLISH_BOUNDARY_HELP,
  SCRIPT_ROUTE_MAP_SOURCE,
  isScriptConfigurableType,
  runtimeProfileLanguage,
  scriptNodeErrorShapes,
  scriptPublishRules,
  type ScriptNodeCatalog,
} from "@/lib/script-contract";
import {
  SCRIPT_IO_INDETERMINATE_HELP,
  SCRIPT_IO_ROUTE_MAP_SOURCE,
  defaultScriptIoRetryPolicy,
  isDedicatedScriptIoWithField,
  parseScriptEvaluateRetry,
  parseScriptIoCatalog,
  scriptIoRetryPolicyHint,
} from "@/lib/script-io-contract";
import {
  SCRIPT_RUNTIME_ISOLATION_HELP,
  SCRIPT_RUNTIME_LANGUAGE_FILTER_HELP,
  authorizedScriptRuntimeProfiles,
  runtimeProfileMapFromCatalog,
  runtimeProfileSelectorLabel,
} from "@/lib/script-runtime-contract";
import {
  SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
  SSH_INDETERMINATE_HELP,
  SSH_MAX_RETRY_ATTEMPTS,
  SSH_RETRY_DENIED_MESSAGE,
  SSH_RETRY_ZERO_MESSAGE,
  defaultSshRetryPolicy,
  parseSshEvaluateRetry,
  sshRetryPolicyHint,
  validateSshRetryPolicy,
} from "@/lib/ssh-retry-contract";
import type { SshEngineCatalog, SshParameterConstraint } from "@/lib/ssh-types";
import type { PolicyEvaluation } from "@/lib/approval-types";
import { type ActionLibraryEntry } from "@/lib/workflow-action-library";
import {
  PALETTE_CATEGORY_FIRST_HELP,
  PALETTE_CATEGORY_LABELS,
  PALETTE_CATALOG_UNAVAILABLE_HELP,
  paletteFirstPaint,
  type PaletteCategoryId,
} from "@/lib/palette-category-first";
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
import { satelliteOverlayTriggerId } from "@/lib/rewrite-satellite-a11y";

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
  scriptCatalog?: ScriptNodeCatalog | null;
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
  scriptCatalog: scriptCatalogProp,
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
  const [sshCatalog, setSshCatalog] = useState<SshNodeCatalog | null>(null);
  const [sshEngineCatalog, setSshEngineCatalog] = useState<SshEngineCatalog | null>(
    null,
  );
  const [scriptCatalogState, setScriptCatalogState] =
    useState<ScriptNodeCatalog | null>(null);
  const scriptCatalog = scriptCatalogProp ?? scriptCatalogState;
  const [httpCatalog, setHttpCatalog] = useState<HttpNotificationCatalog | null>(
    null,
  );

  const entry = entries.find((item) => item.type === draft.type);
  const fields = wizardConfigFields(
    entry,
    draft.type,
    engineCatalog,
    sshCatalog,
    scriptCatalog,
    httpCatalog,
  );
  const targetKinds = opsConfigKindsForAction(draft.type);
  const enabledTargetKinds = (Object.entries(pins) as [OpsConfigKind, OpsConfigPin[]][])
    .filter(([, items]) => items.length > 0)
    .map(([kind]) => kind);
  const { recommended, visible } = recommendActions({
    entries,
    catalog,
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
  const selectedCommandProfile = (pins.command_profile ?? []).find(
    (pin) => pin.resourceId === draft.with.commandProfileId,
  );
  const parameterConstraints = commandProfileParameterConstraints(
    selectedCommandProfile?.spec,
  );
  const profileRetrySafe = commandProfileRetrySafe(selectedCommandProfile?.spec);
  const verificationDeclared = commandProfileVerificationDeclared(
    selectedCommandProfile?.spec,
  );
  const clusterTargetsLoaded = pinStatus.cluster_target !== undefined;
  const sshTargetsLoaded = pinStatus.ssh_target !== undefined;
  const commandProfilesLoaded = pinStatus.command_profile !== undefined;
  const targetSelectorClosed =
    isKubernetesConfigurableType(draft.type) &&
    clusterTargetsLoaded &&
    ((pins.cluster_target ?? []).length === 0 || Boolean(pinProblems.cluster_target));
  const sshTargetSelectorClosed =
    isSshConfigurableType(draft.type) &&
    sshTargetsLoaded &&
    ((pins.ssh_target ?? []).length === 0 || Boolean(pinProblems.ssh_target));
  const commandProfileSelectorClosed =
    isSshConfigurableType(draft.type) &&
    commandProfilesLoaded &&
    ((pins.command_profile ?? []).length === 0 || Boolean(pinProblems.command_profile));
  const runtimeProfilesLoaded = pinStatus.runtime_profile !== undefined;
  const matchingRuntimeProfiles = authorizedScriptRuntimeProfiles({
    pins: pins.runtime_profile,
    nodeType: isScriptConfigurableType(draft.type) ? draft.type : undefined,
    problem: pinProblems.runtime_profile,
    statusCode: pinStatus.runtime_profile,
  });
  const runtimeProfileSelectorClosed =
    isScriptConfigurableType(draft.type) &&
    runtimeProfilesLoaded &&
    (matchingRuntimeProfiles.closed || Boolean(pinProblems.runtime_profile));
  const selectedRuntimeProfile = matchingRuntimeProfiles.options.find(
    (pin) => pin.resourceId === draft.with.runtimeProfileId,
  );
  const connectionsLoaded = pinStatus.connection !== undefined;
  const matchingConnections = authorizedHttpConnections({
    pins: pins.connection,
    nodeType: isHttpConfigurableType(draft.type) ? draft.type : undefined,
    problem: pinProblems.connection,
    statusCode: pinStatus.connection,
  });
  const connectionSelectorClosed =
    isHttpConfigurableType(draft.type) &&
    connectionsLoaded &&
    (matchingConnections.closed || Boolean(pinProblems.connection));
  const recipientsLoaded = pinStatus.recipient_list !== undefined;
  const templatesLoaded = pinStatus.message_template !== undefined;
  const schemasLoaded = pinStatus.response_schema !== undefined;
  const recipientSelectorClosed =
    draft.type === "notification.email" &&
    recipientsLoaded &&
    ((pins.recipient_list ?? []).length === 0 || Boolean(pinProblems.recipient_list));
  const templateSelectorClosed =
    draft.type === "notification.email" &&
    templatesLoaded &&
    ((pins.message_template ?? []).length === 0 || Boolean(pinProblems.message_template));
  const schemaSelectorClosed =
    draft.type === "http.request" &&
    schemasLoaded &&
    Boolean(pinProblems.response_schema);
  const selectedConnection = matchingConnections.options.find(
    (pin) => pin.resourceId === draft.with.connectionId,
  );
  const wizardContext = {
    allowedNamespaces: namespacesForWizardTarget(selectedClusterTarget),
    targetSelectorClosed,
    engineCatalog,
    sshCatalog,
    sshTargetSelectorClosed,
    commandProfileSelectorClosed,
    parameterConstraints,
    profileRetrySafe,
    verificationDeclared,
    scriptCatalog,
    runtimeProfileSelectorClosed,
    runtimeProfileLanguage: runtimeProfileLanguage(selectedRuntimeProfile?.spec),
    httpCatalog,
    connectionSelectorClosed,
    recipientSelectorClosed,
    templateSelectorClosed,
    schemaSelectorClosed,
    connectionType:
      typeof selectedConnection?.spec?.type === "string"
        ? selectedConnection.spec.type
        : null,
    endpointPolicy: selectedConnection?.spec?.endpointPolicy ?? null,
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
    void getSshCatalog(identity).then((result) => {
      if (cancelled) {
        return;
      }
      setSshCatalog(result.ok ? result.nodeCatalog : null);
      setSshEngineCatalog(result.ok ? result.catalog : null);
    });
    void getScriptCatalog(identity).then((result) => {
      if (cancelled) {
        return;
      }
      setScriptCatalogState(result.ok ? result.catalog : null);
    });
    void getHttpNotificationCatalog(identity).then((result) => {
      if (cancelled) {
        return;
      }
      setHttpCatalog(result.ok ? result.catalog : null);
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
      "connection",
      "recipient_list",
      "message_template",
      "response_schema",
    ]);
    void Promise.all([
      Promise.all(
        [...kinds].map(async (kind) => {
          const result = await listOpsConfig(identity, kind);
          return [kind, result] as const;
        }),
      ),
      loadPublishedScriptRuntimeProfiles(identity),
    ]).then(([rows, runtime]) => {
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
      nextStatus.runtime_profile = runtime.statusCode;
      if (!runtime.ok) {
        nextProblems.runtime_profile = runtime.problem;
        nextPins.runtime_profile = [];
      } else {
        nextPins.runtime_profile = runtime.items;
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
    setPins((current) => {
      const list = current[kind] ?? [];
      const merged = list.some((item) => item.resourceId === result.pin.resourceId)
        ? list.map((item) =>
            item.resourceId === result.pin.resourceId ? { ...item, ...result.pin } : item,
          )
        : [...list, result.pin];
      return { ...current, [kind]: merged };
    });
    setDraft((current) => {
      const next = applyTargetPin(current, kind, result.pin);
      if (kind !== "command_profile" || !isSshConfigurableType(next.type)) {
        return next;
      }
      const constraints = commandProfileParameterConstraints(result.pin.spec);
      const currentParams =
        next.with.parameters && typeof next.with.parameters === "object"
          ? (next.with.parameters as Record<string, unknown>)
          : {};
      return {
        ...next,
        with: {
          ...next.with,
          parameters: pruneSshParameters(currentParams, constraints),
        },
      };
    });
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
    <Dialog
      onClose={onClose}
      labelledBy="action-wizard-heading"
      returnFocusTo={satelliteOverlayTriggerId("action-wizard")}
      className="fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-zinc-900/40 p-4"
    >
      <div className="my-8 w-full max-w-3xl rounded-2xl border border-border bg-card p-6 shadow-lg">
        <p className="text-sm font-medium tracking-wide text-accent-text uppercase">
          Add action · step {stepIndex + 1} of {ACTION_WIZARD_STEPS.length}
        </p>
        <div className="mt-1 flex items-start justify-between gap-3">
          <h2 id="action-wizard-heading" className="text-lg font-semibold">
            {STEP_LABEL[step]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background"
          >
            Close
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Guided add: type → authorized target/credential → configure → map →
          review. Select a canvas node to edit it in the inspector. Secrets
          stay in the vault — selectors show display names only.
        </p>
        <ol className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
          {ACTION_WIZARD_STEPS.map((item, index) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => setStep(item)}
                className={
                  item === step
                    ? "rounded-full bg-teal-800 px-3 py-1.5 text-white"
                    : "rounded-full border border-border px-3 py-1.5 hover:border-border"
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
              feedback === "error" ? "text-destructive" : "text-accent-text"
            }`}
          >
            {feedbackLabel(feedback)}
          </p>
        ) : null}

        <div className="mt-6 space-y-4">
          {step === "type" ? (
            <TypeStep
              catalog={catalog}
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
              hideCredentialSelect={
                isKubernetesConfigurableType(draft.type) ||
                isSshConfigurableType(draft.type) ||
                isScriptConfigurableType(draft.type) ||
                isHttpConfigurableType(draft.type)
              }
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
              sshCatalog={sshCatalog}
              scriptCatalog={scriptCatalog}
              httpCatalog={httpCatalog}
              sshEngineCatalog={sshEngineCatalog}
              parameterConstraints={parameterConstraints}
              profileRetrySafe={profileRetrySafe}
              verificationDeclared={verificationDeclared}
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
              sshCatalog={sshCatalog}
              scriptCatalog={scriptCatalog}
              httpCatalog={httpCatalog}
              profileRetrySafe={profileRetrySafe}
              verificationDeclared={verificationDeclared}
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
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-background"
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
    </Dialog>
  );
}

function TypeStep({
  catalog,
  query,
  onQuery,
  recommended,
  visible,
  selected,
  onChoose,
}: {
  catalog: WorkflowCatalog | null;
  query: string;
  onQuery: (value: string) => void;
  recommended: { type: string; reasons: string[] }[];
  visible: ActionLibraryEntry[];
  selected: string;
  onChoose: (type: string) => void;
}) {
  const [selectedCategory, setSelectedCategory] =
    useState<PaletteCategoryId | null>(null);
  const paint = paletteFirstPaint({
    entries: visible,
    catalog,
    query,
    selectedCategory,
  });
  const recEntries = recommended
    .map((item) => visible.find((entry) => entry.type === item.type))
    .filter((item): item is ActionLibraryEntry => Boolean(item));

  return (
    <div className="space-y-4" data-uxl7="wizard-type" data-uxl7-paint={paint.kind}>
      <p className="text-sm text-muted-foreground">{PALETTE_CATEGORY_FIRST_HELP}</p>
      <Field id="action-wizard-search" label="Search types">
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="kubernetes, ssh, delay…"
          className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
        />
      </Field>
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
      {paint.kind === "categories" ? (
        <div data-uxl7="categories">
          <h3 className="text-sm font-medium">Categories</h3>
          <ul className="mt-2 space-y-2">
            {paint.categories.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  data-uxl7-category={group.id}
                  onClick={() => setSelectedCategory(group.id)}
                  className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm hover:border-border"
                >
                  <span className="font-medium">
                    {PALETTE_CATEGORY_LABELS[group.id]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {group.items.length} enabled
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {paint.kind === "category" ? (
        <div>
          <button
            type="button"
            onClick={() => setSelectedCategory(null)}
            className="text-xs font-medium text-accent-text underline"
          >
            All categories
          </button>
          <h3 className="mt-2 text-sm font-medium">
            {paint.selectedCategory
              ? PALETTE_CATEGORY_LABELS[paint.selectedCategory]
              : "Category"}
          </h3>
          <ul className="mt-2 space-y-2">
            {paint.items.map((entry) => (
              <TypeCard
                key={entry.type}
                entry={entry}
                selected={selected === entry.type}
                onChoose={onChoose}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {paint.kind === "search" ? (
        <div>
          <h3 className="text-sm font-medium">Search results</h3>
          <ul className="mt-2 space-y-2">
            {paint.items.map((entry) => (
              <TypeCard
                key={entry.type}
                entry={entry}
                selected={selected === entry.type}
                onChoose={onChoose}
              />
            ))}
          </ul>
          {paint.items.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No enabled actions match that search.
            </p>
          ) : null}
        </div>
      ) : null}
      {paint.kind === "unavailable" ? (
        <p className="text-sm text-muted-foreground" role="status">
          {paint.unavailableReason ?? PALETTE_CATALOG_UNAVAILABLE_HELP}
        </p>
      ) : null}
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
            ? "border-teal-800 bg-teal-50 text-teal-950"
            : "border-border text-foreground hover:border-border"
        }`}
      >
        <span className="font-medium">{entry.name}</span>
        <span className={`ml-2 font-mono text-xs ${selected ? "text-teal-900" : "text-muted-foreground"}`}>
          {entry.type}
        </span>
        {entry.source === "contract-fallback" ? (
          <span className={`ml-2 text-xs ${selected ? "text-teal-900" : "text-muted-foreground"}`}>
            catalog fallback (core)
          </span>
        ) : null}
        {reason ? (
          <span className={`mt-1 block text-xs ${selected ? "text-teal-900" : "text-muted-foreground"}`}>
            {reason}
          </span>
        ) : null}
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
      <p className="text-sm text-muted-foreground">
        This action has no authorized target or credential selectors. Continue
        to configure.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {kinds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
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
        const listed =
          kind === "runtime_profile"
            ? authorizedScriptRuntimeProfiles({
                pins: pins[kind],
                nodeType: draft.type,
                problem: pinProblems[kind],
                statusCode: pinStatus[kind],
              }).options
            : kind === "connection" && isHttpConfigurableType(draft.type)
              ? authorizedHttpConnections({
                  pins: pins[kind],
                  nodeType: draft.type,
                  problem: pinProblems[kind],
                  statusCode: pinStatus[kind],
                }).options
              : (pins[kind] ?? []);
        const selected = listed.find(
          (pin) => pin.resourceId === value || pin.versionId === value,
        );
        return (
          <AuthorizedResourceSelect
            key={kind}
            kind={kind}
            label={
              kind === "cluster_target"
                ? "Published kubernetes cluster target"
                : kind === "ssh_target"
                  ? "Published SSH target"
                    : kind === "command_profile"
                    ? "Published command profile"
                    : kind === "runtime_profile"
                      ? "Published runtime profile"
                    : kind === "connection"
                      ? draft.type === "notification.email"
                        ? "Published SMTP connection"
                        : draft.type === "notification.webhook"
                          ? "Published webhook connection"
                          : "Published HTTP connection"
                    : kind === "recipient_list"
                      ? "Published recipient list"
                      : kind === "message_template"
                        ? "Published message template"
                        : kind === "response_schema"
                          ? "Published response schema"
                    : kind.replaceAll("_", " ")
            }
            value={selected?.versionId ?? ""}
            pins={listed}
            problem={pinProblems[kind] ?? null}
            statusCode={pinStatus[kind]}
            optionLabel={
              kind === "runtime_profile"
                ? runtimeProfileSelectorLabel
                : kind === "connection"
                  ? connectionSelectorLabel
                  : undefined
            }
            onChange={(pin) => void onPin(kind, pin)}
          />
        );
      })}
      {isKubernetesConfigurableType(draft.type) ? (
        <p className="text-xs text-muted-foreground">
          Display name + id only. Workspace <code className="font-mono">type=kubernetes</code>{" "}
          targets; the target binds a vault credential. The UI never receives kubeconfig
          or plaintext.
        </p>
      ) : null}
      {isSshConfigurableType(draft.type) ? (
        <p className="text-xs text-muted-foreground">
          Display name + id only. Published workspace SSH targets bind a{" "}
          <code className="font-mono">type=ssh_private_key</code> vault credential.
          Command profiles are administrator-owned templates. The UI never lists
          privateKey, passphrase, host fingerprints as secrets, or raw logs.
        </p>
      ) : null}
      {isScriptConfigurableType(draft.type) ? (
        <p className="text-xs text-muted-foreground">
          Display name + id only. Choose a published approved runtime/dependency
          profile that matches this language — not an arbitrary image.{" "}
          {SCRIPT_RUNTIME_LANGUAGE_FILTER_HELP} Secrets are never listed.{" "}
          {SCRIPT_PUBLISH_BOUNDARY_HELP}
        </p>
      ) : null}
      {isHttpConfigurableType(draft.type) ? (
        <p className="text-xs text-muted-foreground">
          Display name + id only. Connections, recipient lists, templates, and
          response schemas are published workspace pins. There is no free-form
          URL, recipient address, or credential field. The connection binds the
          vault secret and requires TLS. {HTTP_PIN_ONLY_HELP}
        </p>
      ) : null}
      {credentialTypesForAction(draft.type).length > 0 && !hideCredentialSelect ? (
        <>
        <Field
          id="action-wizard-credential"
          label="Credential (display name)"
          hint={`Vault metadata only. YAML stores target/profile UUIDs — never plaintext. ${
            draft.credentialDisplayName
              ? `Selected ${draft.credentialDisplayName}.`
              : "The target pin binds the credential server-side."
          }`}
          hintClassName="mt-1 block text-xs text-muted-foreground"
        >
          <select
            value={draft.credentialId}
            disabled={credentialOptions.closed}
            onChange={(event) => onCredential(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm disabled:bg-background"
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
        </Field>
        {credentialOptions.closed ? (
          <span role="status" className="mt-1 block text-sm text-muted-foreground">
            {credentialOptions.reason}
          </span>
        ) : null}
        </>
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
  sshCatalog,
  scriptCatalog,
  httpCatalog,
  sshEngineCatalog,
  parameterConstraints,
  profileRetrySafe,
  verificationDeclared,
  onChange,
}: {
  draft: ActionWizardDraft;
  fields: ReturnType<typeof wizardConfigFields>;
  allowedNamespaces: readonly string[];
  applyRules: ReturnType<typeof applyRulesFromCatalog>;
  engineErrors: ReturnType<typeof engineErrorShapes>;
  engineCatalog: KubernetesEngineCatalog | null;
  waitReadyCopy: string;
  sshCatalog: SshNodeCatalog | null;
  scriptCatalog: ScriptNodeCatalog | null;
  httpCatalog: HttpNotificationCatalog | null;
  sshEngineCatalog: SshEngineCatalog | null;
  parameterConstraints: readonly SshParameterConstraint[];
  profileRetrySafe: boolean;
  verificationDeclared: boolean;
  onChange: (draft: ActionWizardDraft) => void;
}) {
  const inferred = fields.some((field) => field.inferred);
  const kubernetes = isKubernetesConfigurableType(draft.type);
  const ssh = isSshConfigurableType(draft.type);
  const script = isScriptConfigurableType(draft.type);
  const http = isHttpConfigurableType(draft.type);
  const httpPolicy = httpNotificationPolicyRules(httpCatalog);
  const visible = fields.filter(
    (field) =>
      !field.selectorKind &&
      !(ssh && field.name === "parameters") &&
      !(ssh && field.name === "retryPolicy") &&
      !(script && isDedicatedScriptIoWithField(field.name)),
  );
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
      <Field id="action-wizard-name" label="Name">
        <input
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
        />
      </Field>
      {inferred && !kubernetes && !ssh && !script && !http ? (
        <p className="text-xs text-muted-foreground">
          Configure fields are inferred from phase/ports and the YAML schema
          until catalog <code className="font-mono">allowedWith</code> is
          richer (jonny follow-up).
        </p>
      ) : null}
      {(kubernetes || ssh || script || http) && fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Live catalog did not provide{" "}
          <code className="font-mono">allowedWith</code> for this type.
          Configuration fields are not invented. YAML remains the source of
          truth. Empty or HTTP 403 catalogs fail closed.
        </p>
      ) : null}
      {isKubernetesRolloutType(draft.type) ? (
        <p className="rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-2 text-sm text-teal-950">
          {rolloutNodeDescription(engineCatalog)} {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
        </p>
      ) : null}
      {http ? (
        <details className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-teal-950">
            HTTP and notification constraints (fail closed)
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-teal-950">
            {HTTP_NOTIFICATION_NODE_POLICY_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-teal-950">
            TLS required={String(httpPolicy.tlsRequired)}. Redirects default{" "}
            {httpPolicy.allowRedirectsDefault ? "allowed" : "denied"}. Resolve
            then allowlist={String(httpPolicy.resolveThenAllowlist)}; dial
            verified address only=
            {String(httpPolicy.connectVerifiedAddressOnly)}. Max request{" "}
            {httpPolicy.maxRequestBytes} B / response {httpPolicy.maxResponseBytes}{" "}
            B. {httpPolicy.note} {HTTP_REDACTION_HELP}
          </p>
          {httpNotificationErrorShapes(httpCatalog).length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-teal-950">
              {httpNotificationErrorShapes(httpCatalog).slice(0, 8).map((item) => (
                <li key={item.code}>
                  <code className="font-mono">{item.code}</code> ({item.status}):{" "}
                  {item.meaning}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
      {script ? (
        <details className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-teal-950">
            Script publish boundary (server-enforced)
          </summary>
          <div className="mt-3">
            <ScriptIsolationNotes
              map={runtimeProfileMapFromCatalog(scriptCatalog)}
              extraNotes={[SCRIPT_RUNTIME_ISOLATION_HELP]}
            />
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-teal-950">
            {SCRIPT_NODE_POLICY_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-teal-950">
            {SCRIPT_PUBLISH_BOUNDARY_HELP} {SCRIPT_DRAFT_NOT_EXECUTABLE_HELP}{" "}
            {SCRIPT_MUTABLE_REJECT_HELP} {SCRIPT_EXECUTE_FAIL_CLOSED_HELP}{" "}
            Required: {scriptPublishRules(scriptCatalog).requiredWith.join(", ")}.
            Source cap {scriptPublishRules(scriptCatalog).maxSourceBytes} bytes.
          </p>
          {scriptNodeErrorShapes(scriptCatalog).length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-teal-950">
              {scriptNodeErrorShapes(scriptCatalog).slice(0, 8).map((item) => (
                <li key={item.code}>
                  <code className="font-mono">{item.code}</code> ({item.status}):{" "}
                  {item.meaning}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
      {ssh ? (
        <details className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-teal-950">
            SSH execution constraints (server-enforced)
          </summary>
          <div className="mt-3">
            <SshSafetyNotes
              catalog={sshEngineCatalog}
              extraNotes={SSH_NODE_POLICY_NOTES}
            />
          </div>
          <p className="mt-3 text-sm text-teal-950">
            {sshRetryPolicyHint({
              profileRetrySafe,
              verificationDeclared,
              maxAttempts: sshRetryRules(sshCatalog).defaultMaxAttempts,
            })}{" "}
            {SSH_INDETERMINATE_HELP}
          </p>
          {sshNodeErrorShapes(sshCatalog).length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-teal-950">
              {sshNodeErrorShapes(sshCatalog).slice(0, 8).map((item) => (
                <li key={item.code}>
                  <code className="font-mono">{item.code}</code> ({item.status}):{" "}
                  {item.meaning}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
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
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-teal-950">
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
        <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
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
      {ssh ? (
        <SshParameterFields
          constraints={parameterConstraints}
          value={
            draft.with.parameters && typeof draft.with.parameters === "object"
              ? (draft.with.parameters as Record<string, unknown>)
              : {}
          }
          onChange={(parameters) => patchWith("parameters", parameters)}
        />
      ) : null}
      {script ? (
        <ScriptIoFields
          inputSchema={draft.with.inputSchema}
          outputSchema={draft.with.outputSchema}
          catalog={parseScriptIoCatalog(scriptCatalog)}
          onChange={(patch) =>
            onChange({
              ...draft,
              with: { ...draft.with, ...patch },
            })
          }
        />
      ) : null}
      {script ? (
        <ScriptRetryFields
          retrySafe={draft.with.retrySafe}
          idempotencyKey={draft.with.idempotencyKey}
          verification={draft.with.verification}
          retryPolicy={draft.with.retryPolicy ?? defaultScriptIoRetryPolicy()}
          catalog={parseScriptIoCatalog(scriptCatalog)}
          onChange={(patch) =>
            onChange({
              ...draft,
              with: {
                ...draft.with,
                retrySafe: patch.retrySafe === true ? true : undefined,
                idempotencyKey: patch.idempotencyKey || undefined,
                verification: patch.verification,
                retryPolicy: patch.retryPolicy ?? defaultScriptIoRetryPolicy(),
              },
            })
          }
        />
      ) : null}
      {ssh ? (
        <SshRetryPolicyFields
          profileRetrySafe={profileRetrySafe}
          verificationDeclared={verificationDeclared}
          value={
            draft.with.retryPolicy && typeof draft.with.retryPolicy === "object"
              ? (draft.with.retryPolicy as { maxAttempts?: unknown })
              : defaultSshRetryPolicy()
          }
          onChange={(retryPolicy) => patchWith("retryPolicy", retryPolicy)}
        />
      ) : null}
      {advanced.length > 0 ? (
        <details className="rounded-xl border border-border px-4 py-3">
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
        ? stringifyWizardValue(field.defaultValue ?? KUBERNETES_FIELD_MANAGER)
        : ""
      : stringifyWizardValue(value);
  const label = field.label || field.name;
  const hintClassName = "mt-1 block text-xs text-muted-foreground";
  const controlClass =
    "mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm";
  if (field.readOnly) {
    return (
      <Field
        id={`wizard-config-${field.name}`}
        label={label}
        hint={
          field.description ||
          "Service-owned. FieldManager is flowforge and Force=false."
        }
        hintClassName={hintClassName}
      >
        <input
          value={text}
          readOnly
          disabled
          className={`${controlClass} bg-background`}
        />
      </Field>
    );
  }
  if (field.name === "namespace" && allowedNamespaces && allowedNamespaces.length > 0) {
    return (
      <Field
        id={`wizard-config-${field.name}`}
        label={label}
        hint="Allowlisted on the selected cluster target. Empty allowlists fail closed."
        hintClassName={hintClassName}
      >
        <select
          value={text}
          onChange={(event) => onChange(event.target.value)}
          className={controlClass}
        >
          <option value="">Select an allowed namespace</option>
          {allowedNamespaces.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (field.control === "enum") {
    return (
      <Field
        id={`wizard-config-${field.name}`}
        label={label}
        hint={field.description}
        hintClassName={hintClassName}
      >
        <select
          value={text}
          onChange={(event) => onChange(event.target.value)}
          className={controlClass}
        >
          {(field.enumValues ?? []).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (field.control === "textarea" || field.control === "object-lines") {
    return (
      <Field
        id={`wizard-config-${field.name}`}
        label={label}
        hint={field.description}
        hintClassName={hintClassName}
      >
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
          rows={field.name === "manifests" || field.name === "source" ? 12 : 6}
          className={`${controlClass} font-mono`}
        />
      </Field>
    );
  }
  if (field.control === "number") {
    return (
      <Field
        id={`wizard-config-${field.name}`}
        label={label}
        hint={field.description}
        hintClassName={hintClassName}
      >
        <input
          type="number"
          value={text}
          onChange={(event) => onChange(Number(event.target.value))}
          className={controlClass}
        />
      </Field>
    );
  }
  return (
    <Field
      id={`wizard-config-${field.name}`}
      label={label}
      hint={field.description}
      hintClassName={hintClassName}
    >
      <input
        value={text}
        onChange={(event) => onChange(event.target.value)}
        className={controlClass}
      />
    </Field>
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
      <p className="text-sm text-muted-foreground">
        Map upstream typed outputs onto this action&apos;s inputs. Sensitive
        preview values are redacted.
      </p>
      {inputs.length === 0 ? (
        <p className="text-sm text-muted-foreground">This action has no input ports.</p>
      ) : (
        inputs.map((port) => {
          const options = compatibleUpstreamOutputs(nodes, catalog, entries, port);
          const current = draft.mappings.find((item) => item.toPort === port.name)?.from ?? "";
          return (
            <Field
              key={port.name}
              id={`action-wizard-map-${port.name}`}
              label={
                <>
                  {port.name}{" "}
                  <span className="font-mono text-xs text-muted-foreground">({port.kind})</span>
                </>
              }
            >
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
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
              >
                <option value="">No mapping</option>
                {options.map((option) => (
                  <option key={option.from} value={option.from}>
                    {option.nodeName} · {option.from}
                  </option>
                ))}
              </select>
            </Field>
          );
        })
      )}
      {draft.mappings.length > 0 ? (
        <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs text-foreground">
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
  sshCatalog,
  scriptCatalog,
  httpCatalog,
  profileRetrySafe,
  verificationDeclared,
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
  sshCatalog: SshNodeCatalog | null;
  scriptCatalog: ScriptNodeCatalog | null;
  httpCatalog: HttpNotificationCatalog | null;
  profileRetrySafe: boolean;
  verificationDeclared: boolean;
}) {
  const errors = [...validation.errors, ...localErrors];
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="inline text-muted-foreground">Type </dt>
          <dd className="inline font-mono text-xs">{draft.type || "—"}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Name </dt>
          <dd className="inline">{draft.name || "—"}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Credential </dt>
          <dd className="inline">{draft.credentialDisplayName || "bound via target"}</dd>
        </div>
      </dl>
      <section className="rounded-xl border border-border px-4 py-3">
        <h3 className="text-sm font-semibold">Policy impact</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Permissions: {policy.permissions.join(", ") || "—"}. {policy.retryHint}{" "}
          {policy.approvalHint}
        </p>
        {policy.catalogSource === "inferred" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Policy metadata inferred from the catalog stub. Richer{" "}
            <code className="font-mono">allowedWith</code> / policy is a jonny
            follow-up.
          </p>
        ) : null}
        {draft.type.startsWith("kubernetes.") ? (
          <p className="mt-2 text-xs text-muted-foreground">
            SSA FieldManager={applyRules.fieldManager} Force={String(applyRules.force)}.
            Server dry-run always runs before persist. wait=ready →{" "}
            {effectiveWaitReady(engineCatalog)} (observable kinds only;
            others observation=skipped). {KUBERNETES_ROLLOUT_NO_MUTATION_MESSAGE}
            {engineErrors.some((item) => item.code === "ownership-conflict")
              ? " Ownership conflicts return 409; force is never applied."
              : ""}
          </p>
        ) : null}
        {isSshConfigurableType(draft.type) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            ssh.run uses an ephemeral key handle (no privateKey on the wire),
            known-host fingerprint match, and every resolved IP must be in
            allowedAddresses — the worker dials only that verified address.
            Key-only, non-root, no forwarding/proxy/interactive shell.{" "}
            {sshRetryPolicyHint({
              profileRetrySafe,
              verificationDeclared,
              maxAttempts: sshRetryRules(sshCatalog).defaultMaxAttempts,
            })}{" "}
            {SSH_INDETERMINATE_HELP} YAML holds target/profile UUIDs and typed
            values only.
          </p>
        ) : null}
        {isHttpConfigurableType(draft.type) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            HTTP and notification actions pin authorized ops-config resources
            only. YAML stores resource UUIDs
            {draft.type === "http.request"
              ? " (required connectionId; optional method, path, host, timeoutSeconds, responseSchemaRef, policyId)"
              : draft.type === "notification.email"
                ? " (connectionId, recipientListId, templateId; optional policyId)"
                : " (required connectionId; optional path, host, timeoutSeconds, idempotencyKey, policyId)"}
            — never a URL, headers, destination, credential, or TLS-off flag.
            Delivery results are redacted. Map{" "}
            <code className="font-mono">{HTTP_NOTIFICATION_ROUTE_MAP_SOURCE}</code>
            {httpCatalog?.source ? `; ${httpCatalog.source}` : ""}.{" "}
            {HTTP_REDACTION_HELP}
          </p>
        ) : null}
        {isScriptConfigurableType(draft.type) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {SCRIPT_PUBLISH_BOUNDARY_HELP} {SCRIPT_DRAFT_NOT_EXECUTABLE_HELP}{" "}
            {SCRIPT_MUTABLE_REJECT_HELP} {SCRIPT_EXECUTE_FAIL_CLOSED_HELP}{" "}
            {SCRIPT_RUNTIME_ISOLATION_HELP} YAML
            stores source, entrypoint, runtimeProfileId, timeoutSeconds,
            optional limits/schemas, and retrySafe / idempotencyKey /
            verification / retryPolicy — never secrets, env, command/shell, or
            package/storageRef.{" "}
            {scriptIoRetryPolicyHint({
              retrySafe: draft.with.retrySafe === true,
              idempotencyKeyDeclared: Boolean(String(draft.with.idempotencyKey ?? "").trim()),
              verificationDeclared:
                draft.with.verification !== undefined && draft.with.verification !== null,
              maxAttempts:
                draft.with.retryPolicy && typeof draft.with.retryPolicy === "object"
                  ? Number((draft.with.retryPolicy as { maxAttempts?: unknown }).maxAttempts)
                  : 0,
            })}{" "}
            {SCRIPT_IO_INDETERMINATE_HELP} I/O + recovery map #101 (
            <code className="font-mono">{SCRIPT_IO_ROUTE_MAP_SOURCE}</code>
            {scriptCatalog?.source ? `; ${scriptCatalog.source}` : ""}). Publish
            map #97 (<code className="font-mono">{SCRIPT_ROUTE_MAP_SOURCE}</code>).
          </p>
        ) : null}
      </section>
      <PreRunPolicyReview
        evaluation={evaluation}
        pending={evaluationPending}
        problem={evaluationProblem}
      />
      {parseSshEvaluateRetry(evaluation).map((item) => (
        <p
          key={`${item.nodeId}-${item.operation}`}
          className="text-xs text-muted-foreground"
        >
          Evaluate {item.operation}
          {item.nodeId ? ` (${item.nodeId})` : ""}: retryAllowed=
          {String(item.retryAllowed)}, retrySafe={String(item.retrySafe)},
          verificationDeclared={String(item.verificationDeclared)},
          retryMaxAttempts={item.retryMaxAttempts}. POST …/retry is 409
          retry-denied when closed.
        </p>
      ))}
      {parseScriptEvaluateRetry(evaluation).map((item) => (
        <p
          key={`script-${item.nodeId}-${item.operation}`}
          className="text-xs text-muted-foreground"
        >
          Evaluate {item.operation}
          {item.nodeId ? ` (${item.nodeId})` : ""}: retryAllowed=
          {String(item.retryAllowed)}, retrySafe={String(item.retrySafe)},
          verificationDeclared={String(item.verificationDeclared)},
          retryMaxAttempts={item.retryMaxAttempts}. POST …/retry is 409
          retry-denied when closed.
        </p>
      ))}
      <section className="rounded-xl border border-border px-4 py-3">
        <h3 className="text-sm font-semibold">Redacted YAML preview</h3>
        <pre className="mt-2 overflow-auto font-mono text-xs text-foreground">{preview}</pre>
      </section>
      {errors.length > 0 ? (
        <ul className="space-y-1 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Validation passed. Add writes this node into the draft YAML.</p>
      )}
    </div>
  );
}

function SshRetryPolicyFields({
  profileRetrySafe,
  verificationDeclared,
  value,
  onChange,
}: {
  profileRetrySafe: boolean;
  verificationDeclared: boolean;
  value: { maxAttempts?: unknown };
  onChange: (value: { maxAttempts: number }) => void;
}) {
  const parsed = validateSshRetryPolicy({
    maxAttempts: value.maxAttempts,
    profileRetrySafe,
    verificationDeclared,
  });
  const maxAttempts =
    typeof value.maxAttempts === "number"
      ? value.maxAttempts
      : SSH_DEFAULT_RETRY_MAX_ATTEMPTS;
  return (
    <fieldset className="space-y-3 rounded-xl border border-border px-4 py-3">
      <legend className="px-1 text-sm font-medium">Retry policy</legend>
      <p className="text-xs text-muted-foreground">
        {SSH_RETRY_ZERO_MESSAGE} This control never auto-retries. Lease loss
        stays indeterminate until verification — there is no blind-retry
        button.
      </p>
      <Field
        id="wizard-ssh-max-attempts"
        label="maxAttempts"
        hint={`Default ${SSH_DEFAULT_RETRY_MAX_ATTEMPTS}. Allowed range ${SSH_DEFAULT_RETRY_MAX_ATTEMPTS}–${SSH_MAX_RETRY_ATTEMPTS}. Values above 0 require a retrySafe profile with a declared verification probe.`}
        hintClassName="mt-1 block text-xs text-muted-foreground"
        error={
          parsed.errors.length > 0
            ? parsed.errors[0] || SSH_RETRY_DENIED_MESSAGE
            : undefined
        }
        errorClassName="mt-1 block text-sm text-warning-foreground"
      >
        <input
          type="number"
          min={SSH_DEFAULT_RETRY_MAX_ATTEMPTS}
          max={SSH_MAX_RETRY_ATTEMPTS}
          value={Number.isInteger(maxAttempts) ? maxAttempts : SSH_DEFAULT_RETRY_MAX_ATTEMPTS}
          onChange={(event) =>
            onChange({
              maxAttempts: Number(event.target.value) || SSH_DEFAULT_RETRY_MAX_ATTEMPTS,
            })
          }
          className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
        />
      </Field>
      <p className="text-sm text-foreground">
        Selected profile retrySafe is {profileRetrySafe ? "true" : "false"};
        verification is {verificationDeclared ? "declared" : "missing"}.
      </p>
      {parsed.errors.length > 0 ? null : parsed.warnings.length > 0 ? (
        <p className="text-sm text-foreground">{parsed.warnings[0]}</p>
      ) : null}
    </fieldset>
  );
}

function SshParameterFields({
  constraints,
  value,
  onChange,
}: {
  constraints: readonly SshParameterConstraint[];
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  function patch(name: string, next: unknown) {
    const copy = { ...value };
    if (next === "" || next === undefined) {
      delete copy[name];
    } else {
      copy[name] = next;
    }
    onChange(copy);
  }
  if (constraints.length === 0) {
    return (
      <Field
        id="wizard-ssh-parameters"
        label="Parameters"
        hint="Typed profile parameters as key=value lines after a profile is selected. No raw shell, interpolation tokens, keys, or passwords."
        hintClassName="mt-1 block text-xs text-muted-foreground"
      >
        <textarea
          value={Object.entries(value)
            .map(([key, nested]) => `${key}=${String(nested)}`)
            .join("\n")}
          onChange={(event) => {
            const next: Record<string, string> = {};
            for (const line of event.target.value.split("\n")) {
              const cut = line.indexOf("=");
              if (cut <= 0) {
                continue;
              }
              next[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
            }
            onChange(next);
          }}
          rows={6}
          className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-sm"
        />
      </Field>
    );
  }
  return (
    <fieldset className="space-y-3 rounded-xl border border-border px-4 py-3">
      <legend className="px-1 text-sm font-medium">Typed profile parameters</legend>
      <p className="text-xs text-muted-foreground">
        Values are constrained by the selected command profile. The reviewed
        renderer owns quoting. This is not a free-form shell.
      </p>
      {constraints.map((constraint) => {
        const current = value[constraint.name];
        const text = current == null ? "" : String(current);
        if (constraint.enum?.length) {
          return (
            <Field
              key={constraint.name}
              id={`wizard-ssh-param-${constraint.name}`}
              label={`${constraint.name}${constraint.required ? " *" : ""}`}
              hint={constraint.description}
              hintClassName="mt-1 block text-xs text-muted-foreground"
              required={constraint.required}
            >
              <select
                value={text}
                onChange={(event) => patch(constraint.name, event.target.value)}
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
              >
                <option value="">Select {constraint.name}</option>
                {constraint.enum.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
          );
        }
        if (constraint.type === "boolean") {
          return (
            <Field
              key={constraint.name}
              id={`wizard-ssh-param-${constraint.name}`}
              label={`${constraint.name}${constraint.required ? " *" : ""}`}
              hint={constraint.description}
              hintClassName="text-xs text-muted-foreground"
              className="flex items-center gap-2 text-sm"
              controlPlacement="before-label"
              required={constraint.required}
            >
              <input
                type="checkbox"
                checked={current === true || current === "true"}
                onChange={(event) => patch(constraint.name, event.target.checked)}
              />
            </Field>
          );
        }
        return (
          <Field
            key={constraint.name}
            id={`wizard-ssh-param-${constraint.name}`}
            label={`${constraint.name}${constraint.required ? " *" : ""}`}
            hint={`${
              constraint.description ||
              `${constraint.type} parameter. No shell interpolation.`
            }${
              constraint.sensitive
                ? " Marked sensitive on the profile — redacted in audit, still a typed YAML value (not a vault secret)."
                : ""
            }`}
            hintClassName="mt-1 block text-xs text-muted-foreground"
            required={constraint.required}
          >
            <input
              type={constraint.type === "integer" ? "number" : "text"}
              value={text}
              onChange={(event) =>
                patch(
                  constraint.name,
                  constraint.type === "integer"
                    ? event.target.value === ""
                      ? ""
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
            />
          </Field>
        );
      })}
    </fieldset>
  );
}

function stringifyWizardValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function entryName(entries: ActionLibraryEntry[], type?: string): string {
  if (!type) {
    return "";
  }
  return entries.find((item) => item.type === type)?.name ?? type;
}
