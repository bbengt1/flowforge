/**
 * Single retarget adapter for Chloe's E9.3 typed script I/O + recovery UI.
 * Wired to jonny's **#101** map on `main` (`e93-#101`).
 *
 * Prefer existing routes — do not invent any:
 *   GET /scripts/catalog            `io` / `retry.ui` / `retry.probe` / `errors[]`
 *   GET /workflows/catalog          script.python / script.go `allowedWith`
 *                                   / `policy.defaultMaxAttempts=0`
 *   POST /policy/evaluate           `retrySafe` / `retryAllowed` /
 *                                   `verificationDeclared` for script nodes
 *   GET /ops-config/catalog         scriptEngine fallback
 *   GET /executions/{id}            redacted result + `result.retry.allowed`
 *   POST /executions/{id}/retry     409 `retry-denied` when closed
 *
 * Cookie session + `X-CSRF-Token`. JSON camelCase. RFC 9457.
 * Relates to #94 / Part of #91. Keep #94 open (jonny owns typed I/O
 * + recovery). Do not change `apps/api`.
 */

import { isSecretFieldName } from "./credential.ts";
import type { ExecutionStatus } from "./execution-types.ts";
import { isForbiddenYamlKey, looksLikeSecretValue } from "./workflow-yaml-nodes.ts";

export const SCRIPT_IO_STORY = 94;
export const SCRIPT_IO_EPIC = 91;
/** Jonny's E9.3 typed I/O + recovery map on main. */
export const SCRIPT_IO_API_PR = 101;
export const SCRIPT_IO_ROUTE_MAP_SOURCE = "e93-#101" as const;

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
export const SCRIPT_IO_HANDLE_TTL_SECONDS = 60;
export const SCRIPT_IO_HANDLE_MAX_TTL_SECONDS = 300;
export const SCRIPT_IO_MAX_IDEMPOTENCY_KEY = 128;
export const SCRIPT_IO_RETRY_SAFE_FLAG = "retrySafe" as const;
export const SCRIPT_IO_SEMANTICS = "E9.3" as const;
export const SCRIPT_IO_VERIFICATION_FIELD = "verification" as const;
export const SCRIPT_IO_VERIFICATION_CONTRACT = "node-declared-idempotent-hook" as const;
export const SCRIPT_IO_VERIFICATION_BEHAVIOR = "declared-hook" as const;
export const SCRIPT_IO_VERIFY_ALREADY_APPLIED = "already-applied" as const;
export const SCRIPT_IO_VERIFY_SAFE_TO_RETRY = "safe-to-retry" as const;
export const SCRIPT_IO_VERIFY_INDETERMINATE = "indeterminate" as const;
export const SCRIPT_IO_VERIFY_OUTCOMES = [
  SCRIPT_IO_VERIFY_ALREADY_APPLIED,
  SCRIPT_IO_VERIFY_SAFE_TO_RETRY,
  SCRIPT_IO_VERIFY_INDETERMINATE,
] as const;
export const SCRIPT_IO_HANDLE_INJECTION = "scoped-short-lived" as const;
export const SCRIPT_IO_HANDLE_PUBLIC_KEYS = [
  "id",
  "credentialId",
  "workspaceId",
  "scopes",
  "expiresAt",
] as const;
export const SCRIPT_IO_ALLOWLISTED_ENV = [
  "FLOWFORGE_CORRELATION_ID",
  "FLOWFORGE_LANGUAGE",
  "FLOWFORGE_ENTRYPOINT",
  "FLOWFORGE_ARTIFACT_DIGEST",
  "FLOWFORGE_RUNTIME_PROFILE_ID",
  "FLOWFORGE_HANDLE_IDS",
  "FLOWFORGE_IDEMPOTENCY_KEY",
] as const;
export const SCRIPT_IO_FORBIDDEN_ENV = [
  "AWS_*",
  "KUBECONFIG",
  "DOCKER_*",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "CREDENTIAL",
  "PRIVATE_KEY",
] as const;
export const SCRIPT_IO_DEDICATED_WITH_FIELDS = [
  "inputSchema",
  "outputSchema",
  "retrySafe",
  "idempotencyKey",
  "verification",
  "retryPolicy",
] as const;
const SCRIPT_IO_IDEMPOTENCY_KEY_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

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
  "Using marked e93-#101 typed I/O defaults because GET /scripts/catalog io / retry.ui / retry.probe was unavailable. Inputs and outputs are the documented JSON Schema subset (16 KiB, validated before inject). Retries default to 0. retrySafe requires idempotencyKey plus verification.behavior=declared-hook. Retry stays gated on result.retry.allowed. POST …/retry is 409 retry-denied when closed. Secrets are scoped handles only (TTL 60s, max 5m) — never YAML, env, schema, logs, or audit.";

export const SCRIPT_IO_SCHEMA_HELP =
  "Declare inputSchema and outputSchema as the documented JSON Schema subset: type, properties, required, additionalProperties, items, enum, maxLength, maxItems, maxProperties, minimum, maximum, classification. Depth ≤ 8, ≤ 32 properties. No secrets or credential handles.";

export const SCRIPT_IO_SIZE_HELP =
  "Validated JSON must stay within catalog size bounds (default 16 KiB in and out). Tighten further with schema maxLength / maxItems / maxProperties. Oversized payloads are size-limit / output-too-large — never persisted.";

export const SCRIPT_IO_SECRET_SCHEMA_MESSAGE =
  "Secrets, tokens, keys, and credential handles cannot be embedded in inputSchema, outputSchema, or with. Runtime injects scoped handles only; they are never shown in YAML or logs.";

export const SCRIPT_IO_HANDLE_HELP =
  "Scoped credential handles are {id, credentialId?, workspaceId?, scopes, expiresAt} only (TTL 60s, max 5m). Plaintext never enters env, logs, job JSON, or audit. This UI never collects or displays handle secrets.";

export const SCRIPT_IO_ENV_HELP =
  "Runtime env is the catalog FLOWFORGE_* allowlist only: FLOWFORGE_CORRELATION_ID, FLOWFORGE_LANGUAGE, FLOWFORGE_ENTRYPOINT, FLOWFORGE_ARTIFACT_DIGEST, FLOWFORGE_RUNTIME_PROFILE_ID, FLOWFORGE_HANDLE_IDS, FLOWFORGE_IDEMPOTENCY_KEY. AWS_*, KUBECONFIG, DOCKER_*, and secret-named keys are env-denied.";

export const SCRIPT_IO_RETRY_ZERO_MESSAGE =
  "Retries default to zero (first attempt only). A script is retry-safe only when it declares retrySafe, an idempotencyKey, and verification.behavior=declared-hook.";

export const SCRIPT_IO_RETRY_DENIED_MESSAGE =
  "retryPolicy.maxAttempts>0 requires retrySafe plus an idempotency key and verification. Otherwise POST …/retry returns 409 retry-denied.";

export const SCRIPT_IO_INVALID_VERIFICATION_MESSAGE =
  "retrySafe=true requires idempotencyKey (1–128, letter-prefixed) and verification.behavior=declared-hook. Missing or invalid declaration is invalid-verification at validate/publish.";

export const SCRIPT_IO_NO_BLIND_RETRY_HELP =
  "This UI never offers a blind retry for script.python or script.go. Retry is shown only when result.retry.allowed is true (retrySafe + idempotencyKey + verification + remaining attempts). Lease loss stays indeterminate until the verification hook runs first. POST …/retry is 409 retry-denied when closed.";

export const SCRIPT_IO_INDETERMINATE_HELP =
  "Indeterminate script outcome — lease lost after dispatch or verification could not confirm state. A side effect may have occurred. Do not assume the script did not run. Verify first — never blindly re-run.";

export const SCRIPT_IO_IDEMPOTENCY_KEY_HELP =
  "Required when retrySafe. 1–128 identifier starting with a letter; letters, digits, and ._: - only.";

export const SCRIPT_IO_VERIFICATION_HELP =
  "declared-hook is an idempotent check of prior output / expect. onMatch defaults to already-applied (do not re-run). onMismatch defaults to safe-to-retry. onError stays indeterminate.";

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

export type ScriptIoRules = {
  maxInputBytes: number;
  maxOutputBytes: number;
  secretsForbidden: boolean;
  plaintextCredentials: false;
  handleInjection: string;
  handleTTLSeconds: number;
  handleMaxTTLSeconds: number;
  allowlistedEnv: readonly string[];
  forbiddenEnv: readonly string[];
  validateBeforeInject: boolean;
  redactBeforePersist: boolean;
  note: string;
};

export type ScriptIoUI = {
  indeterminateBadge: string;
  retrySafeFlag: string;
  retryEnabledWhen: string;
  hideRetryWhen: string;
  neverAssumeAbsent: boolean;
  redactOutputs: boolean;
  handlesNeverShown: boolean;
};

export type ScriptIoProbe = {
  requiredWhenRetrySafe: boolean;
  field: string;
  behavior: string;
  onMatchDefault: string;
  onMismatchDefault: string;
  onError: string;
  outcomes: readonly string[];
  note: string;
};

export type ScriptIoRetry = {
  defaultMaxAttempts: number;
  maxAttempts: number;
  retrySafeFlag: string;
  retrySafeDefault: false;
  idempotencyKey: string;
  semantics: string;
  blindRetry: false;
  leaseLossOutcome: string;
  unknownOutcome: string;
  requiresIdempotencyKey: boolean;
  requiresVerificationWhenRetrySafe: boolean;
  verification: string;
  whenRetryAllowed: string;
  note: string;
};

export type ScriptIoCatalog = {
  source: ScriptIoCatalogSource;
  io: ScriptIoRules;
  bounds: ScriptIoBounds;
  schemaKeywords: readonly string[];
  schemaTypes: readonly string[];
  secretClassificationDenied: boolean;
  handles: "scoped-only";
  retry: ScriptIoRetry;
  ui: ScriptIoUI;
  probe: ScriptIoProbe;
  errors: ScriptIoErrorShape[];
  notes?: string;
};

export type ScriptIoRetryPolicy = {
  maxAttempts: number;
};

export type ScriptIoVerificationSpec = {
  behavior: string;
  expect?: Record<string, unknown>;
  onMatch: string;
  onMismatch: string;
  onError: string;
};

export type ScriptIoEvaluateRetry = {
  nodeId: string;
  operation: string;
  retrySafe: boolean;
  retryMaxAttempts: number;
  retryAllowed: boolean;
  verificationDeclared: boolean;
};

export type ScriptIoRetryValidation = {
  ok: boolean;
  maxAttempts: number;
  retrySafe: boolean;
  idempotencyKey: string;
  idempotencyKeyDeclared: boolean;
  verificationDeclared: boolean;
  errors: string[];
  warnings: string[];
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

export const DEFAULT_SCRIPT_IO_RULES: ScriptIoRules = {
  maxInputBytes: SCRIPT_IO_MAX_INPUT_BYTES,
  maxOutputBytes: SCRIPT_IO_MAX_OUTPUT_BYTES,
  secretsForbidden: true,
  plaintextCredentials: false,
  handleInjection: SCRIPT_IO_HANDLE_INJECTION,
  handleTTLSeconds: SCRIPT_IO_HANDLE_TTL_SECONDS,
  handleMaxTTLSeconds: SCRIPT_IO_HANDLE_MAX_TTL_SECONDS,
  allowlistedEnv: SCRIPT_IO_ALLOWLISTED_ENV,
  forbiddenEnv: SCRIPT_IO_FORBIDDEN_ENV,
  validateBeforeInject: true,
  redactBeforePersist: true,
  note: "Inputs are validated against inputSchema and size limits before inject. Only scoped handle ids are injected. Outputs are schema/size checked and redacted before persist/audit.",
};

export const DEFAULT_SCRIPT_IO_UI: ScriptIoUI = {
  indeterminateBadge: "indeterminate",
  retrySafeFlag: SCRIPT_IO_RETRY_SAFE_FLAG,
  retryEnabledWhen:
    "Show Retry when result.retry.allowed is true (retrySafe + idempotencyKey + verification + remaining attempts). Disable/hide Retry for non-retrySafe indeterminate.",
  hideRetryWhen: "indeterminate without retry.allowed, retry-denied, or maxAttempts=0",
  neverAssumeAbsent: true,
  redactOutputs: true,
  handlesNeverShown: true,
};

export const DEFAULT_SCRIPT_IO_PROBE: ScriptIoProbe = {
  requiredWhenRetrySafe: true,
  field: SCRIPT_IO_VERIFICATION_FIELD,
  behavior: SCRIPT_IO_VERIFICATION_BEHAVIOR,
  onMatchDefault: SCRIPT_IO_VERIFY_ALREADY_APPLIED,
  onMismatchDefault: SCRIPT_IO_VERIFY_SAFE_TO_RETRY,
  onError: SCRIPT_IO_VERIFY_INDETERMINATE,
  outcomes: SCRIPT_IO_VERIFY_OUTCOMES,
  note: SCRIPT_IO_VERIFICATION_HELP,
};

export const DEFAULT_SCRIPT_IO_RETRY: ScriptIoRetry = {
  defaultMaxAttempts: SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS,
  maxAttempts: SCRIPT_IO_MAX_RETRY_ATTEMPTS,
  retrySafeFlag: SCRIPT_IO_RETRY_SAFE_FLAG,
  retrySafeDefault: false,
  idempotencyKey: "idempotencyKey",
  semantics: SCRIPT_IO_SEMANTICS,
  blindRetry: false,
  leaseLossOutcome: "indeterminate",
  unknownOutcome: "indeterminate",
  requiresIdempotencyKey: true,
  requiresVerificationWhenRetrySafe: true,
  verification: SCRIPT_IO_VERIFICATION_CONTRACT,
  whenRetryAllowed:
    "node retrySafe=true AND idempotencyKey is present AND verification.behavior is declared-hook AND retryPolicy.maxAttempts>0 AND attempts remain AND prior status is failed, canceled, or indeterminate after verification",
  note: SCRIPT_IO_RETRY_ZERO_MESSAGE,
};

export const DEFAULT_SCRIPT_IO_ERRORS: ScriptIoErrorShape[] = [
  {
    code: "invalid-schema",
    status: 400,
    meaning: "inputSchema or outputSchema is not the documented JSON Schema subset, or a runtime value failed the declared schema.",
  },
  {
    code: "secret-forbidden",
    status: 400,
    meaning: SCRIPT_IO_SECRET_SCHEMA_MESSAGE,
  },
  {
    code: "size-limit",
    status: 400,
    meaning: "Input, output, or declared schema exceeded the catalog 16 KiB size bound.",
  },
  {
    code: "input-rejected",
    status: 400,
    meaning: "Execution input failed schema, size, or secret checks before inject.",
  },
  {
    code: "output-too-large",
    status: 400,
    meaning: "Runner output exceeded the 16 KiB persist cap.",
  },
  {
    code: "handle-forbidden",
    status: 403,
    meaning: "Credential handle missing, expired, unscoped, or contained plaintext secrets. Handles only.",
  },
  {
    code: "env-denied",
    status: 403,
    meaning: "Runtime environment key is outside the FLOWFORGE_* allowlist, or plaintext credentials were supplied as env.",
  },
  {
    code: "retry-denied",
    status: 409,
    meaning: SCRIPT_IO_RETRY_DENIED_MESSAGE,
  },
  {
    code: "invalid-verification",
    status: 400,
    meaning: SCRIPT_IO_INVALID_VERIFICATION_MESSAGE,
  },
  {
    code: "indeterminate",
    status: 409,
    meaning: SCRIPT_IO_INDETERMINATE_HELP,
  },
];

export const SCRIPT_IO_CONTRACT_FALLBACK_CATALOG: ScriptIoCatalog = {
  source: "contract-fallback",
  io: DEFAULT_SCRIPT_IO_RULES,
  bounds: DEFAULT_SCRIPT_IO_BOUNDS,
  schemaKeywords: SCRIPT_IO_SCHEMA_KEYWORDS,
  schemaTypes: SCRIPT_IO_SCHEMA_TYPES,
  secretClassificationDenied: true,
  handles: "scoped-only",
  retry: DEFAULT_SCRIPT_IO_RETRY,
  ui: DEFAULT_SCRIPT_IO_UI,
  probe: DEFAULT_SCRIPT_IO_PROBE,
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
  errors.push(...validateScriptIoRetryDeclaration(withValue).errors);
  if (withValue.env !== undefined || withValue.environment !== undefined) {
    errors.push(SCRIPT_IO_ENV_HELP);
  }
  return unique(errors);
}

export function defaultScriptIoRetryPolicy(): ScriptIoRetryPolicy {
  return { maxAttempts: SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS };
}

export function defaultScriptIoVerification(): ScriptIoVerificationSpec {
  return {
    behavior: SCRIPT_IO_VERIFICATION_BEHAVIOR,
    onMatch: SCRIPT_IO_VERIFY_ALREADY_APPLIED,
    onMismatch: SCRIPT_IO_VERIFY_SAFE_TO_RETRY,
    onError: SCRIPT_IO_VERIFY_INDETERMINATE,
  };
}

export function isDedicatedScriptIoWithField(name: string): boolean {
  return (SCRIPT_IO_DEDICATED_WITH_FIELDS as readonly string[]).includes(name);
}

export function isAllowlistedScriptEnv(key: string): boolean {
  return (SCRIPT_IO_ALLOWLISTED_ENV as readonly string[]).includes(key.trim());
}

export function publicScriptHandle(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (!rec) {
    return null;
  }
  const id = String(rec.id ?? "").trim();
  if (!id) {
    return null;
  }
  const out: Record<string, unknown> = { id };
  if (typeof rec.credentialId === "string" && rec.credentialId.trim()) {
    out.credentialId = rec.credentialId.trim();
  }
  if (typeof rec.workspaceId === "string" && rec.workspaceId.trim()) {
    out.workspaceId = rec.workspaceId.trim();
  }
  if (Array.isArray(rec.scopes)) {
    out.scopes = rec.scopes
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof rec.expiresAt === "string" && rec.expiresAt.trim()) {
    out.expiresAt = rec.expiresAt.trim();
  }
  return out;
}

export function validateScriptIoRetryDeclaration(
  withValue: Record<string, unknown>,
): ScriptIoRetryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let retrySafe = false;
  if (withValue.retrySafe !== undefined) {
    if (typeof withValue.retrySafe !== "boolean") {
      errors.push("retrySafe must be a boolean.");
    } else {
      retrySafe = withValue.retrySafe;
    }
  }
  let idempotencyKey = "";
  if (withValue.idempotencyKey !== undefined && withValue.idempotencyKey !== null) {
    if (typeof withValue.idempotencyKey !== "string") {
      errors.push("idempotencyKey must be a string.");
    } else {
      idempotencyKey = withValue.idempotencyKey.trim();
      if (idempotencyKey && !SCRIPT_IO_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        errors.push(
          "idempotencyKey must be 1–128 letters, digits, or ._: - and start with a letter.",
        );
      }
    }
  }
  let verification: ScriptIoVerificationSpec | null = null;
  if (withValue.verification !== undefined && withValue.verification !== null) {
    const parsed = parseScriptIoVerification(withValue.verification);
    errors.push(...parsed.errors);
    verification = parsed.spec;
  }
  let maxAttempts = SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS;
  if (withValue.retryPolicy !== undefined && withValue.retryPolicy !== null) {
    if (!withValue.retryPolicy || typeof withValue.retryPolicy !== "object" || Array.isArray(withValue.retryPolicy)) {
      errors.push("retryPolicy must be an object.");
    } else {
      const policy = withValue.retryPolicy as Record<string, unknown>;
      if (policy.maxAttempts !== undefined) {
        const n = Number(policy.maxAttempts);
        if (!Number.isInteger(n) || n < 0 || n > SCRIPT_IO_MAX_RETRY_ATTEMPTS) {
          errors.push("retryPolicy.maxAttempts must be between 0 and 5.");
        } else {
          maxAttempts = n;
        }
      }
    }
  }
  if (retrySafe) {
    if (!idempotencyKey) {
      errors.push(SCRIPT_IO_INVALID_VERIFICATION_MESSAGE);
    }
    if (!verification) {
      errors.push(SCRIPT_IO_INVALID_VERIFICATION_MESSAGE);
    }
  } else if (verification || idempotencyKey) {
    errors.push("idempotencyKey and verification are only valid when retrySafe is true.");
  }
  if (maxAttempts > 0 && (!retrySafe || !idempotencyKey || !verification)) {
    errors.push(SCRIPT_IO_RETRY_DENIED_MESSAGE);
  }
  if (retrySafe && maxAttempts === 0) {
    warnings.push(SCRIPT_IO_RETRY_ZERO_MESSAGE);
  }
  return {
    ok: errors.length === 0,
    maxAttempts,
    retrySafe,
    idempotencyKey,
    idempotencyKeyDeclared: Boolean(idempotencyKey),
    verificationDeclared: verification !== null,
    errors: unique(errors),
    warnings,
  };
}

export function parseScriptIoVerification(raw: unknown): {
  spec: ScriptIoVerificationSpec | null;
  errors: string[];
} {
  const rec = asRecord(raw);
  if (!rec) {
    return { spec: null, errors: ["verification must be an object."] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(rec)) {
    if (key !== "behavior" && key !== "expect" && key !== "onMatch" && key !== "onMismatch" && key !== "onError") {
      errors.push(`unknown verification field ${key}.`);
    }
  }
  let behavior = String(rec.behavior ?? "").trim() || SCRIPT_IO_VERIFICATION_BEHAVIOR;
  if (behavior !== SCRIPT_IO_VERIFICATION_BEHAVIOR) {
    errors.push("verification.behavior must be declared-hook.");
    behavior = SCRIPT_IO_VERIFICATION_BEHAVIOR;
  }
  let expect: Record<string, unknown> | undefined;
  if (rec.expect !== undefined && rec.expect !== null) {
    if (!rec.expect || typeof rec.expect !== "object" || Array.isArray(rec.expect)) {
      errors.push("verification.expect must be an object.");
    } else {
      expect = rec.expect as Record<string, unknown>;
      for (const key of Object.keys(expect)) {
        if (isSecretFieldName(key) || isScriptIoHandleKey(key) || isForbiddenYamlKey(key)) {
          errors.push(SCRIPT_IO_SECRET_SCHEMA_MESSAGE);
        }
      }
    }
  }
  const onMatch = String(rec.onMatch ?? "").trim() || SCRIPT_IO_VERIFY_ALREADY_APPLIED;
  if (onMatch !== SCRIPT_IO_VERIFY_ALREADY_APPLIED && onMatch !== SCRIPT_IO_VERIFY_SAFE_TO_RETRY) {
    errors.push("verification.onMatch must be already-applied or safe-to-retry.");
  }
  const onMismatch = String(rec.onMismatch ?? "").trim() || SCRIPT_IO_VERIFY_SAFE_TO_RETRY;
  if (
    onMismatch !== SCRIPT_IO_VERIFY_ALREADY_APPLIED &&
    onMismatch !== SCRIPT_IO_VERIFY_SAFE_TO_RETRY &&
    onMismatch !== SCRIPT_IO_VERIFY_INDETERMINATE
  ) {
    errors.push("verification.onMismatch must be already-applied, safe-to-retry, or indeterminate.");
  }
  const onError = String(rec.onError ?? "").trim() || SCRIPT_IO_VERIFY_INDETERMINATE;
  if (onError !== SCRIPT_IO_VERIFY_INDETERMINATE) {
    errors.push("verification.onError must be indeterminate.");
  }
  return {
    spec: {
      behavior,
      expect,
      onMatch,
      onMismatch,
      onError,
    },
    errors,
  };
}

export function scriptIoRetryPolicyHint(input: {
  retrySafe: boolean;
  idempotencyKeyDeclared: boolean;
  verificationDeclared: boolean;
  maxAttempts?: number;
}): string {
  const attempts = input.maxAttempts ?? SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS;
  if (!input.retrySafe || !input.idempotencyKeyDeclared || !input.verificationDeclared) {
    return `${SCRIPT_IO_RETRY_ZERO_MESSAGE} ${SCRIPT_IO_RETRY_DENIED_MESSAGE}`;
  }
  if (attempts <= 0) {
    return SCRIPT_IO_RETRY_ZERO_MESSAGE;
  }
  return `retrySafe + idempotencyKey + declared-hook are set. maxAttempts=${attempts}. Retry still verifies first — never a blind re-run.`;
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

export function parseScriptEvaluateRetry(raw: unknown): ScriptIoEvaluateRetry[] {
  const rec = asRecord(raw);
  const operations = Array.isArray(rec?.operations)
    ? rec.operations
    : Array.isArray(raw)
      ? raw
      : [];
  const out: ScriptIoEvaluateRetry[] = [];
  for (const item of operations) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const operation = String(row.operation ?? "").trim();
    if (operation && !isScriptIoActionType(operation) && !operation.startsWith("script.")) {
      continue;
    }
    out.push({
      nodeId: String(row.nodeId ?? "").trim(),
      operation: operation || SCRIPT_PYTHON_IO_TYPE,
      retrySafe: row.retrySafe === true,
      retryMaxAttempts: finiteInteger(row.retryMaxAttempts, SCRIPT_IO_DEFAULT_RETRY_MAX_ATTEMPTS),
      retryAllowed: row.retryAllowed === true,
      verificationDeclared: row.verificationDeclared === true,
    });
  }
  return out;
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
    ioRaw.handleTTLSeconds !== undefined ||
    ioRaw.handleInjection !== undefined ||
    Array.isArray(ioRaw.allowlistedEnv) ||
    ioRaw.validateBeforeInject !== undefined ||
    ioRaw.redactBeforePersist !== undefined ||
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
  const io = parseIoRules(ioRaw, boundsRaw);
  const retry = parseRetry(retryRaw);
  const probe = parseProbe(retryRaw?.probe ?? nested.probe ?? rec.probe);
  return {
    source,
    io,
    bounds: {
      maxInputBytes: io.maxInputBytes,
      maxOutputBytes: io.maxOutputBytes,
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
    secretClassificationDenied:
      ioRaw.secretClassificationDenied !== false && io.secretsForbidden,
    handles: "scoped-only",
    retry,
    ui: parseUi(nested.ui ?? rec.ui ?? retryRaw?.ui),
    probe,
    errors: errors.length ? errors : DEFAULT_SCRIPT_IO_ERRORS,
    notes:
      String(nested.notes ?? rec.notes ?? ioRaw.note ?? ioRaw.notes ?? "").trim() ||
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
      code === "secret-forbidden" ||
      code === "input-rejected" ||
      code === "handle-forbidden" ||
      code === "env-denied" ||
      code === "invalid-verification" ||
      code === "retry-denied"
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
  const rec = value as Record<string, unknown>;
  if (looksLikePublicHandle(rec)) {
    const projected = publicScriptHandle(rec);
    if (projected) {
      return projected;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rec)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === "env" || key === "environment") {
      out[key] = redactScriptEnv(child, strippedHandleKeys, childPath);
      continue;
    }
    if (key === "handles" && Array.isArray(child)) {
      out[key] = child.map((item, index) => {
        const projected = publicScriptHandle(item);
        if (projected) {
          return projected;
        }
        strippedHandleKeys.push(`${childPath}[${index}]`);
        return null;
      }).filter(Boolean);
      continue;
    }
    if (isScriptIoHandleKey(key) || isSecretFieldName(key) || isForbiddenYamlKey(key)) {
      strippedHandleKeys.push(childPath);
      continue;
    }
    out[key] = stripHandles(child, strippedHandleKeys, childPath);
  }
  return out;
}

function looksLikePublicHandle(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (typeof value.id !== "string" || !value.id.trim()) {
    return false;
  }
  if (!(typeof value.expiresAt === "string" || Array.isArray(value.scopes))) {
    return false;
  }
  return keys.every((key) =>
    (SCRIPT_IO_HANDLE_PUBLIC_KEYS as readonly string[]).includes(key),
  );
}

function redactScriptEnv(
  value: unknown,
  strippedHandleKeys: string[],
  path: string,
): Record<string, string> {
  const rec = asRecord(value);
  const out: Record<string, string> = {};
  if (!rec) {
    return out;
  }
  for (const [key, child] of Object.entries(rec)) {
    if (!isAllowlistedScriptEnv(key) || typeof child !== "string") {
      strippedHandleKeys.push(path ? `${path}.${key}` : key);
      continue;
    }
    out[key] = child;
  }
  return out;
}

function parseIoRules(
  ioRaw: Record<string, unknown>,
  boundsRaw: Record<string, unknown>,
): ScriptIoRules {
  return {
    maxInputBytes: finiteInteger(
      boundsRaw.maxInputBytes ?? ioRaw.maxInputBytes,
      SCRIPT_IO_MAX_INPUT_BYTES,
    ),
    maxOutputBytes: finiteInteger(
      boundsRaw.maxOutputBytes ?? ioRaw.maxOutputBytes,
      SCRIPT_IO_MAX_OUTPUT_BYTES,
    ),
    secretsForbidden: ioRaw.secretsForbidden !== false,
    plaintextCredentials: false,
    handleInjection:
      String(ioRaw.handleInjection ?? "").trim() || SCRIPT_IO_HANDLE_INJECTION,
    handleTTLSeconds: finiteInteger(ioRaw.handleTTLSeconds, SCRIPT_IO_HANDLE_TTL_SECONDS),
    handleMaxTTLSeconds: finiteInteger(
      ioRaw.handleMaxTTLSeconds,
      SCRIPT_IO_HANDLE_MAX_TTL_SECONDS,
    ),
    allowlistedEnv: stringList(ioRaw.allowlistedEnv).length
      ? stringList(ioRaw.allowlistedEnv)
      : SCRIPT_IO_ALLOWLISTED_ENV,
    forbiddenEnv: stringList(ioRaw.forbiddenEnv).length
      ? stringList(ioRaw.forbiddenEnv)
      : SCRIPT_IO_FORBIDDEN_ENV,
    validateBeforeInject: ioRaw.validateBeforeInject !== false,
    redactBeforePersist: ioRaw.redactBeforePersist !== false,
    note:
      String(ioRaw.note ?? "").trim() || DEFAULT_SCRIPT_IO_RULES.note,
  };
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
    retrySafeFlag: String(raw.retrySafeFlag ?? "").trim() || SCRIPT_IO_RETRY_SAFE_FLAG,
    retrySafeDefault: false,
    idempotencyKey: String(raw.idempotencyKey ?? "").trim() || "idempotencyKey",
    semantics: String(raw.semantics ?? "").trim() || SCRIPT_IO_SEMANTICS,
    blindRetry: false,
    leaseLossOutcome: String(raw.leaseLossOutcome ?? "").trim() || "indeterminate",
    unknownOutcome: String(raw.unknownOutcome ?? "").trim() || "indeterminate",
    requiresIdempotencyKey: raw.requiresIdempotencyKey !== false,
    requiresVerificationWhenRetrySafe:
      raw.requiresVerificationWhenRetrySafe !== false &&
      raw.requiresVerification !== false,
    verification:
      String(raw.verification ?? "").trim() || SCRIPT_IO_VERIFICATION_CONTRACT,
    whenRetryAllowed:
      String(raw.whenRetryAllowed ?? "").trim() ||
      DEFAULT_SCRIPT_IO_RETRY.whenRetryAllowed,
    note: String(raw.note ?? "").trim() || SCRIPT_IO_RETRY_ZERO_MESSAGE,
  };
}

function parseProbe(raw: unknown): ScriptIoProbe {
  const rec = asRecord(raw);
  if (!rec) {
    return { ...DEFAULT_SCRIPT_IO_PROBE };
  }
  return {
    requiredWhenRetrySafe: rec.requiredWhenRetrySafe !== false,
    field: String(rec.field ?? "").trim() || SCRIPT_IO_VERIFICATION_FIELD,
    behavior: String(rec.behavior ?? "").trim() || SCRIPT_IO_VERIFICATION_BEHAVIOR,
    onMatchDefault:
      String(rec.onMatchDefault ?? "").trim() || SCRIPT_IO_VERIFY_ALREADY_APPLIED,
    onMismatchDefault:
      String(rec.onMismatchDefault ?? "").trim() || SCRIPT_IO_VERIFY_SAFE_TO_RETRY,
    onError: String(rec.onError ?? "").trim() || SCRIPT_IO_VERIFY_INDETERMINATE,
    outcomes: stringList(rec.outcomes).length
      ? stringList(rec.outcomes)
      : SCRIPT_IO_VERIFY_OUTCOMES,
    note: String(rec.note ?? "").trim() || SCRIPT_IO_VERIFICATION_HELP,
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
    retrySafeFlag: String(rec.retrySafeFlag ?? "").trim() || SCRIPT_IO_RETRY_SAFE_FLAG,
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
