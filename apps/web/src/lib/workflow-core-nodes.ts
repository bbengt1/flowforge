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
  "flow.delay": "control",
  "data.set": "data",
  "data.map": "data",
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
