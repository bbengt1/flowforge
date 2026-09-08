import {
  CATALOG_PHASE_CORE,
  type CatalogNode,
  type CatalogPort,
  type WorkflowCatalog,
} from "./workflow-types.ts";

/** E3.3 placeable graph nodes. Triggers stay on spec.triggers, not this list. */
export const CORE_NEUTRAL_NODE_TYPES = [
  "flow.condition",
  "flow.delay",
  "data.set",
  "data.map",
  "data.validate",
  "flow.stop",
  "flow.fail",
] as const;

export type CoreNeutralNodeType = (typeof CORE_NEUTRAL_NODE_TYPES)[number];

export type CoreNeutralFamily = "control" | "data" | "lifecycle";

export type CoreNeutralPaletteEntry = {
  type: CoreNeutralNodeType;
  name: string;
  phase: typeof CATALOG_PHASE_CORE;
  family: CoreNeutralFamily;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  requiredWith: string[];
  policy: string;
  redaction: string;
  classification: string;
  /** `catalog` when GET /workflows/catalog listed the type as phase: core. */
  source: "catalog" | "documented-mirror";
};

export const CONDITION_OPS = [
  "eq",
  "ne",
  "gt",
  "lt",
  "gte",
  "lte",
  "exists",
  "contains",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export const STOP_STATUSES = ["success", "failure", "canceled"] as const;

export type StopStatus = (typeof STOP_STATUSES)[number];

type DocumentedCoreNode = {
  type: CoreNeutralNodeType;
  name: string;
  family: CoreNeutralFamily;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  requiredWith: string[];
  policy: string;
  redaction: string;
  classification: string;
};

/**
 * Documented E3.3 contracts from docs/reference/action-catalog.md plus the
 * E3.1 catalog ports/requiredWith jonny already exposes.
 *
 * TODO(jonny): when GET /workflows/catalog grows name/policy/redaction/
 * classification (and richer with-schema), prefer those fields and shrink
 * this mirror to defaults only.
 */
export const DOCUMENTED_CORE_NEUTRAL_NODES: readonly DocumentedCoreNode[] = [
  {
    type: "flow.condition",
    name: "Condition",
    family: "control",
    inputs: [{ name: "value", kind: "any", required: true }],
    outputs: [
      { name: "true", kind: "any" },
      { name: "false", kind: "any" },
    ],
    requiredWith: ["op"],
    policy: "Declarative comparison only; no arbitrary expression evaluation.",
    redaction: "Compare literals and field paths only; never secret handles.",
    classification: "Preserves the inbound value classification on both ports.",
  },
  {
    type: "flow.delay",
    name: "Delay",
    family: "control",
    inputs: [{ name: "input", kind: "any" }],
    outputs: [{ name: "result", kind: "object" }],
    requiredWith: ["duration"],
    policy: "Durable ISO-8601 wake-up; no worker sleeps or in-memory timers.",
    redaction: "Duration and safe passthrough only.",
    classification: "Non-sensitive timing metadata; payload classification unchanged.",
  },
  {
    type: "data.set",
    name: "Set data",
    family: "data",
    inputs: [],
    outputs: [{ name: "result", kind: "object" }],
    requiredWith: ["value"],
    policy: "Schema-validated literal object; unknown fields fail closed.",
    redaction: "No secrets, credential keys, or secret-shaped values in YAML.",
    classification: "Fields must be non-sensitive; denied keys/values are rejected.",
  },
  {
    type: "data.map",
    name: "Map fields",
    family: "data",
    inputs: [{ name: "input", kind: "object", required: true }],
    outputs: [{ name: "result", kind: "object" }],
    requiredWith: ["mapping"],
    policy: "Explicit field paths and type conversions only; no expression language.",
    redaction: "Paths and safe converted values; classification follows the source field.",
    classification: "Sensitive source fields stay classified after mapping.",
  },
  {
    type: "data.validate",
    name: "Validate data",
    family: "data",
    inputs: [{ name: "value", kind: "any", required: true }],
    outputs: [{ name: "result", kind: "object" }],
    requiredWith: ["schema"],
    policy: "Validate against a declared schema reference.",
    redaction: "Safe field errors identify paths, not secret content.",
    classification: "Does not downgrade inbound classification.",
  },
  {
    type: "flow.stop",
    name: "Stop path",
    family: "lifecycle",
    inputs: [{ name: "input", kind: "any" }],
    outputs: [{ name: "result", kind: "object" }],
    requiredWith: [],
    policy: "Ends the current path with success, failure, or canceled. Not a remote stop.",
    redaction: "Status/code/message must stay operator-safe.",
    classification: "Terminal metadata only; no payload export of secrets.",
  },
  {
    type: "flow.fail",
    name: "Fail path",
    family: "lifecycle",
    inputs: [{ name: "input", kind: "any" }],
    outputs: [{ name: "result", kind: "object" }],
    requiredWith: [],
    policy: "Ends the current path with a safe operator-facing failure.",
    redaction: "Error code/message must not expose internals or secrets.",
    classification: "Failure metadata is non-sensitive by construction.",
  },
];

const DOCUMENTED_BY_TYPE = new Map(
  DOCUMENTED_CORE_NEUTRAL_NODES.map((item) => [item.type, item]),
);

export function isCoreNeutralNodeType(type: string): type is CoreNeutralNodeType {
  return (CORE_NEUTRAL_NODE_TYPES as readonly string[]).includes(type);
}

export function isConditionOp(value: string): value is ConditionOp {
  return (CONDITION_OPS as readonly string[]).includes(value);
}

export function isStopStatus(value: string): value is StopStatus {
  return (STOP_STATUSES as readonly string[]).includes(value);
}

/** Action palette: phase core AND one of the seven E3.3 types. Triggers excluded. */
export function filterCoreNeutralNodes(nodes: CatalogNode[] | undefined | null): CatalogNode[] {
  return (nodes ?? []).filter(
    (item) => item.phase === CATALOG_PHASE_CORE && isCoreNeutralNodeType(item.type),
  );
}

export function catalogHasNonNeutralCore(
  catalog: Pick<WorkflowCatalog, "nodes">,
): boolean {
  return (catalog.nodes ?? []).some(
    (item) => item.phase === CATALOG_PHASE_CORE && !isCoreNeutralNodeType(item.type),
  );
}

function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function mergePorts(
  fromCatalog: CatalogPort[] | undefined,
  documented: CatalogPort[],
): CatalogPort[] {
  if (fromCatalog && fromCatalog.length > 0) {
    return fromCatalog;
  }
  return documented;
}

/**
 * Build the placeable palette from GET /workflows/catalog when present,
 * falling back to the documented action-catalog mirror so the UI ships
 * before jonny's richer E3.3 catalog fields land.
 */
export function adaptCoreNeutralPalette(
  catalog: WorkflowCatalog | null | undefined,
): CoreNeutralPaletteEntry[] {
  const byType = new Map<string, CatalogNode>();
  for (const item of filterCoreNeutralNodes(catalog?.nodes)) {
    byType.set(item.type, item);
  }

  return DOCUMENTED_CORE_NEUTRAL_NODES.map((documented) => {
    const fromApi = byType.get(documented.type);
    return {
      type: documented.type,
      name: firstString(fromApi?.name, documented.name),
      phase: CATALOG_PHASE_CORE,
      family: documented.family,
      inputs: mergePorts(fromApi?.inputs, documented.inputs),
      outputs: mergePorts(fromApi?.outputs, documented.outputs),
      requiredWith:
        fromApi?.requiredWith && fromApi.requiredWith.length > 0
          ? fromApi.requiredWith
          : documented.requiredWith,
      policy: firstString(fromApi?.policy, documented.policy),
      redaction: firstString(fromApi?.redaction, documented.redaction),
      classification: firstString(fromApi?.classification, documented.classification),
      source: fromApi ? "catalog" : "documented-mirror",
    };
  });
}

export function filterPaletteEntries(
  entries: CoreNeutralPaletteEntry[],
  query: string,
): CoreNeutralPaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return entries;
  }
  return entries.filter((entry) => {
    const haystack = [
      entry.type,
      entry.name,
      entry.family,
      entry.policy,
      ...entry.requiredWith,
      ...entry.inputs.map((port) => port.name),
      ...entry.outputs.map((port) => port.name),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function familyLabel(family: CoreNeutralFamily): string {
  if (family === "control") {
    return "Control flow";
  }
  if (family === "data") {
    return "Data";
  }
  return "Lifecycle";
}

export function defaultNodeName(type: CoreNeutralNodeType): string {
  return DOCUMENTED_BY_TYPE.get(type)?.name ?? type;
}

export function defaultRequiredWith(type: CoreNeutralNodeType): string[] {
  return DOCUMENTED_BY_TYPE.get(type)?.requiredWith ?? [];
}
