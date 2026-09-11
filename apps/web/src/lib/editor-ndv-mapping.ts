/**
 * R3.2: typed field-path mapping in the NDV.
 *
 * Relates to #247 / Part of #229. Keep #247 open.
 *
 * Chloe UI only. Mapping is catalog port types + `allowedWith` field
 * paths — no expression language, no SecretField, no invented API
 * routes. Edges stay `nodeId.port`. Nested field paths persist only
 * where YAML already allows them (`data.map` `with.mapping`,
 * `flow.condition` `with.path`). If catalog ports lack `kind`, ping
 * jonny — do not invent nested port schemas.
 */

import { editorEmbedRouteUnchanged } from "./editor-chrome.ts";
import {
  EDITOR_INSPECTOR,
  inspectorValidationLinks,
  isInspectorSecretSurfaceName,
} from "./editor-inspector.ts";
import { ndvInspectorIsEdit, ndvWizardStaysAdd } from "./editor-ndv.ts";
import { projectCanvasGraph } from "./workflow-graph.ts";
import {
  canConnectPorts,
  formatPortRef,
  parsePortRef,
  portsCompatible,
  type PalettePorts,
} from "./workflow-graph.ts";
import { MAP_CONVERT_KINDS } from "./workflow-core-nodes.ts";
import { canShowSummary } from "./workflow.ts";
import type { ActionLibraryEntry } from "./workflow-action-library.ts";
import type {
  CatalogPort,
  CatalogWithField,
  WorkflowCatalog,
  WorkflowFieldError,
  WorkflowSummary,
} from "./workflow-types.ts";
import {
  isForbiddenYamlKey,
  looksLikeSecretValue,
  type MapPath,
  type YamlWorkflowEdge,
  type YamlWorkflowNode,
} from "./workflow-yaml-nodes.ts";

export const R32_STORY = 247;
export const R32_EPIC = 229;
export const R32_KEEP_STORY_OPEN = true;

export const NDV_FIELD_PATH_RE =
  /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63})*$/;
export const NDV_MAX_FIELD_PATH_DEPTH = 8;
export const NDV_MAX_MAPPING_ENTRIES = 32;

/** Matches jonny's classify.go expressionRE — closed by charter. */
export const NDV_EXPRESSION_FORBIDDEN_RE =
  /\{\{|}}|\{%|%\}|\$\{|<%|\|\||&&/;

export const NDV_MAPPING_CONVERT_KINDS = MAP_CONVERT_KINDS;

export const JONNY_PORT_TYPING_INCOMPLETE =
  "Catalog port types are incomplete for this node. Mapping stays fail-closed. Ping jonny — do not invent nested port schemas or API routes.";

export const NDV_MAPPING_NO_EXPRESSION_HELP =
  "Map dotted identifier paths only (foo.bar). No {{ }}, ${}, templates, or boolean expressions.";

export const NDV_MAPPING_EDGE_PORT_ONLY_HELP =
  "Edges stay nodeId.port. Field-level remap uses data.map with.mapping or flow.condition path — not an invented edge field.";

export const EDITOR_NDV_MAPPING = {
  wizardIsAdd: true,
  inspectorIsEdit: true,
  typedFieldPathMapping: true,
  usesAllowedWithAndCatalogPortTypes: true,
  noExpressionLanguage: true,
  noSecretField: true,
  displayNamePlusUuidOnly: true,
  incompatibleBlockedOrExplained: true,
  validationLinksStillWork: true,
  edgesRemainNodePort: true,
  noInventedApiRoutes: true,
  noAppsApiChanges: true,
  noDraftExecute: true,
  embedPathUnchanged: true,
  keep247Open: true,
  jonnyIfPortTypingIncomplete: true,
} as const;

export const NDV_MAPPING_RAIL_SOURCES = [
  "src/components/workflows/NdvMappingPanel.tsx",
  "src/components/workflows/EditorInspector.tsx",
  "src/components/workflows/NodeInspector.tsx",
] as const;

const SECRET_SURFACE_IN_SOURCE =
  /SecretField\b|type=["']password["']|rotateCredential|forgetSecretDraft|rotateWebhookTrigger/;
const EXPRESSION_LANGUAGE_IN_SOURCE =
  /\{\{|ExpressionEditor/;
const INVENTED_ROUTE_IN_SOURCE =
  /\/replay\b|\/compare\b|\/mapping\b/;

export type NdvMappingConvert = (typeof NDV_MAPPING_CONVERT_KINDS)[number];

export type NdvTypedPortMapping = {
  dest: string;
  from: string;
  convert?: string;
};

export type NdvPortWire = {
  input: CatalogPort;
  from: string | null;
  fromPort: CatalogPort | null;
  compatible: boolean;
  reason: string;
  yamlPath: string;
};

export type NdvPortTypingReport = {
  incomplete: boolean;
  reason: string | null;
};

export type NdvMappingValidation = {
  ok: boolean;
  errors: string[];
  fieldErrors: WorkflowFieldError[];
};

export function ndvWizardRemainsAdd(): boolean {
  return (
    EDITOR_NDV_MAPPING.wizardIsAdd &&
    EDITOR_INSPECTOR.wizardIsAdd &&
    ndvWizardStaysAdd()
  );
}

export function ndvMappingIsEdit(): boolean {
  return (
    EDITOR_NDV_MAPPING.inspectorIsEdit &&
    EDITOR_INSPECTOR.inspectorIsEdit &&
    ndvInspectorIsEdit()
  );
}

export function ndvMappingEmbedUnchanged(): boolean {
  return (
    EDITOR_NDV_MAPPING.embedPathUnchanged && editorEmbedRouteUnchanged()
  );
}

export function ndvLooksLikeExpression(value: string): boolean {
  return NDV_EXPRESSION_FORBIDDEN_RE.test(value) || /[{}$]|\?\s|:/.test(value);
}

export function ndvFieldPathDepth(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(".").length;
}

export function isNdvFieldPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || ndvLooksLikeExpression(trimmed)) {
    return false;
  }
  if (!NDV_FIELD_PATH_RE.test(trimmed)) {
    return false;
  }
  if (ndvFieldPathDepth(trimmed) > NDV_MAX_FIELD_PATH_DEPTH) {
    return false;
  }
  return trimmed.split(".").every((segment) => !isForbiddenFieldPathSegment(segment));
}

export function isForbiddenFieldPathSegment(segment: string): boolean {
  return (
    isForbiddenYamlKey(segment) ||
    isInspectorSecretSurfaceName(segment) ||
    looksLikeSecretValue(segment)
  );
}

export function ndvFieldPathError(value: string, label = "Path"): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return `${label} is required.`;
  }
  if (ndvLooksLikeExpression(trimmed)) {
    return `${label} must be a field path, not an expression.`;
  }
  if (!NDV_FIELD_PATH_RE.test(trimmed)) {
    return `${label} must be a dotted identifier path (foo.bar).`;
  }
  if (ndvFieldPathDepth(trimmed) > NDV_MAX_FIELD_PATH_DEPTH) {
    return `${label} exceeds the depth limit of ${NDV_MAX_FIELD_PATH_DEPTH}.`;
  }
  for (const segment of trimmed.split(".")) {
    if (isForbiddenFieldPathSegment(segment)) {
      return `${label} cannot use secret-shaped names.`;
    }
  }
  return null;
}

export function ndvPortKindsCompatible(
  fromKind: string | undefined,
  toKind: string | undefined,
): boolean {
  if (!fromKind?.trim() || !toKind?.trim()) {
    return false;
  }
  return portsCompatible(
    { name: "from", kind: fromKind },
    { name: "to", kind: toKind },
  );
}

export function ndvConvertKind(convert: string | undefined): string | null {
  const trimmed = convert?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return (NDV_MAPPING_CONVERT_KINDS as readonly string[]).includes(trimmed)
    ? trimmed
    : null;
}

export function ndvFieldKindsCompatible(input: {
  fromKind?: string;
  toKind?: string;
  convert?: string;
}): { ok: boolean; reason: string } {
  const convert = ndvConvertKind(input.convert);
  if (input.convert?.trim() && !convert) {
    return {
      ok: false,
      reason: `convert must be ${NDV_MAPPING_CONVERT_KINDS.join(", ")}.`,
    };
  }
  const produced = convert ?? input.fromKind;
  if (!produced?.trim() || !input.toKind?.trim()) {
    return {
      ok: false,
      reason:
        "Field kinds are unknown. Mapping stays fail-closed until catalog port types or allowedWith kinds are present.",
    };
  }
  if (ndvPortKindsCompatible(produced, input.toKind)) {
    return { ok: true, reason: "" };
  }
  return {
    ok: false,
    reason: `Kind ${produced} is not compatible with ${input.toKind}.`,
  };
}

export function ndvPortTypingIncomplete(
  entry:
    | Pick<ActionLibraryEntry, "inputs" | "outputs" | "type" | "source">
    | PalettePorts
    | undefined,
  type: string,
): NdvPortTypingReport {
  if (!entry) {
    return {
      incomplete: true,
      reason: `${JONNY_PORT_TYPING_INCOMPLETE} Missing catalog entry for ${type}.`,
    };
  }
  const ports = [...(entry.inputs ?? []), ...(entry.outputs ?? [])];
  const missing = ports.filter((port) => !port.kind?.trim());
  if (missing.length > 0) {
    return {
      incomplete: true,
      reason: `${JONNY_PORT_TYPING_INCOMPLETE} ${type} ports missing kind: ${missing
        .map((port) => port.name)
        .join(", ")}.`,
    };
  }
  return { incomplete: false, reason: null };
}

export function ndvDestAcceptsFieldPathMapping(
  type: string,
  portName?: string,
  allowedWith: readonly CatalogWithField[] = [],
): boolean {
  if (type === "data.map" && (!portName || portName === "input")) {
    return true;
  }
  if (type === "flow.condition" && (!portName || portName === "value")) {
    return true;
  }
  return allowedWith.some(
    (field) =>
      field.kind === "mapping" ||
      field.name === "mapping" ||
      field.name === "path",
  );
}

export function ndvAllowedWithFieldKind(
  allowedWith: readonly CatalogWithField[] | undefined,
  name: string,
): string | undefined {
  return allowedWith?.find((field) => field.name === name)?.kind;
}

export function validateNdvTypedMapping(
  rows: readonly NdvTypedPortMapping[],
  options: {
    nodeId?: string;
    nodeIndex?: number;
    fromKind?: string;
    destKind?: string;
    allowedWith?: readonly CatalogWithField[];
  } = {},
): NdvMappingValidation {
  const errors: string[] = [];
  const fieldErrors: WorkflowFieldError[] = [];
  const nodeIndex = options.nodeIndex;
  const yamlBase =
    typeof nodeIndex === "number"
      ? `spec.nodes[${nodeIndex}].with.mapping`
      : options.nodeId
        ? `spec.nodes.${options.nodeId}.with.mapping`
        : "spec.nodes.with.mapping";
  if (rows.length > NDV_MAX_MAPPING_ENTRIES) {
    const message = `Mapping is limited to ${NDV_MAX_MAPPING_ENTRIES} rows.`;
    errors.push(message);
    fieldErrors.push({
      path: yamlBase,
      code: "aggregation-limit",
      message,
    });
    return { ok: false, errors, fieldErrors };
  }
  const mappingKind = ndvAllowedWithFieldKind(options.allowedWith, "mapping");
  if (
    options.allowedWith &&
    options.allowedWith.length > 0 &&
    mappingKind &&
    mappingKind !== "mapping" &&
    mappingKind !== "object" &&
    mappingKind !== "any"
  ) {
    const message = `allowedWith.mapping kind ${mappingKind} cannot hold field-path rows.`;
    errors.push(message);
    fieldErrors.push({
      path: yamlBase,
      code: "incompatible-ports",
      message,
    });
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const dest = row.dest.trim();
    const from = row.from.trim();
    if (!dest && !from && !row.convert) {
      continue;
    }
    const destError = ndvFieldPathError(dest, "Destination");
    const fromError = ndvFieldPathError(from, "Source");
    const destPath = dest ? `${yamlBase}.${dest}` : yamlBase;
    if (destError) {
      errors.push(destError);
      fieldErrors.push({
        path: destPath,
        code: ndvLooksLikeExpression(dest) ? "expression-forbidden" : "invalid-with",
        message: destError,
      });
    }
    if (fromError) {
      errors.push(fromError);
      fieldErrors.push({
        path: destPath,
        code: ndvLooksLikeExpression(from) ? "expression-forbidden" : "unresolved-reference",
        message: fromError,
      });
    }
    if (dest && seen.has(dest)) {
      const message = `Destination ${dest} is already mapped.`;
      errors.push(message);
      fieldErrors.push({
        path: destPath,
        code: "duplicate-edge",
        message,
      });
    }
    if (dest) {
      seen.add(dest);
    }
    const kinds = ndvFieldKindsCompatible({
      fromKind: options.fromKind ?? "object",
      toKind: options.destKind ?? "object",
      convert: row.convert,
    });
    if (!kinds.ok && (dest || from || row.convert)) {
      errors.push(kinds.reason);
      fieldErrors.push({
        path: destPath,
        code: "incompatible-ports",
        message: kinds.reason,
      });
    }
  }
  if (seen.size === 0 && rows.some((row) => row.dest.trim() || row.from.trim())) {
    const message = "data.map requires at least one dest → from mapping.";
    errors.push(message);
    fieldErrors.push({
      path: yamlBase,
      code: "missing-field",
      message,
    });
  }
  return { ok: errors.length === 0, errors, fieldErrors };
}

export function mappingObjectFromRows(
  rows: readonly NdvTypedPortMapping[],
): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  for (const row of rows) {
    const dest = row.dest.trim();
    const from = row.from.trim();
    const convert = ndvConvertKind(row.convert);
    if (!dest || !from || !isNdvFieldPath(dest) || !isNdvFieldPath(from)) {
      continue;
    }
    mapping[dest] = convert ? { from, convert } : from;
  }
  return mapping;
}

export function rowsFromMappingValue(value: unknown): NdvTypedPortMapping[] {
  if (!value) {
    return [{ dest: "", from: "" }];
  }
  if (Array.isArray(value)) {
    const rows: NdvTypedPortMapping[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as { dest?: unknown; from?: unknown; convert?: unknown };
      const row: NdvTypedPortMapping = {
        dest: typeof rec.dest === "string" ? rec.dest : "",
        from: typeof rec.from === "string" ? rec.from : "",
      };
      if (typeof rec.convert === "string") {
        row.convert = rec.convert;
      }
      rows.push(row);
    }
    return rows.length > 0 ? rows : [{ dest: "", from: "" }];
  }
  if (typeof value !== "object") {
    return [{ dest: "", from: "" }];
  }
  const rows = Object.entries(value as Record<string, unknown>).map(
    ([dest, spec]) => {
      if (typeof spec === "string") {
        return { dest, from: spec };
      }
      if (spec && typeof spec === "object" && !Array.isArray(spec)) {
        const rec = spec as { from?: unknown; convert?: unknown };
        return {
          dest,
          from: typeof rec.from === "string" ? rec.from : "",
          convert: typeof rec.convert === "string" ? rec.convert : undefined,
        };
      }
      return { dest, from: "" };
    },
  );
  return rows.length > 0 ? rows : [{ dest: "", from: "" }];
}

export function mapPathsToRows(mapping: readonly MapPath[]): NdvTypedPortMapping[] {
  return mapping.length > 0
    ? mapping.map((row) => ({
        dest: row.dest,
        from: row.from,
        convert: row.convert,
      }))
    : [{ dest: "", from: "" }];
}

export function suggestNdvFieldPaths(
  value: unknown,
  prefix = "",
  depth = 0,
): string[] {
  if (depth >= NDV_MAX_FIELD_PATH_DEPTH) {
    return prefix ? [prefix] : [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenFieldPathSegment(key)) {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const children = suggestNdvFieldPaths(nested, path, depth + 1);
      if (children.length > 0) {
        out.push(...children);
        continue;
      }
    }
    out.push(path);
  }
  return out.slice(0, NDV_MAX_MAPPING_ENTRIES);
}

export function ndvPortWiresForNode(input: {
  node: YamlWorkflowNode;
  nodes: readonly YamlWorkflowNode[];
  edges: readonly YamlWorkflowEdge[] | { from: string; to: string }[];
  catalog?: WorkflowCatalog | null;
  entries?: readonly ActionLibraryEntry[];
  nodeIndex?: number;
}): NdvPortWire[] {
  const ports = portsForNode(input.node.type, input.catalog, input.entries);
  const typing = ndvPortTypingIncomplete(
    entryForType(input.node.type, input.entries, input.catalog),
    input.node.type,
  );
  const index =
    input.nodeIndex ??
    input.nodes.findIndex((node) => node.id === input.node.id);
  return ports.inputs.map((port) => {
    const to = formatPortRef({ nodeId: input.node.id, port: port.name });
    const edge = input.edges.find((item) => item.to === to);
    const fromRef = edge ? parsePortRef(edge.from) : null;
    const fromNode = fromRef
      ? input.nodes.find((node) => node.id === fromRef.nodeId)
      : undefined;
    const fromPorts = fromNode
      ? portsForNode(fromNode.type, input.catalog, input.entries)
      : { inputs: [], outputs: [] };
    const fromPort = fromRef
      ? fromPorts.outputs.find((item) => item.name === fromRef.port) ?? null
      : null;
    const connect =
      fromNode && fromRef
        ? canConnectPorts(
            input.catalog,
            fromNode.type,
            fromRef.port,
            input.node.type,
            port.name,
            paletteFromEntries(input.entries),
          )
        : edge
          ? { ok: false, reason: "Upstream port could not be resolved." }
          : { ok: true, reason: "" };
    const compatible = Boolean(fromPort) && connect.ok && !typing.incomplete
      ? portsCompatible(fromPort ?? undefined, port)
      : connect.ok && Boolean(fromPort) && ndvPortKindsCompatible(fromPort?.kind, port.kind);
    let reason = "";
    if (edge && !fromPort) {
      reason = connect.reason || "Upstream port could not be resolved.";
    } else if (edge && typing.incomplete) {
      reason = typing.reason ?? JONNY_PORT_TYPING_INCOMPLETE;
    } else if (edge && !compatible) {
      reason =
        connect.reason ||
        `Port ${fromPort?.name ?? fromRef?.port} (${fromPort?.kind ?? "unknown"}) is not compatible with ${port.name} (${port.kind || "unknown"}).`;
    } else if (port.required && !edge) {
      reason = `Required input ${input.node.id}.${port.name} is not wired.`;
    }
    const yamlPath =
      index >= 0
        ? `spec.nodes[${index}].inputs.${port.name}`
        : `spec.nodes.${input.node.id}.inputs.${port.name}`;
    return {
      input: port,
      from: edge?.from ?? null,
      fromPort,
      compatible: !edge || compatible,
      reason,
      yamlPath,
    };
  });
}

export function compatibleUpstreamPortOptions(
  nodes: readonly YamlWorkflowNode[],
  dest: YamlWorkflowNode,
  inputPort: CatalogPort,
  catalog?: WorkflowCatalog | null,
  entries: readonly ActionLibraryEntry[] = [],
): { from: string; label: string; port: CatalogPort }[] {
  const out: { from: string; label: string; port: CatalogPort }[] = [];
  for (const node of nodes) {
    if (node.id === dest.id) {
      continue;
    }
    const ports = portsForNode(node.type, catalog, entries);
    for (const port of ports.outputs) {
      if (portsCompatible(port, inputPort)) {
        out.push({
          from: formatPortRef({ nodeId: node.id, port: port.name }),
          label: `${node.name || node.id}.${port.name} (${port.kind})`,
          port,
        });
      }
    }
  }
  return out;
}

export function ndvMappingValidationLinks(
  errors: WorkflowFieldError[],
  nodes: { id: string }[] = [],
  edges: { from: string; to: string }[] = [],
) {
  return inspectorValidationLinks(errors, nodes, edges);
}

export function ndvMappingNeverGuessesGraph(input: {
  errors: WorkflowFieldError[];
  summary: WorkflowSummary | null;
  yaml: string;
}): boolean {
  if (!canShowSummary(input.errors, input.summary)) {
    return (
      projectCanvasGraph({
        errors: input.errors,
        summary: input.summary,
        yaml: input.yaml,
      }) === null
    );
  }
  return true;
}

export function localNdvMappingErrors(
  nodes: readonly YamlWorkflowNode[],
  edges: readonly YamlWorkflowEdge[],
  catalog?: WorkflowCatalog | null,
  entries: readonly ActionLibraryEntry[] = [],
): WorkflowFieldError[] {
  const errors: WorkflowFieldError[] = [];
  nodes.forEach((node, index) => {
    const entry = entryForType(node.type, entries, catalog);
    const wires = ndvPortWiresForNode({
      node,
      nodes,
      edges,
      catalog,
      entries,
      nodeIndex: index,
    });
    for (const wire of wires) {
      if (wire.from && !wire.compatible && wire.reason) {
        errors.push({
          path: wire.yamlPath,
          code: "incompatible-ports",
          message: wire.reason,
        });
      }
    }
    if (node.type === "data.map") {
      const rows = rowsFromMappingValue(node.with.mapping);
      const mapped = validateNdvTypedMapping(rows, {
        nodeId: node.id,
        nodeIndex: index,
        fromKind: "object",
        destKind: "object",
        allowedWith: entry?.allowedWith,
      });
      errors.push(...mapped.fieldErrors);
    }
    if (node.type === "flow.condition") {
      const path = typeof node.with.path === "string" ? node.with.path : "";
      if (path) {
        const pathError = ndvFieldPathError(path, "path");
        if (pathError) {
          errors.push({
            path: `spec.nodes[${index}].with.path`,
            code: ndvLooksLikeExpression(path)
              ? "expression-forbidden"
              : "invalid-with",
            message: pathError,
          });
        }
      }
    }
  });
  return errors;
}

export function ndvMappingSourceForbidsSecretSurface(source: string): boolean {
  return !SECRET_SURFACE_IN_SOURCE.test(source);
}

export function ndvMappingSourceForbidsExpressionLanguage(source: string): boolean {
  return !EXPRESSION_LANGUAGE_IN_SOURCE.test(source);
}

export function ndvMappingSourceForbidsInventedRoutes(source: string): boolean {
  return !INVENTED_ROUTE_IN_SOURCE.test(source);
}

function entryForType(
  type: string,
  entries: readonly ActionLibraryEntry[] | undefined,
  catalog?: WorkflowCatalog | null,
):
  | (Pick<ActionLibraryEntry, "inputs" | "outputs" | "type" | "allowedWith"> & {
      source?: string;
    })
  | undefined {
  const listed = entries?.find((item) => item.type === type);
  if (listed) {
    return listed;
  }
  const node = catalog?.nodes.find((item) => item.type === type);
  if (!node) {
    return undefined;
  }
  return {
    type: node.type,
    inputs: node.inputs ?? [],
    outputs: node.outputs ?? [],
    allowedWith: node.allowedWith ?? [],
    source: "catalog",
  };
}

function portsForNode(
  type: string,
  catalog?: WorkflowCatalog | null,
  entries: readonly ActionLibraryEntry[] = [],
): { inputs: CatalogPort[]; outputs: CatalogPort[] } {
  const entry = entryForType(type, entries, catalog);
  return {
    inputs: entry?.inputs ?? [],
    outputs: entry?.outputs ?? [],
  };
}

function paletteFromEntries(
  entries: readonly ActionLibraryEntry[] | undefined,
): PalettePorts[] | undefined {
  if (!entries?.length) {
    return undefined;
  }
  return entries.map((entry) => ({
    type: entry.type,
    inputs: entry.inputs ?? [],
    outputs: entry.outputs ?? [],
    requiredWith: entry.requiredWith,
  }));
}
