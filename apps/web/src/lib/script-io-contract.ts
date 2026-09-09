/**
 * Single retarget adapter for Chloe's E9.3 typed script I/O + recovery UI.
 * Until jonny posts the contract map, this uses the marked
 * `e93-contract-fallback` overlay on existing E9.1/E9.2 catalogs.
 *
 * Prefer:
 *   GET /scripts/catalog            additive `io` / `retry` / `errors[]`
 *   GET /ops-config/catalog         scriptEngine fallback
 *   GET /workflows/catalog          script.python / script.go bounds
 *   GET /executions/{id}            redacted result + `result.retry.allowed`
 *   POST /executions/{id}/retry     only when the contract allows
 *
 * Cookie session + `X-CSRF-Token`. JSON camelCase. RFC 9457.
 * Relates to #94 / Part of #91. Keep #94 open (jonny owns typed I/O
 * + recovery). Do not invent routes. Do not change `apps/api`.
 */

import { isSecretFieldName } from "./credential.ts";
import type { ExecutionStatus } from "./execution-types.ts";
import { isForbiddenYamlKey, looksLikeSecretValue } from "./workflow-yaml-nodes.ts";

export const SCRIPT_IO_STORY = 94;
export const SCRIPT_IO_EPIC = 91;
/** Jonny's E9.3 map is not on main yet. */
export const SCRIPT_IO_API_PR = 0;
export const SCRIPT_IO_ROUTE_MAP_SOURCE = "e93-contract-fallback" as const;

export const SCRIPT_PYTHON_IO_TYPE = "script.python" as const;
export const SCRIPT_GO_IO_TYPE = "script.go" as const;
export const SCRIPT_IO_ACTION_TYPES = [SCRIPT_PYTHON_IO_TYPE, SCRIPT_GO_IO_TYPE] as const;
export type ScriptIoActionType = (typeof SCRIPT_IO_ACTION_TYPES)[number];

export const SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS = 0;
export const SCRIPT_IO_MAX_RETRY_ATTEMPTS = 5;
export const SCRIPT_IO_MAX_INPUT_BYTES = 16 * 1024;
export const SCRIPT_IO_MAX_OUTPUT_BYTES = 16 * 1024;
export const SCRIPT_IO_MAX_SCHEMA_PROPERTIES = 32;
export const SCRIPT_IO_MAX_SCHEMA_DEPTH = 8;
export const SCRIPT_IO_MAX_AGGREGATION_ITEMS = 32;
export const SCRIPT_IO_MAX_OBJECT_FIELDS = 32;

export const SCRIPT_IO_SCHEMA_KEYWORDS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "maxLength",
  "maxItems",
  "maxProperties",
  "minimum",
  "maximum",
  "classification",
] as const;

export const SCRIPT_IO_SCHEMA_TYPES = [
  "object",
  "string",
  "integer",
  "boolean",
  "array",
  "number",
] as const;

export const SCRIPT_IO_CLASSIFICATIONS = ["public", "internal", "confidential"] as const;

export const SCRIPT_IO_HANDLE_KEYS = [
  "handle",
  "handles",
  "credentialHandle",
  "scopedHandle",
  "secretHandle",
  "secretRef",
  "secretRefs",
] as const;

export const SCRIPT_IO_CONTRACT_FALLBACK_HELP =
  "Using marked e93-contract-fallback typed I/O defaults because GET /scripts/catalog io / retry was unavailable. Inputs and outputs are the documented JSON Schema subset (16 KiB). Retries default to 0. Retry stays gated on result.retry.allowed. Secrets are scoped handles only — never YAML, schema, or logs.";

export const SCRIPT_IO_SCHEMA_HELP =
  "Declare inputSchema and outputSchema as the documented JSON Schema subset: type, properties, required, additionalProperties, items, enum, maxLength, maxItems, maxProperties, minimum, maximum, classification. Depth ≤ 8, ≤ 32 properties. No secrets or credential handles.";

export const SCRIPT_IO_SIZE_HELP =
  "Validated JSON must stay within catalog size bounds (default 16 KiB in and out). Tighten further with schema maxLength / maxItems / maxProperties. Oversized payloads are size-limit / output-too-large — never persisted.";

export const SCRIPT_IO_SECRET_SCHEMA_MESSAGE =
  "Secrets, tokens, keys, and credential handles cannot be embedded in inputSchema, outputSchema, or with. Runtime injects scoped handles only; they are never shown in YAML or logs.";

export const SCRIPT_IO_HANDLE_HELP =
  "Scoped credential handles are injected at runtime and redacted before persistence. This UI never displays handle values.";

export const SCRIPT_IO_RETRY_ZERO_MESSAGE =
  "Retries default to zero (first attempt only). A script is retry-safe only when it declares an idempotency key and verification behavior.";

export const SCRIPT_IO_RETRY_DENIED_MESSAGE =
  "retryPolicy.maxAttempts>0 requires retrySafe plus an idempotency key and verification. Otherwise POST …/retry returns retry-denied.";

export const SCRIPT_IO_NO_BLIND_RETRY_HELP =
  "This UI never offers a blind retry for script.python or script.go. Retry is shown only when result.retry.allowed is true (idempotency key + verification + remaining attempts). Lease loss stays indeterminate until safe verification.";

export const SCRIPT_IO_INDETERMINATE_HELP =
  "Indeterminate script outcome — lease lost after dispatch or verification could not confirm state. A side effect may have occurred. Do not assume the script did not run. Do not blindly re-run.";

export const SCRIPT_IO_VALIDATION_HELP =
  "Typed outputs must match the declared schema and size limit. Schema failures name field paths only and never echo secret content.";

export type ScriptIoCatalogSource =
  | "scripts-catalog"
  | "ops-config-catalog"
  | "workflow-catalog"
  | "contract-fallback";

export type ScriptIoErrorShape = {
  code: string;
  status: number;
  meaning: string;
};

export type ScriptIoBounds = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxSchemaProperties: number;
  maxSchemaDepth: number;
  maxAggregationItems: number;
};

export type ScriptIoUI = {
  indeterminateBadge: string;
  retryEnabledWhen: string;
  hideRetryWhen: string;
  neverAssumeAbsent: boolean;
  redactOutputs: boolean;
  handlesNeverShown: boolean;
};

export type ScriptIoRetry = {
  defaultMaxAttempts: number;
  maxAttempts: number;
  retrySafeDefault: false;
  blindRetry: false;
  leaseLossOutcome: string;
  unknownOutcome: string;
  requiresIdempotencyKey: boolean;
  requiresVerification: boolean;
  whenRetryAllowed: string;
  note: string;
};

export type ScriptIoCatalog = {
  source: ScriptIoCatalogSource;
  bounds: ScriptIoBounds;
  schemaKeywords: readonly string[];
  schemaTypes: readonly string[];
  secretClassificationDenied: boolean;
  handles: "scoped-only";
  retry: ScriptIoRetry;
  ui: ScriptIoUI;
  errors: ScriptIoErrorShape[];
  notes?: string;
};

export type ScriptIoRetryResult = {
  maxAttempts: number;
  executedAttempts: number;
  retrySafe: boolean;
  allowed: boolean;
  requiresVerification: boolean;
  verificationDeclared: boolean;
  idempotencyKeyDeclared: boolean;
  semantics: string;
  note: string;
  verificationOutcome?: string;
};

export type ScriptIoValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ScriptIoParsedResult = {
  ok?: boolean;
  redacted: true;
  output?: unknown;
  input?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  correlationId?: string;
  errorCode?: string;
  errorMessage?: string;
  validationErrors: ScriptIoValidationIssue[];
  retry: ScriptIoRetryResult | null;
  strippedHandleKeys: string[];
};

export const DEFAULT_SCRIPT_IO_BOUNDS: ScriptIoBounds = {
  maxInputBytes: SCRIPT_IO_MAX_INPUT_BYTES,
  maxOutputBytes: SCRIPT_IO_MAX_OUTPUT_BYTES,
  maxSchemaProperties: SCRIPT_IO_MAX_SCHEMA_PROPERTIES,
  maxSchemaDepth: SCRIPT_IO_MAX_SCHEMA_DEPTH,
  maxAggregationItems: SCRIPT_IO_MAX_AGGREGATION_ITEMS,
};

export const DEFAULT_SCRIPT_IO_UI: ScriptIoUI = {
  indeterminateBadge: "indeterminate",
  retryEnabledWhen:
    "Show Retry when result.retry.allowed is true (idempotency key + verification + remaining attempts). Hide Retry for non-retrySafe indeterminate.",
  hideRetryWhen: "indeterminate without retry.allowed, retry-denied, or maxAttempts=0",
  neverAssumeAbsent: true,
  redactOutputs: true,
  handlesNeverShown: true,
};

export const DEFAULT_SCRIPT_IO_RETRY: ScriptIoRetry = {
  defaultMaxAttempts: SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
  maxAttempts: SCRIPT_IO_MAX_RETRY_ATTEMPTS,
  retrySafeDefault: false,
  blindRetry: false,
  leaseLossOutcome: "indeterminate",
  unknownOutcome: "indeterminate",
  requiresIdempotencyKey: true,
  requiresVerification: true,
  whenRetryAllowed:
    "result.retry.allowed is true AND retrySafe AND idempotency key declared AND verification declared AND attempts remain AND prior status is failed, canceled, or indeterminate after verification",
  note: SCRIPT_IO_RETRY_ZERO_MESSAGE,
};

export const DEFAULT_SCRIPT_IO_ERRORS: ScriptIoErrorShape[] = [
  {
    code: "invalid-schema",
    status: 400,
    meaning: "inputSchema or outputSchema is not the documented JSON Schema subset, or a runtime value failed the declared schema.",
  },
  {
    code: "size-limit",
    status: 400,
    meaning: "Input, output, or declared schema exceeded the catalog size bound.",
  },
  {
    code: "output-too-large",
    status: 400,
    meaning: "Redacted output exceeded maxOutputBytes.",
  },
  {
    code: "secret-forbidden",
    status: 400,
    meaning: SCRIPT_IO_SECRET_SCHEMA_MESSAGE,
  },
  {
    code: "classification-denied",
    status: 400,
    meaning: "Secret classification and secret field names are denied on script I/O schemas and payloads.",
  },
  {
    code: "retry-denied",
    status: 409,
    meaning: SCRIPT_IO_RETRY_DENIED_MESSAGE,
  },
  {
    code: "indeterminate",
    status: 409,
    meaning: SCRIPT_IO_INDETERMINATE_HELP,
  },
  {
    code: "typed-io-not-implemented",
    status: 501,
    meaning: "E9.3 typed I/O execution is not enabled on this control plane. The UI still authors schemas and gates retry.",
  },
];

export const SCRIPT_IO_CONTRACT_FALLBACK_CATALOG: ScriptIoCatalog = {
  source: "contract-fallback",
  bounds: DEFAULT_SCRIPT_IO_BOUNDS,
  schemaKeywords: SCRIPT_IO_SCHEMA_KEYWORDS,
  schemaTypes: SCRIPT_IO_SCHEMA_TYPES,
  secretClassificationDenied: true,
  handles: "scoped-only",
  retry: DEFAULT_SCRIPT_IO_RETRY,
  ui: DEFAULT_SCRIPT_IO_UI,
  errors: DEFAULT_SCRIPT_IO_ERRORS,
  notes: SCRIPT_IO_CONTRACT_FALLBACK_HELP,
};

const SCHEMA_KEYWORD_SET = new Set<string>(SCRIPT_IO_SCHEMA_KEYWORDS);
const SCHEMA_TYPE_SET = new Set<string>(SCRIPT_IO_SCHEMA_TYPES);
const HANDLE_KEY_SET = new Set(
  SCRIPT_IO_HANDLE_KEYS.map((key) => key.toLowerCase()),
);

export function isScriptIoActionType(type: string | undefined): type is ScriptIoActionType {
  return (SCRIPT_IO_ACTION_TYPES as readonly string[]).includes((type ?? "").trim());
}

function isIndeterminateStatus(status?: string): boolean {
  return String(status ?? "").trim().toLowerCase() === "indeterminate";
}

export function scriptIoCatalog(
  catalog?: ScriptIoCatalog | null,
): ScriptIoCatalog {
  return catalog ?? SCRIPT_IO_CONTRACT_FALLBACK_CATALOG;
}

export function scriptIoBounds(catalog?: ScriptIoCatalog | null): ScriptIoBounds {
  return scriptIoCatalog(catalog).bounds;
}

export function defaultScriptIoSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

export function looksLikeScriptIoNameTypeStub(
  value: Record<string, unknown>,
): boolean {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  if (keys.some((key) => SCHEMA_KEYWORD_SET.has(key))) {
    return false;
  }
  return keys.every((key) => {
    const nested = value[key];
    return typeof nested === "string" && SCHEMA_TYPE_SET.has(nested);
  });
}

export function coerceScriptIoSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  if (looksLikeScriptIoNameTypeStub(rec)) {
    const properties: Record<string, unknown> = {};
    for (const [key, type] of Object.entries(rec)) {
      properties[key] = { type };
    }
    return {
      type: "object",
      additionalProperties: false,
      properties,
    };
  }
  return rec;
}

export function stringifyScriptIoSchema(value: unknown): string {
  const coerced = coerceScriptIoSchema(value);
  if (!coerced) {
    return "";
  }
  return `${JSON.stringify(coerced, null, 2)}\n`;
}

export function parseScriptIoSchemaText(text: string): {
  value?: Record<string, unknown>;
  error?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Schema must be a JSON object." };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "Schema must be valid JSON." };
  }
}

export function validateScriptIoSchema(
  name: string,
  value: unknown,
  catalog?: ScriptIoCatalog | null,
): string[] {
  if (value === undefined || value === "") {
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${name} must be a JSON Schema object.`];
  }
  const coerced = coerceScriptIoSchema(value);
  if (!coerced) {
    return [`${name} must be a JSON Schema object.`];
  }
  return validateSchemaShape(name, coerced, 0, scriptIoBounds(catalog));
}

export function patchScriptIoSchemaBounds(
  schema: Record<string, unknown> | undefined,
  patch: {
    maxLength?: number;
    maxItems?: number;
    maxProperties?: number;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...(schema && Object.keys(schema).length ? schema : defaultScriptIoSchema()),
  };
  if (patch.maxLength !== undefined) {
    next.maxLength = patch.maxLength;
  }
  if (patch.maxItems !== undefined) {
    next.maxItems = patch.maxItems;
  }
  if (patch.maxProperties !== undefined) {
    next.maxProperties = patch.maxProperties;
  }
  return next;
}

export function scriptIoSizeBoundsFromSchema(schema: unknown): {
  maxLength?: number;
  maxItems?: number;
  maxProperties?: number;
} {
  const rec = coerceScriptIoSchema(schema);
  if (!rec) {
    return {};
  }
  return {
    maxLength: finiteBound(rec.maxLength),
    maxItems: finiteBound(rec.maxItems),
    maxProperties: finiteBound(rec.maxProperties),
  };
}

export function validateScriptIoNodeExtras(
  withValue: Record<string, unknown>,
  catalog?: ScriptIoCatalog | null,
): string[] {
  const errors: string[] = [];
  errors.push(...validateScriptIoSchema("inputSchema", withValue.inputSchema, catalog));
  errors.push(...validateScriptIoSchema("outputSchema", withValue.outputSchema, catalog));
  const bounds = scriptIoBounds(catalog);
  const encodedInput = encodedJsonBytes(withValue.inputSchema);
  const encodedOutput = encodedJsonBytes(withValue.outputSchema);
  if (encodedInput > bounds.maxInputBytes) {
    errors.push(`inputSchema exceeds the ${bounds.maxInputBytes} byte size bound.`);
  }
  if (encodedOutput > bounds.maxOutputBytes) {
    errors.push(`outputSchema exceeds the ${bounds.maxOutputBytes} byte size bound.`);
  }
  return unique(errors);
}

/** Always false. Lease loss / unsafe script never invites a silent re-run. */
export function canBlindRetryScript(input: {
  status?: ExecutionStatus | string;
  nodeType?: string;
  errorCode?: string;
} = {}): false {
  void input;
  return false;
}

export function parseScriptIoRetryResult(
  ...bags: unknown[]
): ScriptIoRetryResult | null {
  for (const bag of bags) {
    const rec = asRecord(bag);
    const retry =
      asRecord(rec?.retry) ??
      asRecord(asRecord(rec?.result)?.retry) ??
      asRecord(asRecord(rec?.error)?.retry);
    if (!retry) {
      continue;
    }
    const verification = asRecord(retry.verification);
    return {
      maxAttempts: finiteInteger(retry.maxAttempts, SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS),
      executedAttempts: finiteInteger(retry.executedAttempts, 0),
      retrySafe: retry.retrySafe === true,
      allowed: retry.allowed === true,
      requiresVerification: retry.requiresVerification !== false,
      verificationDeclared: retry.verificationDeclared === true,
      idempotencyKeyDeclared:
        retry.idempotencyKeyDeclared === true ||
        Boolean(String(retry.idempotencyKey ?? "").trim()),
      semantics: String(retry.semantics ?? "").trim() || "E9.3",
      note: String(retry.note ?? "").trim(),
      verificationOutcome: String(verification?.outcome ?? retry.verificationOutcome ?? "")
        .trim() || undefined,
    };
  }
  return null;
}

export function scriptRetryAllowed(input: {
  output?: unknown;
  error?: unknown;
  input?: unknown;
}): boolean {
  return parseScriptIoRetryResult(input.output, input.error, input.input)?.allowed === true;
}

export function canOfferScriptRetry(input: {
  permissions?: readonly string[] | null;
  nodeType?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  input?: unknown;
}): boolean {
  if (input.permissions != null && !input.permissions.includes("workflow.execute")) {
    return false;
  }
  if (
    !isScriptIoActionType(input.nodeType) &&
    !parseScriptIoRetryResult(input.output, input.error)
  ) {
    return false;
  }
  return scriptRetryAllowed(input);
}

export function isScriptIoStep(step: {
  nodeType?: string;
  output?: unknown;
  input?: unknown;
  error?: unknown;
}): boolean {
  if (isScriptIoActionType(step.nodeType)) {
    return true;
  }
  const bag = mergeBags(asRecord(step.output), asRecord(step.input), asRecord(step.error));
  const type = String(bag?.type ?? bag?.nodeType ?? bag?.operation ?? "");
  return isScriptIoActionType(type);
}

export function executionHasScriptRun(
  steps: readonly {
    nodeType?: string;
    output?: unknown;
    input?: unknown;
    error?: unknown;
  }[] = [],
): boolean {
  return steps.some((step) => isScriptIoStep(step));
}

export function executionHasScriptIndeterminate(
  steps: readonly {
    status?: string;
    nodeType?: string;
    output?: unknown;
    input?: unknown;
    error?: unknown;
  }[] = [],
): boolean {
  return steps.some(
    (step) => isIndeterminateStatus(step.status) && isScriptIoStep(step),
  );
}

export function scriptIndeterminateCopy(input: {
  status?: string;
  nodeType?: string;
  errorCode?: string;
} = {}): string {
  void input;
  return SCRIPT_IO_INDETERMINATE_HELP;
}

export function scriptRetryBlockedMessage(input: {
  status?: string;
  nodeType?: string;
  output?: unknown;
  error?: unknown;
  catalog?: ScriptIoCatalog | null;
} = {}): string {
  const retry = parseScriptIoRetryResult(input.output, input.error);
  if (retry?.allowed) {
    return `${SCRIPT_IO_NO_BLIND_RETRY_HELP} result.retry.allowed is true — Retry queues a verify-first attempt.`;
  }
  if (isIndeterminateStatus(input.status)) {
    return `${SCRIPT_IO_INDETERMINATE_HELP} ${input.catalog?.ui.hideRetryWhen || DEFAULT_SCRIPT_IO_UI.hideRetryWhen}.`;
  }
  return SCRIPT_IO_NO_BLIND_RETRY_HELP;
}

export function parseScriptIoResult(
  ...bags: unknown[]
): ScriptIoParsedResult | null {
  const merged = mergeBags(...bags.map(asRecord));
  if (!merged) {
    return null;
  }
  const result = asRecord(merged.result) ?? merged;
  const error = asRecord(merged.error) ?? asRecord(result.error);
  const io = asRecord(result.io) ?? asRecord(merged.io);
  const validation =
    asRecord(result.validation) ??
    asRecord(merged.validation) ??
    asRecord(io?.validation);
  const strippedHandleKeys: string[] = [];
  const output = redactScriptIoValue(
    result.output ?? result.result ?? io?.output,
    strippedHandleKeys,
  );
  const input = redactScriptIoValue(
    result.input ?? merged.input ?? io?.input,
    strippedHandleKeys,
  );
  const retry = parseScriptIoRetryResult(result, merged, error);
  const validationErrors = collectValidationIssues(validation, error, io, result);
  const hasSignal =
    output !== undefined ||
    input !== undefined ||
    typeof result.stdout === "string" ||
    typeof result.stderr === "string" ||
    result.exitCode !== undefined ||
    Boolean(error) ||
    validationErrors.length > 0 ||
    Boolean(retry);
  if (!hasSignal) {
    return null;
  }
  return {
    ok: result.ok === true,
    redacted: true,
    output,
    input,
    stdout: typeof result.stdout === "string" ? result.stdout : undefined,
    stderr: typeof result.stderr === "string" ? result.stderr : undefined,
    exitCode: Number.isFinite(Number(result.exitCode))
      ? Number(result.exitCode)
      : undefined,
    correlationId: firstString(result.correlationId, merged.correlationId),
    errorCode: firstString(error?.code, result.code, io?.code),
    errorMessage: firstString(error?.message, error?.detail, result.detail),
    validationErrors,
    retry,
    strippedHandleKeys: unique(strippedHandleKeys),
  };
}

export function parseScriptIoCatalog(raw: unknown): ScriptIoCatalog {
  if (!raw || typeof raw !== "object") {
    return { ...SCRIPT_IO_CONTRACT_FALLBACK_CATALOG };
  }
  const rec = raw as Record<string, unknown>;
  const nested =
    rec.io && typeof rec.io === "object" && !Array.isArray(rec.io)
      ? (rec.io as Record<string, unknown>)
      : rec.scriptEngine &&
          typeof rec.scriptEngine === "object" &&
          !Array.isArray(rec.scriptEngine)
        ? (rec.scriptEngine as Record<string, unknown>)
        : rec;
  const ioRaw =
    nested.io && typeof nested.io === "object" && !Array.isArray(nested.io)
      ? (nested.io as Record<string, unknown>)
      : nested;
  const retryRaw =
    (nested.retry && typeof nested.retry === "object" && !Array.isArray(nested.retry)
      ? (nested.retry as Record<string, unknown>)
      : null) ??
    (rec.retry && typeof rec.retry === "object" && !Array.isArray(rec.retry)
      ? (rec.retry as Record<string, unknown>)
      : null);
  const boundsRaw =
    ioRaw.bounds && typeof ioRaw.bounds === "object" && !Array.isArray(ioRaw.bounds)
      ? (ioRaw.bounds as Record<string, unknown>)
      : ioRaw;
  const hasIoSignal =
    ioRaw.maxInputBytes !== undefined ||
    ioRaw.maxOutputBytes !== undefined ||
    boundsRaw.maxInputBytes !== undefined ||
    Array.isArray(ioRaw.schemaKeywords) ||
    retryRaw !== null;
  if (!hasIoSignal) {
    return { ...SCRIPT_IO_CONTRACT_FALLBACK_CATALOG };
  }
  const errorsRaw = Array.isArray(nested.errors)
    ? nested.errors
    : Array.isArray(rec.errors)
      ? rec.errors
      : [];
  const errors = errorsRaw
    .map(parseError)
    .filter((item): item is ScriptIoErrorShape => item !== null);
  const source: ScriptIoCatalogSource =
    rec.scriptEngine && typeof rec.scriptEngine === "object"
      ? "ops-config-catalog"
      : rec.io || rec.retry
        ? "scripts-catalog"
        : "contract-fallback";
  return {
    source,
    bounds: {
      maxInputBytes: finiteInteger(
        boundsRaw.maxInputBytes ?? ioRaw.maxInputBytes,
        SCRIPT_IO_MAX_INPUT_BYTES,
      ),
      maxOutputBytes: finiteInteger(
        boundsRaw.maxOutputBytes ?? ioRaw.maxOutputBytes,
        SCRIPT_IO_MAX_OUTPUT_BYTES,
      ),
      maxSchemaProperties: finiteInteger(
        boundsRaw.maxSchemaProperties ?? ioRaw.maxSchemaProperties,
        SCRIPT_IO_MAX_SCHEMA_PROPERTIES,
      ),
      maxSchemaDepth: finiteInteger(
        boundsRaw.maxSchemaDepth ?? ioRaw.maxSchemaDepth,
        SCRIPT_IO_MAX_SCHEMA_DEPTH,
      ),
      maxAggregationItems: finiteInteger(
        boundsRaw.maxAggregationItems ?? ioRaw.maxAggregationItems,
        SCRIPT_IO_MAX_AGGREGATION_ITEMS,
      ),
    },
    schemaKeywords: stringList(ioRaw.schemaKeywords).length
      ? stringList(ioRaw.schemaKeywords)
      : SCRIPT_IO_SCHEMA_KEYWORDS,
    schemaTypes: stringList(ioRaw.schemaTypes).length
      ? stringList(ioRaw.schemaTypes)
      : SCRIPT_IO_SCHEMA_TYPES,
    secretClassificationDenied: ioRaw.secretClassificationDenied !== false,
    handles: "scoped-only",
    retry: parseRetry(retryRaw),
    ui: parseUi(nested.ui ?? rec.ui ?? retryRaw?.ui),
    errors: errors.length ? errors : DEFAULT_SCRIPT_IO_ERRORS,
    notes:
      String(nested.notes ?? rec.notes ?? ioRaw.notes ?? "").trim() ||
      (source === "contract-fallback" ? SCRIPT_IO_CONTRACT_FALLBACK_HELP : undefined),
  };
}

export function isScriptIoHandleKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    HANDLE_KEY_SET.has(normalized) ||
    normalized.endsWith("handle") ||
    normalized.endsWith("handleref")
  );
}

export function redactScriptIoValue(
  value: unknown,
  strippedHandleKeys: string[] = [],
): unknown {
  return stripScriptIoSecrets(value, strippedHandleKeys);
}

function validateSchemaShape(
  path: string,
  schema: Record<string, unknown>,
  depth: number,
  bounds: ScriptIoBounds,
): string[] {
  if (depth > bounds.maxSchemaDepth) {
    return [`${path} exceeds the schema depth limit of ${bounds.maxSchemaDepth}.`];
  }
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORD_SET.has(key)) {
      errors.push(`${path} has unknown schema keyword ${key}.`);
      continue;
    }
    if (isForbiddenYamlKey(key) || isSecretFieldName(key) || isScriptIoHandleKey(key)) {
      errors.push(SCRIPT_IO_SECRET_SCHEMA_MESSAGE);
    }
  }
  if (schema.type !== undefined) {
    const type = String(schema.type);
    if (!SCHEMA_TYPE_SET.has(type)) {
      errors.push(
        `${path}.type must be object, string, integer, boolean, array, or number.`,
      );
    }
  }
  if (schema.classification !== undefined) {
    const classification = String(schema.classification);
    if (classification === "secret") {
      errors.push(`${path}.classification cannot be secret.`);
    } else if (
      !(SCRIPT_IO_CLASSIFICATIONS as readonly string[]).includes(classification)
    ) {
      errors.push(`${path}.classification must be public, internal, or confidential.`);
    }
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      errors.push(`${path}.properties must be an object.`);
    } else {
      const properties = schema.properties as Record<string, unknown>;
      if (Object.keys(properties).length > bounds.maxSchemaProperties) {
        errors.push(
          `${path}.properties exceeds the limit of ${bounds.maxSchemaProperties}.`,
        );
      }
      for (const [name, child] of Object.entries(properties)) {
        if (!name.trim() || isForbiddenYamlKey(name) || isSecretFieldName(name) || isScriptIoHandleKey(name)) {
          errors.push(SCRIPT_IO_SECRET_SCHEMA_MESSAGE);
          continue;
        }
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          errors.push(`${path}.properties.${name} must be a schema object.`);
          continue;
        }
        errors.push(
          ...validateSchemaShape(
            `${path}.properties.${name}`,
            child as Record<string, unknown>,
            depth + 1,
            bounds,
          ),
        );
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      errors.push(`${path}.required must be a list of property names.`);
    } else if (schema.required.length > bounds.maxSchemaProperties) {
      errors.push(
        `${path}.required exceeds the limit of ${bounds.maxSchemaProperties}.`,
      );
    } else {
      for (const item of schema.required) {
        if (typeof item !== "string" || !item.trim()) {
          errors.push(`${path}.required entries must be strings.`);
          continue;
        }
        if (isForbiddenYamlKey(item) || isSecretFieldName(item) || isScriptIoHandleKey(item)) {
          errors.push(SCRIPT_IO_SECRET_SCHEMA_MESSAGE);
        }
      }
    }
  }
  if (schema.items !== undefined) {
    if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items)) {
      errors.push(`${path}.items must be a schema object.`);
    } else {
      errors.push(
        ...validateSchemaShape(
          `${path}.items`,
          schema.items as Record<string, unknown>,
          depth + 1,
          bounds,
        ),
      );
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    errors.push(`${path}.additionalProperties must be a boolean.`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      errors.push(`${path}.enum must be a list.`);
    } else if (schema.enum.length > bounds.maxAggregationItems) {
      errors.push(
        `${path}.enum exceeds the limit of ${bounds.maxAggregationItems}.`,
      );
    } else {
      for (const item of schema.enum) {
        if (typeof item === "string" && looksLikeSecretValue(item)) {
          errors.push(SCRIPT_IO_SECRET_SCHEMA_MESSAGE);
        }
      }
    }
  }
  if (schema.maxLength !== undefined) {
    const maxLength = Number(schema.maxLength);
    if (!Number.isInteger(maxLength) || maxLength < 0 || maxLength > bounds.maxInputBytes) {
      errors.push(
        `${path}.maxLength must be between 0 and ${bounds.maxInputBytes}.`,
      );
    }
  }
  if (schema.maxItems !== undefined) {
    const maxItems = Number(schema.maxItems);
    if (
      !Number.isInteger(maxItems) ||
      maxItems < 0 ||
      maxItems > bounds.maxAggregationItems
    ) {
      errors.push(
        `${path}.maxItems must be between 0 and ${bounds.maxAggregationItems}.`,
      );
    }
  }
  if (schema.maxProperties !== undefined) {
    const maxProperties = Number(schema.maxProperties);
    if (
      !Number.isInteger(maxProperties) ||
      maxProperties < 0 ||
      maxProperties > SCRIPT_IO_MAX_OBJECT_FIELDS
    ) {
      errors.push(
        `${path}.maxProperties must be between 0 and ${SCRIPT_IO_MAX_OBJECT_FIELDS}.`,
      );
    }
  }
  if (schema.minimum !== undefined && !Number.isFinite(Number(schema.minimum))) {
    errors.push(`${path}.minimum must be a number.`);
  }
  if (schema.maximum !== undefined && !Number.isFinite(Number(schema.maximum))) {
    errors.push(`${path}.maximum must be a number.`);
  }
  return unique(errors);
}

function collectValidationIssues(
  ...bags: Array<Record<string, unknown> | null>
): ScriptIoValidationIssue[] {
  const out: ScriptIoValidationIssue[] = [];
  for (const bag of bags) {
    if (!bag) {
      continue;
    }
    const lists = [
      bag.errors,
      asRecord(bag.input)?.errors,
      asRecord(bag.output)?.errors,
      asRecord(bag.schema)?.errors,
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list) {
        const rec = asRecord(item);
        if (!rec) {
          if (typeof item === "string" && item.trim()) {
            out.push({ path: "", code: "invalid-schema", message: item.trim() });
          }
          continue;
        }
        const message = firstString(rec.message, rec.detail, rec.meaning);
        if (!message) {
          continue;
        }
        out.push({
          path: firstString(rec.path, rec.field) ?? "",
          code: firstString(rec.code) ?? "invalid-schema",
          message,
        });
      }
    }
    const code = firstString(bag.code);
    if (
      code === "invalid-schema" ||
      code === "size-limit" ||
      code === "output-too-large" ||
      code === "classification-denied" ||
      code === "secret-forbidden"
    ) {
      out.push({
        path: firstString(bag.path) ?? "",
        code,
        message:
          firstString(bag.message, bag.detail, bag.meaning) ??
          SCRIPT_IO_VALIDATION_HELP,
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.code}:${item.path}:${item.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripScriptIoSecrets(
  value: unknown,
  strippedHandleKeys: string[],
  path = "",
): unknown {
  return stripHandles(value, strippedHandleKeys, path);
}

function stripHandles(
  value: unknown,
  strippedHandleKeys: string[],
  path: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      stripHandles(item, strippedHandleKeys, path ? `${path}[${index}]` : `[${index}]`),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isScriptIoHandleKey(key) || isSecretFieldName(key) || isForbiddenYamlKey(key)) {
      strippedHandleKeys.push(childPath);
      continue;
    }
    out[key] = stripHandles(child, strippedHandleKeys, childPath);
  }
  return out;
}

function parseRetry(raw: Record<string, unknown> | null): ScriptIoRetry {
  if (!raw) {
    return { ...DEFAULT_SCRIPT_IO_RETRY };
  }
  return {
    defaultMaxAttempts: finiteInteger(
      raw.defaultMaxAttempts,
      SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
    ),
    maxAttempts: finiteInteger(raw.maxAttempts, SCRIPT_IO_MAX_RETRY_ATTEMPTS),
    retrySafeDefault: false,
    blindRetry: false,
    leaseLossOutcome: String(raw.leaseLossOutcome ?? "").trim() || "indeterminate",
    unknownOutcome: String(raw.unknownOutcome ?? "").trim() || "indeterminate",
    requiresIdempotencyKey: raw.requiresIdempotencyKey !== false,
    requiresVerification: raw.requiresVerification !== false,
    whenRetryAllowed:
      String(raw.whenRetryAllowed ?? "").trim() ||
      DEFAULT_SCRIPT_IO_RETRY.whenRetryAllowed,
    note: String(raw.note ?? "").trim() || SCRIPT_IO_RETRY_ZERO_MESSAGE,
  };
}

function parseUi(raw: unknown): ScriptIoUI {
  const rec = asRecord(raw);
  if (!rec) {
    return { ...DEFAULT_SCRIPT_IO_UI };
  }
  return {
    indeterminateBadge:
      String(rec.indeterminateBadge ?? "").trim() || DEFAULT_SCRIPT_IO_UI.indeterminateBadge,
    retryEnabledWhen:
      String(rec.retryEnabledWhen ?? "").trim() || DEFAULT_SCRIPT_IO_UI.retryEnabledWhen,
    hideRetryWhen:
      String(rec.hideRetryWhen ?? "").trim() || DEFAULT_SCRIPT_IO_UI.hideRetryWhen,
    neverAssumeAbsent: rec.neverAssumeAbsent !== false,
    redactOutputs: rec.redactOutputs !== false,
    handlesNeverShown: rec.handlesNeverShown !== false,
  };
}

function parseError(raw: unknown): ScriptIoErrorShape | null {
  const rec = asRecord(raw);
  const code = String(rec?.code ?? "").trim();
  if (!rec || !code) {
    return null;
  }
  return {
    code,
    status: Number.isFinite(Number(rec.status)) ? Number(rec.status) : 400,
    meaning: String(rec.meaning ?? rec.detail ?? "").trim(),
  };
}

function encodedJsonBytes(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function finiteBound(value: unknown): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function mergeBags(
  ...bags: Array<Record<string, unknown> | null>
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let found = false;
  for (const bag of bags) {
    if (!bag) {
      continue;
    }
    found = true;
    Object.assign(out, bag);
  }
  return found ? out : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
