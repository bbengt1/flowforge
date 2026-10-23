import {
  CATALOG_PHASE_CORE,
  type CatalogNode,
  type CatalogNodeBounds,
  type CatalogNodePolicy,
  type CatalogPort,
  type CatalogRedaction,
  type CatalogWithField,
  type WorkflowCatalog,
} from "./workflow-types.ts";

/** E3.3 + E3.4 placeable graph nodes. Triggers stay on spec.triggers, not this list. */
export const CORE_NEUTRAL_NODE_TYPES = [
  "flow.condition",
  "flow.switch",
  "flow.delay",
  "data.set",
  "data.map",
  "data.filter",
  "data.sort",
  "data.merge",
  "data.validate",
  "flow.stop",
  "flow.fail",
] as const;

export type CoreNeutralNodeType = (typeof CORE_NEUTRAL_NODE_TYPES)[number];

export type CoreNeutralFamily = "control" | "data" | "lifecycle";

export type CoreNeutralPaletteEntry = {
  type: CoreNeutralNodeType;
  name: string;
  description: string;
  phase: typeof CATALOG_PHASE_CORE;
  family: CoreNeutralFamily;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  requiredWith: string[];
  allowedWith: CatalogWithField[];
  policy: CatalogNodePolicy | null;
  bounds: CatalogNodeBounds | null;
  redaction: CatalogRedaction | null;
  /** `catalog` when GET /workflows/catalog listed the type with E3.3 fields. */
  source: "catalog" | "contract-fallback";
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

export const MAP_CONVERT_KINDS = ["string", "integer", "boolean", "object"] as const;

/** From jonny's E3.3 limits (`MaxDelaySeconds` = 7d). */
export const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

/** From jonny's E3.4 limits (`MaxSwitchCases` = 16). */
export const MAX_SWITCH_CASES = 16;

export const SORT_KEY_TYPES = ["string", "number", "timestamp"] as const;
export type SortKeyType = (typeof SORT_KEY_TYPES)[number];

export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const MERGE_MODES = ["append", "zip", "byKey"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

/** Synthetic onError: errorOutput port name (API ErrorPortName). */
export const ERROR_PORT_NAME = "error";

export const DEFAULT_CATALOG_RULES = {
  triggersAreWorkflowLevel: true,
  graphNodesExcludeTriggers: true,
  unsupportedPhasesRejected: true,
} as const;

const inherit = (name: string, kind: string, required: boolean, description: string): CatalogPort => ({
  name,
  kind,
  required,
  classification: "inherit",
  maxBytes: 16 * 1024,
  description,
});

const publicObject = (name: string, description: string): CatalogPort => ({
  name,
  kind: "object",
  classification: "public",
  maxBytes: 16 * 1024,
  description,
});

const defaultPolicy = (): CatalogNodePolicy => ({
  permissions: ["workflow.execute"],
  retrySafe: true,
  sideEffects: false,
  idempotent: true,
  cancellation: "path-local",
  verification: "none",
  defaultMaxAttempts: 1,
});

const defaultBounds = (maxDurationSeconds?: number): CatalogNodeBounds => ({
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxWithBytes: 16 * 1024,
  maxAggregationItems: 32,
  ...(maxDurationSeconds ? { maxDurationSeconds } : {}),
});

/**
 * Offline fallback copied from jonny's #32 contract
 * (`docs/reference/core-node-contracts.md` / `contract.go`).
 * Used only when GET /workflows/catalog is unavailable locally.
 */
const CONTRACT_FALLBACK: Record<CoreNeutralNodeType, CatalogNode> = {
  "flow.condition": {
    type: "flow.condition",
    phase: CATALOG_PHASE_CORE,
    title: "Condition",
    description:
      "Declarative comparison only. Routes the inbound value to true or false. No expression language.",
    inputs: [inherit("value", "any", true, "Value to compare.")],
    outputs: [
      inherit("true", "any", false, "Inbound value when the comparison is true."),
      inherit("false", "any", false, "Inbound value when the comparison is false."),
    ],
    requiredWith: ["op"],
    allowedWith: [
      {
        name: "op",
        kind: "enum",
        required: true,
        enum: [...CONDITION_OPS],
        description: "Declarative comparison operator.",
      },
      {
        name: "compare",
        kind: "any",
        description: "Literal compare value. Required except when op is exists.",
      },
      {
        name: "path",
        kind: "string",
        description: "Optional dotted identifier path into value. No expressions.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["op", "matched", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "flow.switch": {
    type: "flow.switch",
    phase: CATALOG_PHASE_CORE,
    title: "Switch",
    description:
      "Ordered declarative cases. The first matching case routes the inbound value to the output port named by that case; otherwise it goes to the default port. Exactly one port fires. Output ports are the case names plus default.",
    inputs: [inherit("value", "any", true, "Value to route.")],
    // Catalog lists outputs: []; ports come from with.cases + with.default (+ error when onError is errorOutput).
    outputs: [],
    requiredWith: ["cases", "default"],
    allowedWith: [
      {
        name: "path",
        kind: "string",
        description: "Optional dotted identifier path into value that every case compares. No expressions.",
      },
      {
        name: "cases",
        kind: "array",
        required: true,
        description: `1 to ${MAX_SWITCH_CASES} ordered {name, op, compare} cases. name is the output port; op is a flow.condition operator.`,
      },
      {
        name: "default",
        kind: "string",
        required: true,
        description: "Output port taken when no case matches. Required.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["port", "caseIndex", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "flow.delay": {
    type: "flow.delay",
    phase: CATALOG_PHASE_CORE,
    title: "Delay",
    description: "Computes a durable wake-up time from an ISO-8601 duration. Workers must not sleep.",
    inputs: [inherit("input", "any", false, "Optional passthrough payload.")],
    outputs: [inherit("result", "object", false, "Passthrough of input, or an empty object.")],
    requiredWith: ["duration"],
    allowedWith: [
      {
        name: "duration",
        kind: "duration",
        required: true,
        description: "ISO-8601 duration using weeks, days, and time units. Max P7D.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(MAX_DELAY_SECONDS),
    redaction: {
      auditFields: ["durationSeconds"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "data.set": {
    type: "data.set",
    phase: CATALOG_PHASE_CORE,
    title: "Set data",
    description: "Create a typed literal object. Schema-validated; public or internal fields only; no secrets.",
    inputs: [],
    outputs: [publicObject("result", "The constructed object.")],
    requiredWith: ["value"],
    allowedWith: [
      {
        name: "value",
        kind: "object",
        required: true,
        description: "Literal object. Secret keys and values are rejected.",
      },
      {
        name: "schema",
        kind: "schema",
        description: "Optional JSON-schema subset used to type and classify fields.",
      },
      {
        name: "classification",
        kind: "enum",
        enum: ["public", "internal"],
        description: "Default classification when schema does not set one.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["fieldCount", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "data.map": {
    type: "data.map",
    phase: CATALOG_PHASE_CORE,
    title: "Map data",
    description: "Declarative field mapping with optional type conversion. No general expression language.",
    inputs: [inherit("input", "object", true, "Object to map from.")],
    outputs: [
      inherit("result", "object", false, "Mapped object. Classification is preserved per field."),
    ],
    requiredWith: ["mapping"],
    allowedWith: [
      {
        name: "mapping",
        kind: "mapping",
        required: true,
        description: "dest.path -> source.path or {from, convert}.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["mappedFields", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "data.filter": {
    type: "data.filter",
    phase: CATALOG_PHASE_CORE,
    title: "Filter items",
    description:
      "Splits items into kept and dropped by a declarative comparison (path/op/compare) or an FFX boolean expression evaluated per item. Order is preserved. Both ports fire.",
    inputs: [inherit("input", "items", true, "Items as {items: [...]}; an object reads as one item.")],
    outputs: [
      inherit("kept", "items", false, "{items: [...]} that matched, in input order."),
      inherit("dropped", "items", false, "{items: [...]} that did not match, in input order."),
    ],
    requiredWith: [],
    allowedWith: [
      {
        name: "path",
        kind: "string",
        description: "Dotted identifier path into each item. No expressions.",
      },
      {
        name: "op",
        kind: "enum",
        enum: [...CONDITION_OPS],
        description: "Declarative comparison operator. Required unless expr is set.",
      },
      {
        name: "compare",
        kind: "any",
        description: "Literal compare value. Required except when op is exists.",
      },
      {
        name: "expr",
        kind: "expr",
        description: 'FFX boolean expression, as {expr: "..."}; item is the current item. Not combined with path, op or compare.',
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["inCount", "outCount", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "data.sort": {
    type: "data.sort",
    phase: CATALOG_PHASE_CORE,
    title: "Sort items",
    description:
      "Stable sort of items by one key. Every item must have the key and every key must have the same type; otherwise the step fails.",
    inputs: [inherit("input", "items", true, "Items as {items: [...]}; an object reads as one item.")],
    outputs: [inherit("result", "items", false, "{items: [...]} in sorted order. Equal keys keep input order.")],
    requiredWith: ["key"],
    allowedWith: [
      {
        name: "key",
        kind: "string",
        required: true,
        description: "Dotted identifier path to the sort key on each item.",
      },
      {
        name: "type",
        kind: "enum",
        enum: [...SORT_KEY_TYPES],
        description: "string, number or timestamp (RFC 3339). Default: the type of the first key, string or number.",
      },
      {
        name: "order",
        kind: "enum",
        enum: [...SORT_ORDERS],
        description: "asc (default) or desc.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["inCount", "outCount", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "data.merge": {
    type: "data.merge",
    phase: CATALOG_PHASE_CORE,
    title: "Merge items",
    description:
      "Combines left and right items. append: left then right. zip: pairwise, lists must be the same length. byKey: left order, each left item merged with the right item of the same key, then unmatched right items in order. On a field conflict the right value wins.",
    inputs: [
      inherit("left", "items", true, "Left items as {items: [...]}; an object reads as one item."),
      inherit("right", "items", true, "Right items as {items: [...]}; an object reads as one item."),
    ],
    outputs: [inherit("result", "items", false, "{items: [...]} merged.")],
    requiredWith: ["mode"],
    allowedWith: [
      {
        name: "mode",
        kind: "enum",
        required: true,
        enum: [...MERGE_MODES],
        description: "append, zip or byKey.",
      },
      {
        name: "key",
        kind: "string",
        description: "Dotted identifier path to the join key. Required for byKey only. Key values must be strings or numbers and unique per side.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["inCount", "outCount", "classification"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "data.validate": {
    type: "data.validate",
    phase: CATALOG_PHASE_CORE,
    title: "Validate data",
    description: "Validate a value against a declared schema. Errors name fields, never secret content.",
    inputs: [inherit("value", "any", true, "Value to validate.")],
    outputs: [inherit("result", "object", false, "The validated value.")],
    requiredWith: ["schema"],
    allowedWith: [
      {
        name: "schema",
        kind: "schema",
        required: true,
        description: "JSON-schema subset (type, properties, required, enum, bounds).",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["valid", "failedPaths"],
      redactInputs: true,
      redactOutputs: true,
      strategy: "mask-classified",
    },
  },
  "flow.stop": {
    type: "flow.stop",
    phase: CATALOG_PHASE_CORE,
    title: "Stop path",
    description: "End the current execution path only. Cannot stop another execution.",
    inputs: [inherit("input", "any", false, "Optional path payload. Not copied onto the result.")],
    outputs: [publicObject("result", "Safe {status, message} summary.")],
    requiredWith: [],
    allowedWith: [
      {
        name: "status",
        kind: "enum",
        enum: [...STOP_STATUSES],
        description: "success, failure, or canceled. Defaults to success.",
      },
      {
        name: "message",
        kind: "string",
        description: "Optional operator-safe message. Secrets and stack traces are rejected.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["status"],
      redactInputs: true,
      redactOutputs: false,
      strategy: "drop-secrets",
    },
  },
  "flow.fail": {
    type: "flow.fail",
    phase: CATALOG_PHASE_CORE,
    title: "Fail path",
    description:
      "End the current path with a safe operator-facing failure. Code and message must not expose internals.",
    inputs: [inherit("input", "any", false, "Optional path payload. Not copied onto the result.")],
    outputs: [publicObject("result", "Safe {status, code, message} summary.")],
    requiredWith: ["code"],
    allowedWith: [
      {
        name: "code",
        kind: "string",
        required: true,
        description: "Operator-facing failure code (DNS label or dotted token).",
      },
      {
        name: "message",
        kind: "string",
        description: "Optional safe message. Secrets and stack traces are rejected.",
      },
    ],
    policy: defaultPolicy(),
    bounds: defaultBounds(),
    redaction: {
      auditFields: ["status", "code"],
      redactInputs: true,
      redactOutputs: false,
      strategy: "drop-secrets",
    },
  },
};

const FAMILY_BY_TYPE: Record<CoreNeutralNodeType, CoreNeutralFamily> = {
  "flow.condition": "control",
  "flow.switch": "control",
  "flow.delay": "control",
  "data.set": "data",
  "data.map": "data",
  "data.filter": "data",
  "data.sort": "data",
  "data.merge": "data",
  "data.validate": "data",
  "flow.stop": "lifecycle",
  "flow.fail": "lifecycle",
};

export function isCoreNeutralNodeType(type: string): type is CoreNeutralNodeType {
  return (CORE_NEUTRAL_NODE_TYPES as readonly string[]).includes(type);
}

export function isConditionOp(value: string): value is ConditionOp {
  return (CONDITION_OPS as readonly string[]).includes(value);
}

export function isStopStatus(value: string): value is StopStatus {
  return (STOP_STATUSES as readonly string[]).includes(value);
}

export function catalogExcludesTriggerNodes(
  catalog: Pick<WorkflowCatalog, "rules"> | null | undefined,
): boolean {
  const rules = catalog?.rules;
  if (!rules) {
    return true;
  }
  return (
    rules.triggersAreWorkflowLevel !== false && rules.graphNodesExcludeTriggers !== false
  );
}

/** Action palette: phase core AND one of the E3.3/E3.4 neutral types. Triggers excluded. */
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

function hasE33Contract(node: CatalogNode | undefined): boolean {
  return Boolean(
    node &&
      ((node.allowedWith && node.allowedWith.length > 0) ||
        node.policy ||
        node.bounds ||
        node.redaction),
  );
}

function toPaletteEntry(
  type: CoreNeutralNodeType,
  fromApi: CatalogNode | undefined,
): CoreNeutralPaletteEntry {
  const fallback = CONTRACT_FALLBACK[type];
  const useCatalog = hasE33Contract(fromApi);
  const source = fromApi && useCatalog ? fromApi : fromApi ? { ...fallback, ...fromApi } : fallback;
  const node = useCatalog && fromApi ? fromApi : source;
  return {
    type,
    name: node.title || fallback.title || type,
    description: node.description || fallback.description || "",
    phase: CATALOG_PHASE_CORE,
    family: FAMILY_BY_TYPE[type],
    inputs: node.inputs && node.inputs.length > 0 ? node.inputs : fallback.inputs ?? [],
    outputs: node.outputs && node.outputs.length > 0 ? node.outputs : fallback.outputs ?? [],
    requiredWith:
      node.requiredWith && node.requiredWith.length > 0
        ? node.requiredWith
        : fallback.requiredWith ?? [],
    allowedWith:
      node.allowedWith && node.allowedWith.length > 0
        ? node.allowedWith
        : fallback.allowedWith ?? [],
    policy: node.policy ?? fallback.policy ?? null,
    bounds: node.bounds ?? fallback.bounds ?? null,
    redaction: node.redaction ?? fallback.redaction ?? null,
    source: fromApi && useCatalog ? "catalog" : "contract-fallback",
  };
}

/**
 * Build the placeable palette from GET /workflows/catalog.
 * Falls back to the published #32 contract only when the catalog is missing
 * or a node still lacks E3.3 fields (local without API).
 */
export function adaptCoreNeutralPalette(
  catalog: WorkflowCatalog | null | undefined,
): CoreNeutralPaletteEntry[] {
  const byType = new Map<string, CatalogNode>();
  for (const item of filterCoreNeutralNodes(catalog?.nodes)) {
    byType.set(item.type, item);
  }
  return CORE_NEUTRAL_NODE_TYPES.map((type) => toPaletteEntry(type, byType.get(type)));
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
      entry.description,
      entry.family,
      ...entry.requiredWith,
      ...entry.allowedWith.map((field) => field.name),
      ...entry.inputs.map((port) => `${port.name} ${port.classification ?? ""}`),
      ...entry.outputs.map((port) => `${port.name} ${port.classification ?? ""}`),
      ...(entry.policy?.permissions ?? []),
      entry.redaction?.strategy ?? "",
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
  return CONTRACT_FALLBACK[type].title ?? type;
}

export function formatPolicy(policy: CatalogNodePolicy | null): string {
  if (!policy) {
    return "";
  }
  const parts = [
    ...(policy.permissions ?? []),
    policy.retrySafe ? "retry-safe" : "not-retry-safe",
    policy.sideEffects ? "side-effects" : "no side-effects",
    policy.cancellation,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function formatRedaction(redaction: CatalogRedaction | null): string {
  if (!redaction) {
    return "";
  }
  const audit = redaction.auditFields?.length
    ? `audit ${redaction.auditFields.join(", ")}`
    : "";
  return [redaction.strategy, audit].filter(Boolean).join(" · ");
}

export function formatBounds(bounds: CatalogNodeBounds | null): string {
  if (!bounds) {
    return "";
  }
  const parts: string[] = [];
  if (bounds.maxInputBytes) {
    parts.push(`${bounds.maxInputBytes}B in`);
  }
  if (bounds.maxOutputBytes) {
    parts.push(`${bounds.maxOutputBytes}B out`);
  }
  if (bounds.maxDurationSeconds) {
    parts.push(`max duration ${bounds.maxDurationSeconds}s (P7D)`);
  }
  return parts.join(" · ");
}

export function formatPort(port: CatalogPort, direction: "in" | "out"): string {
  const bits = [
    `${direction}:${port.name}`,
    port.kind,
    port.classification,
    port.maxBytes ? `≤${port.maxBytes}B` : "",
  ].filter(Boolean);
  return bits.join(" ");
}

export function allowedWithNames(entry: CoreNeutralPaletteEntry): string[] {
  return entry.allowedWith.map((field) => field.name);
}


const SWITCH_CASE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_SWITCH_PORTS = new Set(["port", ERROR_PORT_NAME]);

export function isValidSwitchPortName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    SWITCH_CASE_NAME_RE.test(name) &&
    !RESERVED_SWITCH_PORTS.has(name) &&
    !name.startsWith("__ff_")
  );
}

/**
 * Output port names for a flow.switch instance: case names in order, then
 * with.default when set. Matches apps/api switchPortNames.
 */
export function switchOutputPortNames(withValue: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cases = withValue?.cases;
  if (Array.isArray(cases)) {
    for (const raw of cases) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const name = (raw as Record<string, unknown>).name;
      if (typeof name === "string" && name !== "" && isValidSwitchPortName(name) && !seen.has(name)) {
        out.push(name);
        seen.add(name);
      }
    }
  }
  const def = withValue?.default;
  if (typeof def === "string" && def !== "" && isValidSwitchPortName(def) && !seen.has(def)) {
    out.push(def);
    seen.add(def);
  }
  return out;
}

export function switchOutputPorts(withValue: Record<string, unknown> | null | undefined): CatalogPort[] {
  return switchOutputPortNames(withValue).map((name) =>
    inherit(name, "any", false, "Inbound value when this case is selected."),
  );
}

export function errorOutputPort(): CatalogPort {
  return publicObject(
    ERROR_PORT_NAME,
    "Redacted error for a failed step (onError: errorOutput).",
  );
}
