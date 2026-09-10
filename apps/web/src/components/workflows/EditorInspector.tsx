"use client";

import { LastRunIoPanel } from "@/components/workflows/LastRunIoPanel";
import { NodeInspector } from "@/components/workflows/NodeInspector";
import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import { HttpNotificationPinsPanel } from "@/components/config/HttpNotificationPinSelect";
import { KubernetesTargetSelect } from "@/components/config/KubernetesTargetSelect";
import { SshPinsPanel } from "@/components/config/SshPinSelect";
import { ScriptAuthoringPanel } from "@/components/workflows/ScriptAuthoringPanel";
import { isHttpConfigurableType } from "@/lib/core-http-notification-contract";
import type { HttpNotificationCatalog } from "@/lib/core-http-notification-contract";
import type { EditorSelection } from "@/components/workflows/WorkflowCanvas";
import { isKubernetesActionType } from "@/lib/kubernetes";
import type { KubernetesEngineCatalog } from "@/lib/kubernetes-types";
import {
  isScriptConfigurableType,
  type ScriptArtifact,
  type ScriptNodeCatalog,
  type ScriptVersionPin,
} from "@/lib/script-contract";
import { isSshConfigurableType } from "@/lib/ssh-node-contract";
import type { SshNodeCatalog } from "@/lib/ssh-node-contract";
import type { ActionLibraryEntry } from "@/lib/workflow-action-library";
import {
  formatBounds,
  formatPolicy,
  formatPort,
  formatRedaction,
  isCoreNeutralNodeType,
  type CoreNeutralPaletteEntry,
} from "@/lib/workflow-core-nodes";
import type { WorkflowGraph } from "@/lib/workflow-graph";
import type { DevIdentity } from "@/lib/identity-headers";
import type { CoreNodeWith, YamlWorkflowNode } from "@/lib/workflow-yaml-nodes";
import { listYamlTriggers, readYamlWorkflowMeta } from "@/lib/workflow-yaml-nodes";
import { wizardConfigFields, type WizardConfigField } from "@/lib/workflow-action-wizard";
import {
  EDITOR_INSPECTOR,
  INSPECTOR_METADATA_ONLY_HELP,
  INSPECTOR_NO_SECRET_SURFACE_HELP,
  canEditInspector,
  inspectorCredentialFields,
  inspectorCredentialRefValue,
  inspectorCredentialTypes,
  inspectorEditConstraint,
  inspectorFocus,
  inspectorWithFields,
  isInspectorSecretSurfaceName,
} from "@/lib/editor-inspector";
import {
  editorPathForWorkflow,
  inspectorAddCredentialHref,
  vaultHomeHref,
  type InspectorAddCredentialRequest,
  type InspectorPendingCredential,
} from "@/lib/editor-credential";
import {
  EditorWorkflowTabs,
  type WorkflowInspectorAdmin,
} from "@/components/workflows/EditorWorkflowTabs";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { latestStepsByNode } from "@/lib/execution-replay";
import type { ExecutionDetail, ExecutionLogSlice } from "@/lib/execution-types";
import type { ProblemDetails } from "@/lib/problem";
import Link from "next/link";

export type EditorLastRunOverlay = {
  detail: ExecutionDetail | null;
  logsByStepId?: Readonly<Record<string, ExecutionLogSlice>>;
  pending?: boolean;
  problem?: ProblemDetails | null;
  strippedKeys?: readonly string[];
  onClear?: () => void;
};

type EditorInspectorProps = {
  yaml: string;
  graph: WorkflowGraph | null;
  nodes: YamlWorkflowNode[];
  entries: ActionLibraryEntry[];
  selection: EditorSelection;
  pending: boolean;
  identity: DevIdentity;
  canCall: boolean;
  dirty?: boolean;
  hasPublishedVersion?: boolean;
  scriptCatalog?: ScriptNodeCatalog | null;
  engineCatalog?: KubernetesEngineCatalog | null;
  sshCatalog?: SshNodeCatalog | null;
  httpCatalog?: HttpNotificationCatalog | null;
  scriptArtifacts?: readonly ScriptVersionPin[] | null;
  scriptArtifactRecords?: readonly ScriptArtifact[] | null;
  permissions?: readonly string[] | null;
  onScriptArtifactChange?: (artifact: ScriptArtifact) => void;
  onSelectNode: (id: string) => void;
  onApply: (id: string, name: string, config: CoreNodeWith) => string[];
  onRename?: (id: string, name: string) => void;
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
  workflowId?: string;
  credentialRefreshNonce?: number;
  pendingCredentials?: Readonly<Record<string, InspectorPendingCredential>>;
  onAddCredential?: (request: InspectorAddCredentialRequest) => void;
  workflowAdmin?: WorkflowInspectorAdmin;
  lastRun?: EditorLastRunOverlay | null;
};

export function EditorInspector({
  yaml,
  graph,
  nodes,
  entries,
  selection,
  pending,
  identity,
  canCall,
  dirty,
  hasPublishedVersion,
  scriptCatalog,
  engineCatalog,
  sshCatalog,
  httpCatalog,
  scriptArtifacts,
  scriptArtifactRecords,
  permissions,
  onScriptArtifactChange,
  onSelectNode,
  onApply,
  onRename,
  onPatchNodeWith,
  workflowId,
  credentialRefreshNonce,
  pendingCredentials,
  onAddCredential,
  workflowAdmin,
  lastRun,
}: EditorInspectorProps) {
  const focus = inspectorFocus(selection);
  const selectedNodeId = selection.kind === "node" ? selection.id : null;
  const selectedNode = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const selectedEntry = selectedNode
    ? entries.find((item) => item.type === selectedNode.type)
    : undefined;
  const palette = entries.filter((entry) =>
    isCoreNeutralNodeType(entry.type),
  ) as CoreNeutralPaletteEntry[];
  const canEdit = canEditInspector(permissions, canCall);
  const constraint = inspectorEditConstraint(permissions, canCall);
  const selectedStepId =
    selectedNodeId && lastRun?.detail
      ? latestStepsByNode(lastRun.detail.steps).get(selectedNodeId)?.id
      : undefined;
  const lastRunPanel = lastRun && (lastRun.detail || lastRun.pending || lastRun.problem) ? (
    <LastRunIoPanel
      detail={lastRun.detail}
      nodeId={selectedNodeId}
      logs={selectedStepId ? lastRun.logsByStepId?.[selectedStepId] : null}
      pending={lastRun.pending}
      problem={lastRun.problem}
      strippedKeys={lastRun.strippedKeys}
      onClear={lastRun.onClear}
    />
  ) : null;

  return (
    <div className="space-y-6">
      {lastRunPanel}
      {focus === "workflow" ? (
        <>
          <WorkflowInspect yaml={yaml} graph={graph} />
          {workflowAdmin ? (
            <EditorWorkflowTabs
              identity={identity}
              canCall={canCall}
              yaml={yaml}
              {...workflowAdmin}
            />
          ) : null}
        </>
      ) : null}
      {focus === "edge" && selection.kind === "edge" ? (
        <EdgeInspect graph={graph} from={selection.from} to={selection.to} entries={entries} />
      ) : null}
      {focus === "node" && selectedNode ? (
        <>
          <NodeInspector
            nodes={nodes}
            selectedId={selectedNode.id}
            entries={palette}
            selectedEntry={selectedEntry}
            pending={pending}
            canEdit={canEdit}
            constraint={constraint}
            showNodeList={false}
            onSelect={onSelectNode}
            onApply={onApply}
            onRename={onRename}
          />
          {isScriptConfigurableType(selectedNode.type) ? (
            <ScriptAuthoringPanel
              node={selectedNode}
              identity={identity}
              ready={canCall}
              dirty={dirty}
              hasPublishedVersion={hasPublishedVersion}
              scriptCatalog={scriptCatalog}
              scriptArtifacts={scriptArtifacts}
              artifacts={scriptArtifactRecords}
              permissions={permissions}
              onArtifactChange={onScriptArtifactChange}
              onPatchNodeWith={canEdit ? onPatchNodeWith : undefined}
            />
          ) : null}
          <SelectedNodePins
            node={selectedNode}
            entry={selectedEntry}
            identity={identity}
            canCall={canCall}
            canEdit={canEdit}
            constraint={constraint}
            engineCatalog={engineCatalog}
            sshCatalog={sshCatalog}
            scriptCatalog={scriptCatalog}
            httpCatalog={httpCatalog}
            workflowId={workflowId}
            credentialRefreshNonce={credentialRefreshNonce}
            pendingCredentials={pendingCredentials}
            onAddCredential={canEdit ? onAddCredential : undefined}
            onPatchNodeWith={canEdit ? onPatchNodeWith : undefined}
          />
        </>
      ) : null}
    </div>
  );
}

function WorkflowInspect({
  yaml,
  graph,
}: {
  yaml: string;
  graph: WorkflowGraph | null;
}) {
  const meta = readYamlWorkflowMeta(yaml);
  const triggers = listYamlTriggers(yaml);
  return (
    <section
      aria-labelledby="workflow-inspect-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="workflow-inspect-heading" className="text-base font-semibold">
        Workflow
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Triggers are workflow-level. They are not canvas nodes.
      </p>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-zinc-500">Name</dt>
          <dd className="font-medium">{graph?.name || meta.name || "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Description</dt>
          <dd>{graph?.description || meta.description || "—"}</dd>
        </div>
      </dl>
      <ul className="mt-3 space-y-1 font-mono text-xs text-zinc-600">
        {triggers.map((trigger) => (
          <li key={trigger.id}>
            {trigger.id} · {trigger.type}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EdgeInspect({
  graph,
  from,
  to,
  entries,
}: {
  graph: WorkflowGraph | null;
  from: string;
  to: string;
  entries: ActionLibraryEntry[];
}) {
  const edge = graph?.edges.find((item) => item.from === from && item.to === to);
  const fromNode = graph?.nodes.find((node) => node.id === edge?.fromRef.nodeId);
  const toNode = graph?.nodes.find((node) => node.id === edge?.toRef.nodeId);
  const fromEntry = entries.find((entry) => entry.type === fromNode?.type);
  const toEntry = entries.find((entry) => entry.type === toNode?.type);
  return (
    <section
      aria-labelledby="edge-inspect-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="edge-inspect-heading" className="text-base font-semibold">
        Edge
      </h2>
      <p className="mt-2 font-mono text-xs text-zinc-700">
        {from} → {to}
      </p>
      <p className="mt-2 text-sm text-zinc-700">
        {edge?.compatible
          ? "Ports are compatible."
          : edge?.reason || "Port compatibility could not be confirmed."}
      </p>
      {fromEntry || toEntry ? (
        <div className="mt-3 space-y-2 text-xs text-zinc-600">
          {fromEntry ? (
            <p>
              from {fromEntry.name}:{" "}
              {(fromEntry.outputs ?? []).map((port) => formatPort(port, "out")).join(" · ")}
            </p>
          ) : null}
          {toEntry ? (
            <p>
              to {toEntry.name}:{" "}
              {(toEntry.inputs ?? []).map((port) => formatPort(port, "in")).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SelectedNodePins({
  node,
  entry,
  identity,
  canCall,
  canEdit,
  constraint,
  engineCatalog,
  sshCatalog,
  scriptCatalog,
  httpCatalog,
  workflowId,
  credentialRefreshNonce,
  pendingCredentials,
  onAddCredential,
  onPatchNodeWith,
}: {
  node: YamlWorkflowNode;
  entry?: ActionLibraryEntry;
  identity: DevIdentity;
  canCall: boolean;
  canEdit: boolean;
  constraint: string | null;
  engineCatalog?: KubernetesEngineCatalog | null;
  sshCatalog?: SshNodeCatalog | null;
  scriptCatalog?: ScriptNodeCatalog | null;
  httpCatalog?: HttpNotificationCatalog | null;
  workflowId?: string;
  credentialRefreshNonce?: number;
  pendingCredentials?: Readonly<Record<string, InspectorPendingCredential>>;
  onAddCredential?: (request: InspectorAddCredentialRequest) => void;
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
}) {
  const embed = useEmbedMode();
  const credentialFields = inspectorCredentialFields(entry, node.type);
  const withFields =
    inspectorShowsScriptOwnedField(node.type) ||
    inspectorShowsCoreOwnedField(node.type)
      ? []
      : inspectorWithFields(
          wizardConfigFields(
            entry,
            node.type,
            engineCatalog,
            sshCatalog,
            scriptCatalog,
            httpCatalog,
          ),
          node.type,
        );
  const showPins =
    isKubernetesActionType(node.type) ||
    isSshConfigurableType(node.type) ||
    isHttpConfigurableType(node.type) ||
    credentialFields.length > 0 ||
    withFields.length > 0;

  if (!showPins) {
    return null;
  }

  const clusterTargetId =
    typeof node.with.clusterTargetId === "string"
      ? String(node.with.clusterTargetId)
      : "";

  return (
    <section
      aria-labelledby="node-pins-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="node-pins-heading" className="text-base font-semibold">
        Pins and credentials
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Inspector is <span className="font-medium">edit</span>. Add action stays
        the guided wizard ({EDITOR_INSPECTOR.wizardSteps.join(" → ")}).{" "}
        {INSPECTOR_METADATA_ONLY_HELP} {INSPECTOR_NO_SECRET_SURFACE_HELP}
      </p>
      {constraint ? (
        <p role="status" className="mt-2 text-sm text-amber-950">
          {constraint}
        </p>
      ) : null}
      {entry ? (
        <div className="mt-3 space-y-1 font-mono text-xs text-zinc-500">
          <p>
            {[
              ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
              ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
            ].join(" · ") || "no ports"}
          </p>
          {formatPolicy(entry.policy) ? <p>policy: {formatPolicy(entry.policy)}</p> : null}
          {formatBounds(entry.bounds) ? <p>bounds: {formatBounds(entry.bounds)}</p> : null}
          {formatRedaction(entry.redaction) ? (
            <p>redaction: {formatRedaction(entry.redaction)}</p>
          ) : null}
        </div>
      ) : null}
      {withFields.length > 0 ? (
        <div className="mt-3 space-y-3">
          {withFields.map((field) => (
            <InspectorWithField
              key={field.name}
              field={field}
              value={node.with[field.name]}
              disabled={!canEdit || !onPatchNodeWith}
              onChange={(value) => onPatchNodeWith?.(node.id, { [field.name]: value })}
            />
          ))}
        </div>
      ) : null}
      {isKubernetesActionType(node.type) ? (
        <div className="mt-3">
          <KubernetesTargetSelect
            identity={identity}
            ready={canCall}
            value={clusterTargetId}
            disabled={!canEdit || !onPatchNodeWith}
            onChange={(pin) =>
              onPatchNodeWith?.(node.id, {
                clusterTargetId: pin?.resourceId ?? "",
              })
            }
          />
          <p className="mt-1 text-xs text-zinc-500">
            Authorized published cluster targets only. Display name and
            version — never kubeconfig.
            {node.type === "kubernetes.rolloutStatus"
              ? " Timeout or cancel stops waiting; it never deletes or rolls back resources."
              : ""}
          </p>
        </div>
      ) : null}
      {isSshConfigurableType(node.type) ? (
        <div className="mt-3">
          <SshPinsPanel
            type={node.type}
            identity={identity}
            ready={canCall}
            values={node.with}
            disabled={!canEdit || !onPatchNodeWith}
            onPatch={(patch) => onPatchNodeWith?.(node.id, patch)}
          />
        </div>
      ) : null}
      {isHttpConfigurableType(node.type) ? (
        <div className="mt-3">
          <HttpNotificationPinsPanel
            type={node.type}
            identity={identity}
            ready={canCall}
            values={node.with}
            disabled={!canEdit || !onPatchNodeWith}
            onPatch={(patch) => onPatchNodeWith?.(node.id, patch)}
          />
        </div>
      ) : null}
      {credentialFields.map((fieldName) => {
        const editorPath = workflowId ? editorPathForWorkflow(workflowId, embed) : null;
        const returnTo =
          editorPath && workflowId
            ? {
                editorPath,
                workflowId,
                nodeId: node.id,
                field: fieldName,
              }
            : null;
        return (
        <div key={fieldName} className="mt-3">
          <p className="text-xs font-medium text-zinc-600">{fieldName}</p>
          <CredentialRefSelect
            identity={identity}
            ready={canCall}
            value={
              typeof node.with[fieldName] === "string"
                ? String(node.with[fieldName])
                : ""
            }
            disabled={!canEdit || !onPatchNodeWith}
            allowedTypes={inspectorCredentialTypes(node.type)}
            refreshNonce={credentialRefreshNonce}
            pendingItem={pendingCredentials?.[`${node.id}:${fieldName}`] ?? null}
            onChange={(credentialId) => {
              const ref = inspectorCredentialRefValue(credentialId);
              if (ref === null) {
                return;
              }
              onPatchNodeWith?.(node.id, { [fieldName]: ref });
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              disabled={!canEdit || !onAddCredential}
              onClick={() =>
                onAddCredential?.({
                  nodeId: node.id,
                  field: fieldName,
                  allowedTypes: inspectorCredentialTypes(node.type),
                })
              }
              className="text-sm font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:text-teal-950 disabled:text-zinc-400 disabled:no-underline"
            >
              Add credential
            </button>
            {returnTo ? (
              <Link
                href={inspectorAddCredentialHref(returnTo, embed)}
                className="text-xs text-zinc-600 underline decoration-zinc-200 underline-offset-2 hover:text-zinc-900"
              >
                Open /credentials/new
              </Link>
            ) : null}
            <Link
              href={vaultHomeHref(embed)}
              className="text-xs text-zinc-600 underline decoration-zinc-200 underline-offset-2 hover:text-zinc-900"
            >
              Vault home
            </Link>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Credentials are selected by display name only. YAML stores the
            workspace UUID; secret values are never shown. Add credential
            opens the existing masked wizard — not a secret field in this
            rail.
          </p>
        </div>
        );
      })}
    </section>
  );
}

function inspectorShowsScriptOwnedField(type: string): boolean {
  return isScriptConfigurableType(type);
}

function inspectorShowsCoreOwnedField(type: string): boolean {
  return isCoreNeutralNodeType(type);
}

function InspectorWithField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: WizardConfigField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  if (isInspectorSecretSurfaceName(field.name)) {
    return null;
  }
  const text =
    value == null || value === ""
      ? field.readOnly
        ? stringifyInspectorValue(field.defaultValue)
        : ""
      : stringifyInspectorValue(value);
  const label = field.label || field.name;
  if (field.readOnly || field.control === "boolean") {
    if (field.control === "boolean") {
      return (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled || field.readOnly}
            onChange={(event) => onChange(event.target.checked)}
          />
          {label}
        </label>
      );
    }
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">{label}</span>
        <input
          value={text}
          readOnly
          disabled
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm"
        />
      </label>
    );
  }
  if (field.control === "enum") {
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">{label}</span>
        <select
          value={text}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:bg-zinc-50"
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
  if (field.control === "textarea" || field.control === "object-lines" || field.control === "json") {
    return (
      <label className="block text-sm">
        <span className="text-zinc-600">{label}</span>
        <textarea
          value={
            field.control === "object-lines" && value && typeof value === "object"
              ? Object.entries(value as Record<string, unknown>)
                  .map(([key, nested]) => `${key}=${String(nested)}`)
                  .join("\n")
              : text
          }
          disabled={disabled}
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
          rows={field.name === "manifests" || field.name === "source" ? 8 : 4}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
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
        <span className="text-zinc-600">{label}</span>
        <input
          type="number"
          value={text}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:bg-zinc-50"
        />
        {field.description ? (
          <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
        ) : null}
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="text-zinc-600">{label}</span>
      <input
        value={text}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm disabled:bg-zinc-50"
      />
      {field.description ? (
        <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
      ) : null}
    </label>
  );
}

function stringifyInspectorValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
