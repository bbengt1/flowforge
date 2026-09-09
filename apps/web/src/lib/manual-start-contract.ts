/**
 * Single retarget adapter for Chloe's E10.1 authenticated manual-start UI.
 * Wired to jonny's **#111** map on `main` (`e10-#111`).
 *
 * Prefer existing routes — do not invent `POST /executions`:
 *   POST /workflows/{id}/executions
 *     `{workflowVersionId, idempotencyKey, input}`
 *     + `Idempotency-Key` header OK
 *     Cookie session + `X-CSRF-Token`. 201 new / 200 replayed /
 *     400 draft or bad input / 403 authz or policy deny /
 *     409 fingerprint mismatch or approval-required.
 *   GET  /workflows/catalog → `triggers[type=manual].start`
 *   GET  /workflows/{id}/versions (published only)
 *   POST /policy/evaluate
 *
 * Cookie + CSRF. camelCase JSON. RFC 9457.
 * Relates to #106 / Part of #105. Keep #106 open (jonny owns start
 * APIs). Do not change `apps/api`.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import {
  EXECUTION_PROBLEM_CODES,
  IDEMPOTENCY_CREATED_MESSAGE,
  IDEMPOTENCY_REPLAY_MESSAGE,
  PRE_RUN_PUBLISHED_ONLY_HELP,
  workflowExecutionsCollectionPath,
} from "./execution-contract.ts";
import { canStartPublishedRun, publishedRunVersions } from "./execution-replay.ts";
import { isSecretFieldName, stripSecretFields } from "./execution.ts";
import type { ProblemDetails } from "./problem.ts";
import { isCsrfProblem, isUnauthenticatedProblem } from "./session.ts";
import {
  SCRIPT_IO_MAX_INPUT_BYTES,
  coerceScriptIoSchema,
} from "./script-io-contract.ts";
import { executionStartBody } from "./workflow.ts";
import type {
  CatalogTriggerStart,
  StartExecutionBody,
  WorkflowCatalog,
  WorkflowVersion,
} from "./workflow-types.ts";
import { listYamlTriggers } from "./workflow-yaml-nodes.ts";
import { canExecuteWorkflows } from "./workspace-nav.ts";

export const MANUAL_START_STORY = 106;
export const MANUAL_START_EPIC = 105;
/** Jonny's E10.1 start map on main. */
export const MANUAL_START_API_PR = 111;
export const MANUAL_START_ROUTE_MAP_SOURCE = "e10-#111" as const;
export const MANUAL_START_SEMANTICS = "E10.1" as const;

export const MANUAL_START_PERMISSION = "workflow.execute" as const;
export const MANUAL_START_MAX_INPUT_BYTES = SCRIPT_IO_MAX_INPUT_BYTES;
export const MANUAL_START_MAX_IDEMPOTENCY_KEY = 128;
export const MANUAL_START_QUERY = "start";
export const MANUAL_TRIGGER_TYPE = "manual";
export const MANUAL_START_IDEMPOTENCY_HEADER = "Idempotency-Key" as const;
export const MANUAL_START_AUDIT_ACTION = "execution.start" as const;

/** #111 catalog `idempotencyKeyPattern`. */
export const MANUAL_START_IDEMPOTENCY_KEY_RE =
  /^[A-Za-z0-9._~:-]{1,128}$/;

export const MANUAL_START_PROBLEM_CODES = {
  ...EXECUTION_PROBLEM_CODES,
  invalidRequest: "invalid-request",
} as const;

export const MANUAL_START_CONTRACT_FALLBACK_HELP =
  "Using marked e10-#111 start defaults because GET /workflows/catalog triggers[type=manual].start was unavailable. Prefer existing POST /workflows/{id}/executions {workflowVersionId, idempotencyKey, input} plus Idempotency-Key with cookie session + X-CSRF-Token. HTTP 201 is a new run; 200 replays the same (workspace, workflow version, idempotency key); 400 is a draft or bad/oversized input; 403 is missing workflow.execute or policy deny; 409 is a fingerprint mismatch or approval-required. Drafts never run. Do not invent POST /executions.";

export const MANUAL_START_CATALOG_HELP =
  "Start follows jonny's #111 catalog map (e10-#111): GET /workflows/catalog triggers[type=manual].start. POST /workflows/{id}/executions {workflowVersionId, idempotencyKey, input} plus Idempotency-Key. Cookie session + X-CSRF-Token. 201 new / 200 replayed / 400 draft or bad input / 403 authz or policy deny / 409 fingerprint mismatch or approval-required. Do not invent POST /executions.";

export const MANUAL_START_PUBLISHED_ONLY_HELP = PRE_RUN_PUBLISHED_ONLY_HELP;

export const MANUAL_START_INPUT_HELP =
  "Typed start input comes from the published version's manual trigger schema (JSON Schema subset: schema / inputSchema / with.schema / with.inputSchema). Values are bounded (16 KiB), secret field names are stripped, and extra keys are rejected when additionalProperties is false. The body always includes input (empty object when none).";

export const MANUAL_START_IDEMPOTENCY_HELP =
  "Required. This UI generates a key (1–128, [A-Za-z0-9._~:-]) and sends it in the body and the Idempotency-Key header. Same key + same input returns the original run (200). Same key + different input is 409 fingerprint mismatch.";

export const MANUAL_START_FORBIDDEN_MESSAGE =
  "Start requires workflow.execute. HTTP 403 is fail-closed (missing permission or policy deny). This UI does not treat a run as started.";

export const MANUAL_START_UNAUTHENTICATED_MESSAGE =
  "Session is missing or stale (HTTP 401). Start is fail-closed; sign in again. This UI does not treat a run as started.";

export const MANUAL_START_CSRF_HELP =
  "Start sends X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const MANUAL_START_AUDIT_HELP =
  "Audit action execution.start is secret-free: actor, published workflowVersionId, digest, correlation, outcome, and idempotency key. Input is redacted; secrets are stripped before display and POST.";

export const MANUAL_START_CONFIRM_HELP =
  "Review the published version digest, typed input, and idempotency key before starting. The confirmation below is the secret-free record audit action execution.start will keep.";

export const MANUAL_START_BAD_INPUT_MESSAGE =
  "HTTP 400: drafts cannot run, or the start body/input is invalid or exceeds 16 KiB.";

export const MANUAL_START_CREATED_MESSAGE = IDEMPOTENCY_CREATED_MESSAGE;
export const MANUAL_START_REPLAY_MESSAGE = IDEMPOTENCY_REPLAY_MESSAGE;
export const MANUAL_START_CONFLICT_MESSAGE =
  "HTTP 409: this idempotency key was already used with a different input (fingerprint mismatch), or this start requires approval. The API did not start a new run.";

export const DEFAULT_MANUAL_START_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

/** Documented #111 `triggers[type=manual].start` when catalog is missing. */
export const MANUAL_START_DEFAULT_START = {
  route: "POST /api/v1/workflows/{workflowId}/executions",
  method: "POST",
  permission: MANUAL_START_PERMISSION,
  csrf: true,
  publishedVersionRequired: true,
  versionField: "workflowVersionId",
  inputField: "input",
  schemaFields: [
    "schema",
    "inputSchema",
    "with.schema",
    "with.inputSchema",
  ],
  idempotencyKeyField: "idempotencyKey",
  idempotencyHeader: MANUAL_START_IDEMPOTENCY_HEADER,
  idempotencyKeyRequired: true,
  idempotencyKeyPattern: "^[A-Za-z0-9._~:-]{1,128}$",
  maxInputBytes: MANUAL_START_MAX_INPUT_BYTES,
  createdStatus: 201,
  replayStatus: 200,
  conflictStatus: 409,
  policyDenyStatus: 403,
  approvalRequiredStatus: 409,
  draftStatus: 400,
  help: MANUAL_START_CATALOG_HELP,
} as const;

export type ManualStartRouteMapSource = typeof MANUAL_START_ROUTE_MAP_SOURCE;
export type ManualStartCatalogSource = "workflows-catalog" | "catalog-fallback";

export type ManualStartResolved = {
  source: ManualStartCatalogSource;
  start: {
    route: string;
    method: string;
    permission: string;
    csrf: boolean;
    publishedVersionRequired: boolean;
    versionField: string;
    inputField: string;
    schemaFields: string[];
    idempotencyKeyField: string;
    idempotencyHeader: string;
    idempotencyKeyRequired: boolean;
    idempotencyKeyPattern: string;
    maxInputBytes: number;
    createdStatus: number;
    replayStatus: number;
    conflictStatus: number;
    policyDenyStatus: number;
    approvalRequiredStatus: number;
    draftStatus: number;
    help: string;
  };
};

export function resolveManualStartContract(
  catalog?: WorkflowCatalog | null,
): ManualStartResolved {
  const listed = catalog?.triggers?.find((item) => item.type === MANUAL_TRIGGER_TYPE)
    ?.start;
  if (!listed) {
    return {
      source: "catalog-fallback",
      start: {
        ...MANUAL_START_DEFAULT_START,
        schemaFields: [...MANUAL_START_DEFAULT_START.schemaFields],
      },
    };
  }
  return {
    source: "workflows-catalog",
    start: mergeCatalogStart(listed),
  };
}

function mergeCatalogStart(listed: CatalogTriggerStart): ManualStartResolved["start"] {
  const defaults = MANUAL_START_DEFAULT_START;
  return {
    route: stringOr(listed.route, defaults.route),
    method: stringOr(listed.method, defaults.method),
    permission: stringOr(listed.permission, defaults.permission),
    csrf: typeof listed.csrf === "boolean" ? listed.csrf : defaults.csrf,
    publishedVersionRequired:
      typeof listed.publishedVersionRequired === "boolean"
        ? listed.publishedVersionRequired
        : defaults.publishedVersionRequired,
    versionField: stringOr(listed.versionField, defaults.versionField),
    inputField: stringOr(listed.inputField, defaults.inputField),
    schemaFields:
      Array.isArray(listed.schemaFields) && listed.schemaFields.length > 0
        ? listed.schemaFields.filter((item): item is string => typeof item === "string")
        : [...defaults.schemaFields],
    idempotencyKeyField: stringOr(
      listed.idempotencyKeyField,
      defaults.idempotencyKeyField,
    ),
    idempotencyHeader: stringOr(
      listed.idempotencyHeader,
      defaults.idempotencyHeader,
    ),
    idempotencyKeyRequired:
      typeof listed.idempotencyKeyRequired === "boolean"
        ? listed.idempotencyKeyRequired
        : defaults.idempotencyKeyRequired,
    idempotencyKeyPattern: stringOr(
      listed.idempotencyKeyPattern,
      defaults.idempotencyKeyPattern,
    ),
    maxInputBytes:
      typeof listed.maxInputBytes === "number" && listed.maxInputBytes > 0
        ? listed.maxInputBytes
        : defaults.maxInputBytes,
    createdStatus: statusOr(listed.createdStatus, defaults.createdStatus),
    replayStatus: statusOr(listed.replayStatus, defaults.replayStatus),
    conflictStatus: statusOr(listed.conflictStatus, defaults.conflictStatus),
    policyDenyStatus: statusOr(listed.policyDenyStatus, defaults.policyDenyStatus),
    approvalRequiredStatus: statusOr(
      listed.approvalRequiredStatus,
      defaults.approvalRequiredStatus,
    ),
    draftStatus: statusOr(listed.draftStatus, defaults.draftStatus),
    help: stringOr(listed.help, defaults.help),
  };
}

function stringOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || fallback;
}

function statusOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && value >= 200 && value < 600 ? value : fallback;
}

export function manualStartHelp(catalog?: WorkflowCatalog | null): string {
  const resolved = resolveManualStartContract(catalog);
  return resolved.source === "catalog-fallback"
    ? MANUAL_START_CONTRACT_FALLBACK_HELP
    : resolved.start.help || MANUAL_START_CATALOG_HELP;
}

export function compileManualStartIdempotencyKeyRe(
  catalog?: WorkflowCatalog | null,
): RegExp {
  const pattern = resolveManualStartContract(catalog).start.idempotencyKeyPattern;
  try {
    return new RegExp(pattern);
  } catch {
    return MANUAL_START_IDEMPOTENCY_KEY_RE;
  }
}

export type ManualStartInputField = {
  name: string;
  type: "string" | "integer" | "number" | "boolean";
  required: boolean;
  enum?: string[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
};

export type ManualStartInputSchema = {
  source: "version-yaml" | "contract-fallback";
  schema: Record<string, unknown>;
  fields: ManualStartInputField[];
  additionalProperties: boolean;
  triggerId: string;
  triggerType: string;
};

export type ManualStartConfirmation = {
  workflowVersionId: string;
  versionLabel: string;
  digest: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  inputText: string;
  strippedKeys: string[];
  permission: string;
  route: string;
  routeMapSource: ManualStartRouteMapSource;
  catalogSource: ManualStartCatalogSource;
  auditHelp: string;
};

export type ManualStartRequestResult = {
  ok: boolean;
  body: StartExecutionBody | null;
  errors: string[];
  schema: ManualStartInputSchema;
  idempotencyKey: string;
  confirmation: ManualStartConfirmation | null;
  authClosed: boolean;
  reason: string;
};

export function manualStartPath(workflowId: string): string {
  return workflowExecutionsCollectionPath(workflowId);
}

export function manualStartHref(workflowId: string): string {
  const id = workflowId.trim();
  if (!isResourceId(id)) {
    return `/workflows?${MANUAL_START_QUERY}=1`;
  }
  return `/workflows?${MANUAL_START_QUERY}=${encodeURIComponent(id)}`;
}

export function editorManualStartHref(workflowId: string): string {
  const id = workflowId.trim();
  return isResourceId(id) ? `/workflows/${id}` : "/workflows";
}

export function generateManualStartIdempotencyKey(
  now = Date.now(),
  random = randomToken,
): string {
  const token = random().replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "key";
  const stamp = now.toString(36);
  return `m-${stamp}-${token}`.slice(0, MANUAL_START_MAX_IDEMPOTENCY_KEY);
}

function randomToken(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return Math.random().toString(36).slice(2, 12);
}

export function normalizeManualStartIdempotencyKey(
  value: string | null | undefined,
  catalog?: WorkflowCatalog | null,
): { ok: boolean; key: string; error: string } {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    const generated = generateManualStartIdempotencyKey();
    return { ok: true, key: generated, error: "" };
  }
  const pattern = compileManualStartIdempotencyKeyRe(catalog);
  if (!pattern.test(trimmed) || trimmed.length > MANUAL_START_MAX_IDEMPOTENCY_KEY) {
    return {
      ok: false,
      key: "",
      error:
        "Idempotency key must be 1–128 characters: letters, digits, or . _ ~ : -.",
    };
  }
  return { ok: true, key: trimmed.slice(0, MANUAL_START_MAX_IDEMPOTENCY_KEY), error: "" };
}

export function canOfferManualStart(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canExecuteWorkflows(permissions);
}

function encodedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function schemaType(value: unknown): ManualStartInputField["type"] {
  const folded = String(value ?? "string").trim().toLowerCase();
  if (folded === "integer") {
    return "integer";
  }
  if (folded === "number") {
    return "number";
  }
  if (folded === "boolean") {
    return "boolean";
  }
  return "string";
}

function finiteBound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function typedFieldsFromSchema(
  schema: Record<string, unknown>,
): ManualStartInputField[] {
  const properties = asObject(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const fields: ManualStartInputField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (isSecretFieldName(name)) {
      continue;
    }
    const prop = asObject(raw) ?? { type: typeof raw === "string" ? raw : "string" };
    const enums = Array.isArray(prop.enum)
      ? prop.enum.filter((item): item is string => typeof item === "string")
      : undefined;
    fields.push({
      name,
      type: schemaType(prop.type),
      required: required.has(name),
      ...(enums && enums.length ? { enum: enums } : {}),
      ...(finiteBound(prop.maxLength) !== undefined
        ? { maxLength: finiteBound(prop.maxLength) }
        : {}),
      ...(finiteBound(prop.minimum) !== undefined
        ? { minimum: finiteBound(prop.minimum) }
        : {}),
      ...(finiteBound(prop.maximum) !== undefined
        ? { maximum: finiteBound(prop.maximum) }
        : {}),
      ...(typeof prop.description === "string" && prop.description.trim()
        ? { description: prop.description.trim() }
        : {}),
    });
  }
  return fields;
}

export function extractManualStartSchema(
  yaml: string | null | undefined,
): ManualStartInputSchema {
  const triggers = yaml?.trim() ? listYamlTriggers(yaml) : [];
  const manual =
    triggers.find((item) => item.type === MANUAL_TRIGGER_TYPE) ?? triggers[0];
  const raw =
    manual?.schema ??
    manual?.inputSchema ??
    asObject(manual?.with.schema) ??
    asObject(manual?.with.inputSchema);
  const coerced = coerceScriptIoSchema(raw);
  if (!coerced) {
    return {
      source: "contract-fallback",
      schema: { ...DEFAULT_MANUAL_START_SCHEMA },
      fields: [],
      additionalProperties: true,
      triggerId: manual?.id || MANUAL_TRIGGER_TYPE,
      triggerType: manual?.type || MANUAL_TRIGGER_TYPE,
    };
  }
  const sanitized = omitSecretSchemaProperties(coerced);
  return {
    source: "version-yaml",
    schema: sanitized,
    fields: typedFieldsFromSchema(sanitized),
    additionalProperties: sanitized.additionalProperties !== false,
    triggerId: manual?.id || MANUAL_TRIGGER_TYPE,
    triggerType: manual?.type || MANUAL_TRIGGER_TYPE,
  };
}

function omitSecretSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = asObject(schema.properties);
  if (!properties) {
    return schema;
  }
  const nextProps: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!isSecretFieldName(name)) {
      nextProps[name] = value;
    }
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (item): item is string => typeof item === "string" && !isSecretFieldName(item),
      )
    : undefined;
  return {
    ...schema,
    properties: nextProps,
    ...(required ? { required } : {}),
  };
}

export function parseManualStartInputText(text: string): {
  ok: boolean;
  value?: Record<string, unknown>;
  error: string;
  strippedKeys: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, value: {}, error: "", strippedKeys: [] };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Start input must be a JSON object.",
        strippedKeys: [],
      };
    }
    const strippedKeys: string[] = [];
    const cleaned = stripSecretFields(parsed, strippedKeys) as Record<string, unknown>;
    return { ok: true, value: cleaned, error: "", strippedKeys };
  } catch {
    return {
      ok: false,
      error: "Start input is not valid JSON.",
      strippedKeys: [],
    };
  }
}

export function coerceManualStartFieldValue(
  field: ManualStartInputField,
  raw: string,
): { ok: boolean; value?: unknown; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (field.required) {
      return { ok: false, error: `${field.name} is required.`, value: undefined };
    }
    return { ok: true, error: "" };
  }
  if (field.type === "boolean") {
    if (trimmed === "true" || trimmed === "1") {
      return { ok: true, value: true, error: "" };
    }
    if (trimmed === "false" || trimmed === "0") {
      return { ok: true, value: false, error: "" };
    }
    return { ok: false, error: `${field.name} must be true or false.`, value: undefined };
  }
  if (field.type === "integer" || field.type === "number") {
    const parsed = field.type === "integer" ? Number.parseInt(trimmed, 10) : Number(trimmed);
    if (!Number.isFinite(parsed) || (field.type === "integer" && !Number.isInteger(parsed))) {
      return {
        ok: false,
        error: `${field.name} must be a ${field.type}.`,
        value: undefined,
      };
    }
    if (field.minimum !== undefined && parsed < field.minimum) {
      return { ok: false, error: `${field.name} is below the minimum.`, value: undefined };
    }
    if (field.maximum !== undefined && parsed > field.maximum) {
      return { ok: false, error: `${field.name} is above the maximum.`, value: undefined };
    }
    return { ok: true, value: parsed, error: "" };
  }
  if (field.enum && !field.enum.includes(trimmed)) {
    return {
      ok: false,
      error: `${field.name} must be one of: ${field.enum.join(", ")}.`,
      value: undefined,
    };
  }
  if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
    return {
      ok: false,
      error: `${field.name} exceeds maxLength ${field.maxLength}.`,
      value: undefined,
    };
  }
  return { ok: true, value: trimmed, error: "" };
}

export function inputFromTypedFields(
  fields: readonly ManualStartInputField[],
  values: Record<string, string>,
): { ok: boolean; value: Record<string, unknown>; errors: string[] } {
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const field of fields) {
    const coerced = coerceManualStartFieldValue(field, values[field.name] ?? "");
    if (!coerced.ok) {
      errors.push(coerced.error);
      continue;
    }
    if (coerced.value !== undefined) {
      out[field.name] = coerced.value;
    }
  }
  return { ok: errors.length === 0, value: out, errors };
}

function validateValueAgainstSchema(
  input: Record<string, unknown>,
  schema: ManualStartInputSchema,
): string[] {
  const errors: string[] = [];
  const properties = asObject(schema.schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.schema.required)
      ? schema.schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  for (const name of required) {
    if (input[name] === undefined || input[name] === "") {
      errors.push(`${name} is required.`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (isSecretFieldName(key)) {
      errors.push(`${key} is a secret field and cannot be sent as start input.`);
      continue;
    }
    const declared = properties[key];
    if (!declared && !schema.additionalProperties) {
      errors.push(`${key} is not declared on the published input schema.`);
      continue;
    }
    const field = schema.fields.find((item) => item.name === key);
    if (field && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      const coerced = coerceManualStartFieldValue(field, String(value));
      if (!coerced.ok) {
        errors.push(coerced.error);
      }
    }
  }
  return unique(errors);
}

export function validateManualStartInput(
  input: Record<string, unknown>,
  schema: ManualStartInputSchema,
  catalog?: WorkflowCatalog | null,
): string[] {
  const errors = validateValueAgainstSchema(input, schema);
  const maxBytes = resolveManualStartContract(catalog).start.maxInputBytes;
  if (encodedJsonBytes(input) > maxBytes) {
    errors.push(`Start input exceeds the ${maxBytes} byte size bound.`);
  }
  return unique(errors);
}

export function redactedInputText(input: Record<string, unknown>): string {
  const strippedKeys: string[] = [];
  const cleaned = stripSecretFields(input, strippedKeys) as Record<string, unknown>;
  return JSON.stringify(cleaned, null, 2);
}

export function buildManualStartConfirmation(input: {
  version: Pick<WorkflowVersion, "id" | "versionNumber" | "digest">;
  idempotencyKey: string;
  input: Record<string, unknown>;
  strippedKeys?: string[];
  catalog?: WorkflowCatalog | null;
}): ManualStartConfirmation {
  const cleanedKeys: string[] = [...(input.strippedKeys ?? [])];
  const cleaned = stripSecretFields(input.input, cleanedKeys) as Record<string, unknown>;
  const resolved = resolveManualStartContract(input.catalog);
  return {
    workflowVersionId: input.version.id,
    versionLabel: `v${input.version.versionNumber}`,
    digest: input.version.digest,
    idempotencyKey: input.idempotencyKey,
    input: cleaned,
    inputText: JSON.stringify(cleaned, null, 2),
    strippedKeys: unique(cleanedKeys),
    permission: resolved.start.permission,
    route: "POST /workflows/{id}/executions",
    routeMapSource: MANUAL_START_ROUTE_MAP_SOURCE,
    catalogSource: resolved.source,
    auditHelp: MANUAL_START_AUDIT_HELP,
  };
}

export function buildManualStartRequest(input: {
  versions: WorkflowVersion[];
  selectedVersionId: string;
  yaml?: string | null;
  fieldValues?: Record<string, string>;
  jsonText?: string;
  idempotencyKey?: string;
  permissions?: readonly string[] | null;
  catalog?: WorkflowCatalog | null;
}): ManualStartRequestResult {
  const schema = extractManualStartSchema(input.yaml);
  const emptyConfirmation = null;
  if (
    input.permissions !== undefined &&
    !canOfferManualStart(input.permissions)
  ) {
    return {
      ok: false,
      body: null,
      errors: [MANUAL_START_FORBIDDEN_MESSAGE],
      schema,
      idempotencyKey: "",
      confirmation: emptyConfirmation,
      authClosed: true,
      reason: MANUAL_START_FORBIDDEN_MESSAGE,
    };
  }
  const published = canStartPublishedRun({
    versions: input.versions,
    selectedVersionId: input.selectedVersionId,
  });
  if (!published.ok || !published.body) {
    return {
      ok: false,
      body: null,
      errors: [published.reason || MANUAL_START_PUBLISHED_ONLY_HELP],
      schema,
      idempotencyKey: "",
      confirmation: emptyConfirmation,
      authClosed: false,
      reason: published.reason || MANUAL_START_PUBLISHED_ONLY_HELP,
    };
  }
  const key = normalizeManualStartIdempotencyKey(
    input.idempotencyKey,
    input.catalog,
  );
  if (!key.ok) {
    return {
      ok: false,
      body: null,
      errors: [key.error],
      schema,
      idempotencyKey: "",
      confirmation: emptyConfirmation,
      authClosed: false,
      reason: key.error,
    };
  }
  let parsed: Record<string, unknown> = {};
  const errors: string[] = [];
  if (schema.fields.length > 0 && input.fieldValues) {
    const fromFields = inputFromTypedFields(schema.fields, input.fieldValues);
    errors.push(...fromFields.errors);
    parsed = fromFields.value;
  } else if (input.jsonText !== undefined) {
    const fromJson = parseManualStartInputText(input.jsonText);
    if (!fromJson.ok) {
      errors.push(fromJson.error);
    } else {
      parsed = fromJson.value ?? {};
    }
  }
  errors.push(...validateManualStartInput(parsed, schema, input.catalog));
  const uniqueErrors = unique(errors);
  if (uniqueErrors.length > 0) {
    return {
      ok: false,
      body: null,
      errors: uniqueErrors,
      schema,
      idempotencyKey: key.key,
      confirmation: emptyConfirmation,
      authClosed: false,
      reason: uniqueErrors[0] ?? "Invalid start input.",
    };
  }
  const extras = {
    idempotencyKey: key.key,
    input: parsed,
  };
  const body = executionStartBody(published.body.workflowVersionId, extras);
  const version = publishedRunVersions(input.versions).find(
    (item) => item.id === published.body?.workflowVersionId,
  );
  if (!body || !version) {
    return {
      ok: false,
      body: null,
      errors: [MANUAL_START_PUBLISHED_ONLY_HELP],
      schema,
      idempotencyKey: key.key,
      confirmation: emptyConfirmation,
      authClosed: false,
      reason: MANUAL_START_PUBLISHED_ONLY_HELP,
    };
  }
  return {
    ok: true,
    body,
    errors: [],
    schema,
    idempotencyKey: key.key,
    confirmation: buildManualStartConfirmation({
      version,
      idempotencyKey: key.key,
      input: parsed,
      catalog: input.catalog,
    }),
    authClosed: false,
    reason: "",
  };
}

export function manualStartAuthFailureMessage(
  problem: ProblemDetails | null | undefined,
): string | null {
  if (!problem) {
    return null;
  }
  if (isCsrfProblem(problem)) {
    return MANUAL_START_CSRF_HELP;
  }
  if (isUnauthenticatedProblem(problem) || problem.status === 401) {
    return MANUAL_START_UNAUTHENTICATED_MESSAGE;
  }
  if (
    problem.status === 403 ||
    problem.code === MANUAL_START_PROBLEM_CODES.forbidden
  ) {
    return MANUAL_START_FORBIDDEN_MESSAGE;
  }
  return null;
}

export function isManualStartAuthFailure(
  problem: ProblemDetails | null | undefined,
): boolean {
  return manualStartAuthFailureMessage(problem) !== null;
}

export function startOutcomeMessage(statusCode: number | null | undefined): string {
  if (statusCode === 200) {
    return MANUAL_START_REPLAY_MESSAGE;
  }
  if (statusCode === 201) {
    return MANUAL_START_CREATED_MESSAGE;
  }
  return "";
}

export function startFailureMessage(
  problem: ProblemDetails | null | undefined,
): string | null {
  const auth = manualStartAuthFailureMessage(problem);
  if (auth) {
    return auth;
  }
  if (!problem) {
    return null;
  }
  if (problem.status === 400) {
    return MANUAL_START_BAD_INPUT_MESSAGE;
  }
  if (problem.status === 409) {
    return MANUAL_START_CONFLICT_MESSAGE;
  }
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
