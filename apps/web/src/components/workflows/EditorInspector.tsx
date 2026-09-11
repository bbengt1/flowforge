"use client";

import { LastRunIoPanel } from "@/components/workflows/LastRunIoPanel";
import { NdvMappingPanel } from "@/components/workflows/NdvMappingPanel";
import { NdvValidationPanel } from "@/components/workflows/NdvValidationPanel";
import { NodeInspector } from "@/components/workflows/NodeInspector";
import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import { HttpNotificationPinsPanel } from "@/components/config/HttpNotificationPinSelect";
import { KubernetesTargetSelect } from "@/components/config/KubernetesTargetSelect";
import { SshPinsPanel } from "@/components/config/SshPinSelect";
import { ScriptAuthoringPanel } from "@/components/workflows/ScriptAuthoringPanel";
import { isHttpConfigurableType } from "@/lib/core-http-notification-contract";
import type { HttpNotificationCatalog } from "@/lib/core-http-notification-contract";
import { selectedNodeIds, type EditorSelection } from "@/lib/editor-canvas-primitives";
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
import { listYamlEdges, listYamlTriggers, readYamlWorkflowMeta } from "@/lib/workflow-yaml-nodes";
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
} from "@/lib/editor-inspector";
import {
  EDITOR_NDV_HEADING_ID,
  EDITOR_NDV_SHELL_ID,
  ndvConversationEyebrow,
  ndvConversationHelp,
  ndvConversationTitle,
} from "@/lib/editor-ndv";
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
import {
  NDV_MAPPING_EDGE_PORT_ONLY_HELP,
  ndvDestAcceptsFieldPathMapping,
  ndvPortTypingIncomplete,
  suggestNdvFieldPaths,
} from "@/lib/editor-ndv-mapping";
import { latestStepsByNode } from "@/lib/execution-replay";
import type { ExecutionDetail, ExecutionLogSlice } from "@/lib/execution-types";
import type { ApprovalRequest, PolicyEvaluation } from "@/lib/approval-types";
import type { ProblemDetails } from "@/lib/problem";
import type { WorkflowCatalog, WorkflowFieldError } from "@/lib/workflow-types";
import type { NdvValidationStatus } from "@/lib/editor-ndv-validation";
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
  catalog?: WorkflowCatalog | null;
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
  onRewireInput?: (nodeId: string, toPort: string, from: string | null) => string[];
  workflowId?: string;
  credentialRefreshNonce?: number;
  pendingCredentials?: Readonly<Record<string, InspectorPendingCredential>>;
  onAddCredential?: (request: InspectorAddCredentialRequest) => void;
  workflowAdmin?: WorkflowInspectorAdmin;
  lastRun?: EditorLastRunOverlay | null;
  validation?: {
    status: NdvValidationStatus;
    errors: WorkflowFieldError[];
    warnings?: WorkflowFieldError[];
    problem?: ProblemDetails | null;
    evaluation?: PolicyEvaluation | null;
    evaluationPending?: boolean;
    evaluationProblem?: ProblemDetails | null;
    publishedVersionId?: string | null;
    waitingApprovals?: readonly ApprovalRequest[];
    onJumpYaml?: (line: number, column?: number) => void;
  };
};

export function EditorInspector({
  yaml,
  graph,
  nodes,
  entries,
  catalog,
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
  onRewireInput,
  workflowId,
  credentialRefreshNonce,
  pendingCredentials,
  onAddCredential,
  workflowAdmin,
  lastRun,
  validation,
}: EditorInspectorProps) {
  const focus = inspectorFocus(selection);
  const selectedNodeId = selection.kind === "node" ? selection.id : null;
  const selectedCount = selectedNodeIds(selection).length;
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
  const yamlEdges = listYamlEdges(yaml);
  const mappingNodeId =
    selectedNodeId ??
    (selection.kind === "edge"
      ? graph?.edges.find((item) => item.from === selection.from && item.to === selection.to)
          ?.toRef.nodeId ?? null
      : null);
  const lastRunSuggestions =
    lastRun?.detail && mappingNodeId
      ? suggestNdvFieldPaths(
          latestStepsByNode(lastRun.detail.steps).get(mappingNodeId)?.input ??
            latestStepsByNode(lastRun.detail.steps).get(mappingNodeId)?.output,
        )
      : [];
  const lastRunPanel = lastRun && (lastRun.detail || lastRun.pending || lastRun.problem) ? (
    <div data-ndv-panel="last-run">
      <LastRunIoPanel
        detail={lastRun.detail}
        nodeId={selectedNodeId}
        logs={selectedStepId ? lastRun.logsByStepId?.[selectedStepId] : null}
        pending={lastRun.pending}
        problem={lastRun.problem}
        strippedKeys={lastRun.strippedKeys}
        onClear={lastRun.onClear}
      />
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      {focus === "workflow" ? (
        <>
          {lastRunPanel}
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
        <>
          {lastRunPanel}
          <EdgeInspect
            graph={graph}
            from={selection.from}
            to={selection.to}
            entries={entries}
            catalog={catalog}
            nodes={nodes}
            edges={yamlEdges}
            canEdit={canEdit}
            pending={pending}
            onRewireInput={canEdit ? onRewireInput : undefined}
            onPatchNodeWith={canEdit ? onPatchNodeWith : undefined}
            suggestedFromPaths={lastRunSuggestions}
          />
        </>
      ) : null}
      {focus === "node" && selectedNode ? (
        <div
          id={EDITOR_NDV_SHELL_ID}
          data-ndv-shell="node"
          className="space-y-6"
        >
          <header className="border-b border-zinc-200 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {ndvConversationEyebrow("node")}
            </p>
            <h2 id={EDITOR_NDV_HEADING_ID} className="text-base font-semibold">
              {ndvConversationTitle("node", selectedNode)}
            </h2>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {selectedNode.id} · {selectedNode.type}
            </p>
            <p className="mt-2 text-sm text-zinc-600">
              {ndvConversationHelp("node")}
            </p>
            {selectedCount > 1 ? (
              <p className="mt-2 text-sm text-zinc-700" data-canvas-multiselect>
                {selectedCount} nodes selected. Inspector edits the last selected
                node. Shift+click or Shift+drag to adjust. Delete removes the
                selection.
              </p>
            ) : null}
          </header>
          {lastRunPanel}
          <div data-ndv-panel="parameters">
            <NodeInspector
              nodes={nodes}
              selectedId={selectedNode.id}
              entries={palette}
              selectedEntry={selectedEntry}
              pending={pending}
              canEdit={canEdit}
              constraint={constraint}
              showNodeList={false}
              engineCatalog={engineCatalog}
              sshCatalog={sshCatalog}
              scriptCatalog={scriptCatalog}
              httpCatalog={httpCatalog}
              onSelect={onSelectNode}
              onApply={onApply}
              onRename={onRename}
              onPatchNodeWith={canEdit ? onPatchNodeWith : undefined}
            />
            {isScriptConfigurableType(selectedNode.type) ? (
              <div className="mt-6">
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
              </div>
            ) : null}
          </div>
          <NdvMappingPanel
            node={selectedNode}
            nodes={nodes}
            edges={yamlEdges}
            entries={entries}
            catalog={catalog}
            canEdit={canEdit}
            pending={pending}
            suggestedFromPaths={lastRunSuggestions}
            onRewireInput={canEdit ? onRewireInput : undefined}
            onPatchMapping={
              canEdit
                ? (id, mapping) => onPatchNodeWith?.(id, { mapping })
                : undefined
            }
            onPatchPath={
              canEdit
                ? (id, path) => onPatchNodeWith?.(id, { path })
                : undefined
            }
          />
          {validation ? (
            <div data-ndv-panel="validation">
            <NdvValidationPanel
              nodeId={selectedNode.id}
              entry={selectedEntry}
              status={validation.status}
              errors={validation.errors}
              warnings={validation.warnings}
              nodes={nodes}
              edges={yamlEdges}
              problem={validation.problem}
              evaluation={validation.evaluation}
              evaluationPending={validation.evaluationPending}
              evaluationProblem={validation.evaluationProblem}
              publishedVersionId={validation.publishedVersionId}
              waitingApprovals={validation.waitingApprovals}
              onJumpYaml={validation.onJumpYaml}
            />
            </div>
          ) : null}
          <SelectedNodePins
            node={selectedNode}
            entry={selectedEntry}
            identity={identity}
            canCall={canCall}
            canEdit={canEdit}
            constraint={constraint}
            workflowId={workflowId}
            credentialRefreshNonce={credentialRefreshNonce}
            pendingCredentials={pendingCredentials}
            onAddCredential={canEdit ? onAddCredential : undefined}
            onPatchNodeWith={canEdit ? onPatchNodeWith : undefined}
          />
        </div>
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
  catalog,
  nodes,
  edges,
  canEdit,
  pending,
  onRewireInput,
  onPatchNodeWith,
  suggestedFromPaths,
}: {
  graph: WorkflowGraph | null;
  from: string;
  to: string;
  entries: ActionLibraryEntry[];
  catalog?: WorkflowCatalog | null;
  nodes: YamlWorkflowNode[];
  edges: { from: string; to: string }[];
  canEdit: boolean;
  pending: boolean;
  onRewireInput?: (nodeId: string, toPort: string, from: string | null) => string[];
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
  suggestedFromPaths: readonly string[];
}) {
  const edge = graph?.edges.find((item) => item.from === from && item.to === to);
  const fromNode = graph?.nodes.find((node) => node.id === edge?.fromRef.nodeId);
  const toGraphNode = graph?.nodes.find((node) => node.id === edge?.toRef.nodeId);
  const toYamlNode = toGraphNode
    ? nodes.find((node) => node.id === toGraphNode.id)
    : null;
  const fromEntry = entries.find((entry) => entry.type === fromNode?.type);
  const toEntry = entries.find((entry) => entry.type === toGraphNode?.type);
  const typing = ndvPortTypingIncomplete(toEntry ?? fromEntry, toEntry?.type ?? fromEntry?.type ?? "");
  const acceptsPaths = toYamlNode
    ? ndvDestAcceptsFieldPathMapping(
        toYamlNode.type,
        edge?.toRef.port,
        toEntry?.allowedWith,
      )
    : false;
  return (
    <div className="space-y-4">
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
      <p className="mt-2 text-xs text-zinc-500">{NDV_MAPPING_EDGE_PORT_ONLY_HELP}</p>
      {typing.incomplete ? (
        <p role="status" className="mt-2 text-sm text-amber-950" data-ndv-port-typing="incomplete">
          {typing.reason}
        </p>
      ) : null}
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
    {toYamlNode && acceptsPaths ? (
      <NdvMappingPanel
        node={toYamlNode}
        nodes={nodes}
        edges={edges}
        entries={entries}
        catalog={catalog}
        canEdit={canEdit}
        pending={pending}
        suggestedFromPaths={suggestedFromPaths}
        onRewireInput={onRewireInput}
        onPatchMapping={
          onPatchNodeWith
            ? (id, mapping) => onPatchNodeWith(id, { mapping })
            : undefined
        }
        onPatchPath={
          onPatchNodeWith
            ? (id, path) => onPatchNodeWith(id, { path })
            : undefined
        }
      />
    ) : null}
    </div>
  );
}

function SelectedNodePins({
  node,
  entry,
  identity,
  canCall,
  canEdit,
  constraint,
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
  workflowId?: string;
  credentialRefreshNonce?: number;
  pendingCredentials?: Readonly<Record<string, InspectorPendingCredential>>;
  onAddCredential?: (request: InspectorAddCredentialRequest) => void;
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
}) {
  const embed = useEmbedMode();
  const credentialFields = inspectorCredentialFields(entry, node.type);
  const showPins =
    isKubernetesActionType(node.type) ||
    isSshConfigurableType(node.type) ||
    isHttpConfigurableType(node.type);
  const showCredentials = credentialFields.length > 0;

  if (!showPins && !showCredentials) {
    return null;
  }

  const clusterTargetId =
    typeof node.with.clusterTargetId === "string"
      ? String(node.with.clusterTargetId)
      : "";

  return (
    <>
    {showPins ? (
    <section
      data-ndv-panel="pins"
      aria-labelledby="node-pins-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="node-pins-heading" className="text-base font-semibold">
        Pins
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
      {isKubernetesActionType(node.type) ? (
        <div className="mt-3" data-ndv-field="clusterTargetId">
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
        <div className="mt-3" data-ndv-field="sshTargetId">
          <span hidden data-ndv-field="commandProfileId" />
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
        <div className="mt-3" data-ndv-field="connectionId">
          <span hidden data-ndv-field="recipientListId" />
          <span hidden data-ndv-field="templateId" />
          <span hidden data-ndv-field="responseSchemaRef" />
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
    </section>
    ) : null}
    {showCredentials ? (
    <section
      data-ndv-panel="credentials"
      aria-labelledby="node-credentials-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <h2 id="node-credentials-heading" className="text-base font-semibold">
        Credentials
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Display name + UUID only. Secret entry stays in the masked wizard.
      </p>
      {constraint && !showPins ? (
        <p role="status" className="mt-2 text-sm text-amber-950">
          {constraint}
        </p>
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
        <div key={fieldName} className="mt-3" data-ndv-field={fieldName}>
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
    ) : null}
    </>
  );
}
