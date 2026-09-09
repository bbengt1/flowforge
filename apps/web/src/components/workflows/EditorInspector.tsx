"use client";

import { NodeInspector } from "@/components/workflows/NodeInspector";
import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import { KubernetesTargetSelect } from "@/components/config/KubernetesTargetSelect";
import type { EditorSelection } from "@/components/workflows/WorkflowCanvas";
import { isKubernetesActionType } from "@/lib/kubernetes";
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

type EditorInspectorProps = {
  yaml: string;
  graph: WorkflowGraph | null;
  nodes: YamlWorkflowNode[];
  entries: ActionLibraryEntry[];
  selection: EditorSelection;
  pending: boolean;
  identity: DevIdentity;
  canCall: boolean;
  onSelectNode: (id: string) => void;
  onApply: (id: string, name: string, config: CoreNodeWith) => string[];
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
};

const CREDENTIAL_KEYS = /credential|connectionid/i;

export function EditorInspector({
  yaml,
  graph,
  nodes,
  entries,
  selection,
  pending,
  identity,
  canCall,
  onSelectNode,
  onApply,
  onPatchNodeWith,
}: EditorInspectorProps) {
  const selectedNodeId = selection.kind === "node" ? selection.id : null;
  const palette = entries.filter((entry) =>
    isCoreNeutralNodeType(entry.type),
  ) as CoreNeutralPaletteEntry[];

  return (
    <div className="space-y-6">
      {selection.kind === "workflow" ? (
        <WorkflowInspect yaml={yaml} graph={graph} />
      ) : null}
      {selection.kind === "edge" ? (
        <EdgeInspect graph={graph} from={selection.from} to={selection.to} entries={entries} />
      ) : null}
      <NodeInspector
        nodes={nodes}
        selectedId={selectedNodeId}
        entries={palette}
        pending={pending}
        onSelect={onSelectNode}
        onApply={onApply}
      />
      {selection.kind === "node" ? (
        <CredentialHints
          node={nodes.find((node) => node.id === selection.id) ?? null}
          entry={entries.find((item) => item.type === nodes.find((node) => node.id === selection.id)?.type)}
          identity={identity}
          canCall={canCall}
          onPatchNodeWith={onPatchNodeWith}
        />
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

function CredentialHints({
  node,
  entry,
  identity,
  canCall,
  onPatchNodeWith,
}: {
  node: YamlWorkflowNode | null;
  entry?: ActionLibraryEntry;
  identity: DevIdentity;
  canCall: boolean;
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
}) {
  if (!node || !entry) {
    return null;
  }
  const credentialFields = [
    ...entry.requiredWith,
    ...entry.allowedWith.map((field) => field.name),
  ].filter((name, index, all) => all.indexOf(name) === index && CREDENTIAL_KEYS.test(name));
  if (
    credentialFields.length === 0 &&
    !entry.policy &&
    !isKubernetesActionType(node.type)
  ) {
    return (
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Policy</h2>
        <p className="mt-2 text-sm text-zinc-600">
          {formatPolicy(entry.policy) || "No additional policy metadata on this catalog entry."}
        </p>
        <p className="mt-2 font-mono text-xs text-zinc-500">
          {[
            ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
            ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
          ].join(" · ")}
        </p>
        {formatBounds(entry.bounds) ? (
          <p className="mt-1 text-xs text-zinc-500">bounds: {formatBounds(entry.bounds)}</p>
        ) : null}
        {formatRedaction(entry.redaction) ? (
          <p className="mt-1 text-xs text-zinc-500">redaction: {formatRedaction(entry.redaction)}</p>
        ) : null}
      </section>
    );
  }
  const clusterTargetId =
    typeof node.with.clusterTargetId === "string"
      ? String(node.with.clusterTargetId)
      : "";

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Ports, policy, credentials</h2>
      <p className="mt-2 font-mono text-xs text-zinc-500">
        {[
          ...(entry.inputs ?? []).map((port) => formatPort(port, "in")),
          ...(entry.outputs ?? []).map((port) => formatPort(port, "out")),
        ].join(" · ") || "no ports"}
      </p>
      {formatPolicy(entry.policy) ? (
        <p className="mt-2 text-sm text-zinc-700">policy: {formatPolicy(entry.policy)}</p>
      ) : null}
      {isKubernetesActionType(node.type) ? (
        <div className="mt-3">
          <KubernetesTargetSelect
            identity={identity}
            ready={canCall}
            value={clusterTargetId}
            disabled={!onPatchNodeWith}
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
      {credentialFields.map((field) => (
        <div key={field} className="mt-3">
          <p className="text-xs font-medium text-zinc-600">{field}</p>
          <CredentialRefSelect
            identity={identity}
            ready={canCall}
            value={typeof node.with[field] === "string" ? String(node.with[field]) : ""}
            disabled
            onChange={() => undefined}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Credentials are selected by display name only. YAML stores the
            workspace UUID; secret values are never shown. The add-action
            wizard (E6.3) writes these fields.
          </p>
        </div>
      ))}
    </section>
  );
}
