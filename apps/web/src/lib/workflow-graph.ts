/**
 * Canvas graph adapter for E6.2. YAML stays the only persisted format.
 * A guessed graph is never projected when validation failed.
 */

import {
  catalogExcludesTriggerNodes,
  isCoreNeutralNodeType,
} from "./workflow-core-nodes.ts";
import { canShowSummary } from "./workflow.ts";
import type {
  CatalogNode,
  CatalogPort,
  WorkflowCatalog,
  WorkflowFieldError,
  WorkflowSummary,
} from "./workflow-types.ts";
import {
  insertYamlEdge,
  listYamlEdges,
  listYamlNodes,
  listYamlTriggers,
  readYamlWorkflowMeta,
  removeYamlEdge,
  removeYamlNode,
  updateYamlNode,
  type YamlWorkflowEdge,
  type YamlWorkflowNode,
} from "./workflow-yaml-nodes.ts";

export const PORT_REF_RE = /^([a-z][a-z0-9-]*)\.([A-Za-z][A-Za-z0-9_]*)$/;

export type PortRef = {
  nodeId: string;
  port: string;
};

export type CanvasNodeState =
  | "draft"
  | "valid"
  | "warning"
  | "invalid"
  | "approval-required"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "indeterminate";

export type GraphNode = {
  id: string;
  type: string;
  name: string;
  with: Record<string, unknown>;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  state: CanvasNodeState;
  startLine: number;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  fromRef: PortRef;
  toRef: PortRef;
  compatible: boolean;
  reason?: string;
  startLine: number;
};

export type WorkflowGraph = {
  name: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  triggers: { id: string; type: string }[];
};

export type PortConnectResult = {
  ok: boolean;
  reason: string;
};

export type ValidationGroup = "workflow" | "node" | "edge";

export type GroupedValidationError = WorkflowFieldError & {
  group: ValidationGroup;
  nodeId?: string;
  edgeId?: string;
};

const TRIGGER_TYPES = new Set(["manual", "webhook", "schedule", "event"]);

export function parsePortRef(value: string): PortRef | null {
  const match = PORT_REF_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  return { nodeId: match[1] ?? "", port: match[2] ?? "" };
}

export function formatPortRef(ref: PortRef): string {
  return `${ref.nodeId}.${ref.port}`;
}

export function portsCompatible(from: CatalogPort | undefined, to: CatalogPort | undefined): boolean {
  if (!from?.name || !to?.name) {
    return false;
  }
  if (to.kind === "any" || from.kind === "any") {
    return true;
  }
  return from.kind === to.kind;
}

export function catalogNodeByType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
): CatalogNode | undefined {
  return (catalog?.nodes ?? []).find((item) => item.type === type);
}

export type PalettePorts = {
  type: string;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  requiredWith?: string[];
};

export function portsForType(
  catalog: WorkflowCatalog | null | undefined,
  type: string,
  palette?: PalettePorts[],
): { inputs: CatalogPort[]; outputs: CatalogPort[] } {
  const entry = palette?.find((item) => item.type === type);
  if (entry) {
    return { inputs: entry.inputs, outputs: entry.outputs };
  }
  const node = catalogNodeByType(catalog, type);
  return {
    inputs: node?.inputs ?? [],
    outputs: node?.outputs ?? [],
  };
}

export function canConnectPorts(
  catalog: WorkflowCatalog | null | undefined,
  fromType: string,
  fromPort: string,
  toType: string,
  toPort: string,
  palette?: PalettePorts[],
): PortConnectResult {
  const fromPorts = portsForType(catalog, fromType, palette);
  const toPorts = portsForType(catalog, toType, palette);
  const output = fromPorts.outputs.find((port) => port.name === fromPort);
  const input = toPorts.inputs.find((port) => port.name === toPort);
  if (!output) {
    return {
      ok: false,
      reason: `${fromType} has no output port ${fromPort}.`,
    };
  }
  if (!input) {
    return {
      ok: false,
      reason: `${toType} has no input port ${toPort}.`,
    };
  }
  if (!portsCompatible(output, input)) {
    return {
      ok: false,
      reason: `Port ${fromPort} (${output.kind}) is not compatible with ${toPort} (${input.kind}).`,
    };
  }
  return { ok: true, reason: "" };
}

export function isTriggerType(type: string): boolean {
  return TRIGGER_TYPES.has(type);
}

export function nodeStateFromErrors(
  nodeId: string,
  errors: WorkflowFieldError[],
  warnings: WorkflowFieldError[] = [],
): CanvasNodeState {
  if (errors.some((error) => errorTargetsNode(error, nodeId))) {
    return "invalid";
  }
  if (warnings.some((error) => errorTargetsNode(error, nodeId))) {
    return "warning";
  }
  return "valid";
}

export function errorTargetsNode(error: WorkflowFieldError, nodeId: string): boolean {
  const path = error.path ?? "";
  if (path.includes(`nodes`) && path.includes(nodeId)) {
    return true;
  }
  return new RegExp(`\\.nodes\\[\\d+\\]`).test(path) === false
    ? path.includes(`.${nodeId}`) || path.endsWith(nodeId)
    : false;
}

export function validationGroupFor(error: WorkflowFieldError): ValidationGroup {
  const path = (error.path ?? "").toLowerCase();
  if (path.includes("edges") || path.includes(".from") && path.includes("edge") || error.code === "incompatible-ports") {
    return "edge";
  }
  if (path.includes("nodes") || path.includes("with.")) {
    return "node";
  }
  return "workflow";
}

export function nodeIdFromErrorPath(error: WorkflowFieldError, nodes: { id: string }[]): string | undefined {
  const path = error.path ?? "";
  const named = nodes.find((node) => path.includes(node.id));
  if (named) {
    return named.id;
  }
  const match = /nodes\[(\d+)\]/.exec(path);
  if (!match) {
    return undefined;
  }
  const index = Number(match[1]);
  return Number.isInteger(index) ? nodes[index]?.id : undefined;
}

export function groupValidationErrors(
  errors: WorkflowFieldError[],
  nodes: { id: string }[] = [],
  edges: { from: string; to: string }[] = [],
): GroupedValidationError[] {
  return errors.map((error) => {
    const group = validationGroupFor(error);
    const nodeId = nodeIdFromErrorPath(error, nodes);
    const edge = edges.find(
      (item) =>
        (error.path ?? "").includes(item.from) ||
        (error.path ?? "").includes(item.to) ||
        (error.message ?? "").includes(item.from) ||
        (error.message ?? "").includes(item.to),
    );
    return {
      ...error,
      group,
      ...(nodeId ? { nodeId } : {}),
      ...(edge ? { edgeId: `${edge.from}->${edge.to}` } : {}),
    };
  });
}

export function groupedValidationBuckets(errors: GroupedValidationError[]): {
  workflow: GroupedValidationError[];
  node: GroupedValidationError[];
  edge: GroupedValidationError[];
} {
  return {
    workflow: errors.filter((error) => error.group === "workflow"),
    node: errors.filter((error) => error.group === "node"),
    edge: errors.filter((error) => error.group === "edge"),
  };
}

/**
 * Project a canvas graph only from a successful validate/normalize summary.
 * Invalid YAML must not produce a guessed graph.
 */
export function projectCanvasGraph(input: {
  errors: WorkflowFieldError[];
  summary: WorkflowSummary | null;
  yaml: string;
  catalog?: WorkflowCatalog | null;
  palette?: PalettePorts[];
  warnings?: WorkflowFieldError[];
}): WorkflowGraph | null {
  if (!canShowSummary(input.errors, input.summary)) {
    return null;
  }
  return graphFromValidatedYaml(input.yaml, input.summary, {
    catalog: input.catalog,
    palette: input.palette,
    warnings: input.warnings ?? [],
    errors: input.errors,
  });
}

export function graphFromValidatedYaml(
  yaml: string,
  summary: WorkflowSummary,
  options: {
    catalog?: WorkflowCatalog | null;
    palette?: PalettePorts[];
    warnings?: WorkflowFieldError[];
    errors?: WorkflowFieldError[];
  } = {},
): WorkflowGraph {
  const yamlNodes = listYamlNodes(yaml);
  const yamlEdges = listYamlEdges(yaml);
  const byId = new Map(yamlNodes.map((node) => [node.id, node]));
  const nodes: GraphNode[] = summary.nodes.map((item) => {
    const yamlNode = byId.get(item.id);
    const ports = portsForType(options.catalog, item.type, options.palette);
    return {
      id: item.id,
      type: item.type,
      name: yamlNode?.name || item.name,
      with: yamlNode?.with ?? {},
      inputs: ports.inputs,
      outputs: ports.outputs,
      state: nodeStateFromErrors(item.id, options.errors ?? [], options.warnings ?? []),
      startLine: yamlNode?.startLine ?? 0,
    };
  });
  const edges: GraphEdge[] = summary.edges.map((item, index) => {
    const fromRef = parsePortRef(item.from);
    const toRef = parsePortRef(item.to);
    const yamlEdge = yamlEdges.find((edge) => edge.from === item.from && edge.to === item.to);
    const fromNode = nodes.find((node) => node.id === fromRef?.nodeId);
    const toNode = nodes.find((node) => node.id === toRef?.nodeId);
    const connect =
      fromRef && toRef && fromNode && toNode
        ? canConnectPorts(
            options.catalog,
            fromNode.type,
            fromRef.port,
            toNode.type,
            toRef.port,
            options.palette,
          )
        : { ok: false, reason: "Edge ports are not resolvable." };
    return {
      id: `${item.from}->${item.to}` || `edge-${index}`,
      from: item.from,
      to: item.to,
      fromRef: fromRef ?? { nodeId: "", port: "" },
      toRef: toRef ?? { nodeId: "", port: "" },
      compatible: connect.ok,
      reason: connect.reason || undefined,
      startLine: yamlEdge?.startLine ?? 0,
    };
  });
  const meta = readYamlWorkflowMeta(yaml);
  return {
    name: meta.name || summary.name,
    description: meta.description || summary.description || "",
    nodes,
    edges,
    triggers: summary.triggers.map((trigger) => ({ id: trigger.id, type: trigger.type })),
  };
}

/** Structural YAML parse for tests and canvas→YAML helpers — not a validation guess. */
export function parseYamlGraph(yaml: string): {
  nodes: YamlWorkflowNode[];
  edges: YamlWorkflowEdge[];
  triggers: { id: string; type: string }[];
  meta: { name: string; description: string };
} {
  return {
    nodes: listYamlNodes(yaml),
    edges: listYamlEdges(yaml),
    triggers: listYamlTriggers(yaml).map((trigger) => ({
      id: trigger.id,
      type: trigger.type,
    })),
    meta: readYamlWorkflowMeta(yaml),
  };
}

export function canvasYamlRoundTrip(yaml: string): {
  yaml: string;
  nodes: { id: string; type: string; name: string }[];
  edges: { from: string; to: string }[];
} {
  const parsed = parseYamlGraph(yaml);
  let next = yaml;
  for (const node of parsed.nodes) {
    next =
      updateYamlNode(next, {
        id: node.id,
        type: node.type,
        name: node.name,
        with: node.with,
      }) ?? next;
  }
  const after = parseYamlGraph(next);
  return {
    yaml: next,
    nodes: after.nodes.map((node) => ({ id: node.id, type: node.type, name: node.name })),
    edges: after.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
}

export function connectGraphEdge(
  yaml: string,
  from: string,
  to: string,
  catalog?: WorkflowCatalog | null,
  palette?: PalettePorts[],
): { yaml: string; errors: string[] } {
  const fromRef = parsePortRef(from);
  const toRef = parsePortRef(to);
  if (!fromRef || !toRef) {
    return { yaml, errors: ["Edges must use nodeId.port references."] };
  }
  if (fromRef.nodeId === toRef.nodeId) {
    return { yaml, errors: ["An edge cannot connect a node to itself."] };
  }
  const nodes = listYamlNodes(yaml);
  const fromNode = nodes.find((node) => node.id === fromRef.nodeId);
  const toNode = nodes.find((node) => node.id === toRef.nodeId);
  if (!fromNode || !toNode) {
    return { yaml, errors: ["Edge references an unknown node."] };
  }
  const connect = canConnectPorts(
    catalog,
    fromNode.type,
    fromRef.port,
    toNode.type,
    toRef.port,
    palette,
  );
  if (!connect.ok) {
    return { yaml, errors: [connect.reason] };
  }
  return { yaml: insertYamlEdge(yaml, from, to), errors: [] };
}

export function disconnectGraphEdge(yaml: string, from: string, to: string): string {
  return removeYamlEdge(yaml, from, to);
}

export function removeGraphNode(yaml: string, id: string): string {
  return removeYamlNode(yaml, id);
}

export function layoutGraphNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, number>();
  for (const node of nodes) {
    incoming.set(node.id, 0);
  }
  for (const edge of edges) {
    incoming.set(edge.toRef.nodeId, (incoming.get(edge.toRef.nodeId) ?? 0) + 1);
  }
  const layers = new Map<string, number>();
  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const id of queue) {
    layers.set(id, 0);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.fromRef.nodeId) ?? [];
    list.push(edge.toRef.nodeId);
    outgoing.set(edge.fromRef.nodeId, list);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      break;
    }
    const layer = layers.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      layers.set(next, Math.max(layers.get(next) ?? 0, layer + 1));
      queue.push(next);
    }
  }
  const byLayer = new Map<number, string[]>();
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0;
    const list = byLayer.get(layer) ?? [];
    list.push(node.id);
    byLayer.set(layer, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, ids] of byLayer) {
    ids.forEach((id, index) => {
      positions.set(id, { x: 48 + layer * 240, y: 48 + index * 140 });
    });
  }
  return positions;
}

export function canvasNodeStateLabel(state: CanvasNodeState): string {
  switch (state) {
    case "approval-required":
      return "Approval required";
    case "indeterminate":
      return "Indeterminate";
    default:
      return state.replace(/^\w/, (letter) => letter.toUpperCase());
  }
}

export function canvasNodeStateIcon(state: CanvasNodeState): string {
  switch (state) {
    case "valid":
      return "✓";
    case "warning":
      return "!";
    case "invalid":
      return "×";
    case "approval-required":
      return "◇";
    case "running":
      return "▸";
    case "succeeded":
      return "✓";
    case "failed":
      return "×";
    case "canceled":
      return "■";
    case "indeterminate":
      return "?";
    default:
      return "○";
  }
}

export function triggersStayOffCanvas(
  catalog: Pick<WorkflowCatalog, "rules"> | null | undefined,
): boolean {
  return catalogExcludesTriggerNodes(catalog);
}

export function isPlaceableGraphType(
  type: string,
  catalog?: Pick<WorkflowCatalog, "rules"> | null,
): boolean {
  if (triggersStayOffCanvas(catalog) && isTriggerType(type)) {
    return false;
  }
  return !isTriggerType(type);
}

export function requiredWithErrors(
  node: { type: string; with: Record<string, unknown> },
  catalog?: WorkflowCatalog | null,
  palette?: PalettePorts[],
): string[] {
  const required =
    palette?.find((entry) => entry.type === node.type)?.requiredWith ??
    catalogNodeByType(catalog, node.type)?.requiredWith ??
    [];
  return required.filter((key) => {
    const value = node.with[key];
    return value === undefined || value === null || value === "";
  }).map((key) => `${node.type} requires with.${key}.`);
}

export function editorHasLocalInvalidations(
  yaml: string,
  catalog?: WorkflowCatalog | null,
  palette?: PalettePorts[],
): string[] {
  const errors: string[] = [];
  for (const node of listYamlNodes(yaml)) {
    if (!isPlaceableGraphType(node.type, catalog) && isTriggerType(node.type)) {
      errors.push(`${node.id} is a trigger and cannot be a graph node.`);
    }
    errors.push(...requiredWithErrors(node, catalog, palette));
    if (isCoreNeutralNodeType(node.type)) {
      continue;
    }
  }
  for (const edge of listYamlEdges(yaml)) {
    const fromRef = parsePortRef(edge.from);
    const toRef = parsePortRef(edge.to);
    if (!fromRef || !toRef) {
      errors.push(`Edge ${edge.from} → ${edge.to} is not nodeId.port.`);
    }
  }
  return errors;
}

export function canSaveWorkflowEditor(input: {
  status: "idle" | "pending" | "valid" | "invalid";
  errors: WorkflowFieldError[];
  localErrors?: string[];
}): boolean {
  return (
    input.status === "valid" &&
    input.errors.length === 0 &&
    (input.localErrors?.length ?? 0) === 0
  );
}
