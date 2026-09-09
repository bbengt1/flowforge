/**
 * Single retarget adapter for Chloe's E10.1 authenticated manual-start UI.
 *
 * Jonny owns start APIs (#106). Until that map lands on `main`, this
 * adapter uses a clearly marked E5 fallback — do not invent routes:
 *   POST /workflows/{id}/executions
 *     `{workflowVersionId, idempotencyKey, input?}`
 *     Cookie session + `X-CSRF-Token`. 201 new run; 200 replay;
 *     409 fingerprint mismatch. Never POST /executions.
 *   GET  /workflows/{id}/versions[/{versionId}]
 *   POST /policy/evaluate
 *
 * Cookie + CSRF. camelCase JSON. RFC 9457.
 * Relates to #106 / Part of #105. Keep #106 open (jonny owns start
 * APIs). Do not change `apps/api`.
 */

import { isResourceId } from "./identity-proxy-ids.ts";
import {
  EXECUTION_PROBLEM_CODES,
  IDEMPOTENCY_CONFLICT_MESSAGE,
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
  StartExecutionBody,
  WorkflowVersion,
} from "./workflow-types.ts";
import { listYamlTriggers } from "./workflow-yaml-nodes.ts";
import { canExecuteWorkflows } from "./workspace-nav.ts";

export const MANUAL_START_STORY = 106;
export const MANUAL_START_EPIC = 105;
/** Jonny's E10.1 start map is not on main yet — retarget this constant. */
export const MANUAL_START_API_PR = 0;
export const MANUAL_START_ROUTE_MAP_SOURCE = "e5-fallback" as const;
export const MANUAL_START_SEMANTICS = "E10.1" as const;

export const MANUAL_START_PERMISSION = "workflow.execute" as const;
export const MANUAL_START_MAX_INPUT_BYTES = SCRIPT_IO_MAX_INPUT_BYTES;
export const MANUAL_START_MAX_IDEMPOTENCY_KEY = 128;
export const MANUAL_START_QUERY = "start";
export const MANUAL_TRIGGER_TYPE = "manual";

export const MANUAL_START_IDEMPOTENCY_KEY_RE =
  /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

export const MANUAL_START_PROBLEM_CODES = {
  ...EXECUTION_PROBLEM_CODES,
  invalidRequest: "invalid-request",
} as const;

export const MANUAL_START_CONTRACT_FALLBACK_HELP =
  "Using marked e5-fallback because jonny's E10.1 start route map is not on main yet. Prefer existing POST /workflows/{id}/executions {workflowVersionId, idempotencyKey, input?} with cookie session + X-CSRF-Token. HTTP 201 is a new run; 200 replays the same (workspace, workflow version, idempotency key); 409 is a fingerprint mismatch. Drafts never run. Do not invent POST /executions. Retarget this adapter when the map lands.";

export const MANUAL_START_PUBLISHED_ONLY_HELP = PRE_RUN_PUBLISHED_ONLY_HELP;

export const MANUAL_START_INPUT_HELP =
  "Typed start input comes from the published version's manual trigger schema (JSON Schema subset). Values are bounded (16 KiB), secret field names are stripped, and extra keys are rejected when additionalProperties is false.";

export const MANUAL_START_IDEMPOTENCY_HELP =
  "Required for audit. This UI generates a letter-prefixed key (1–128). Same key + same input returns the original run (200). Same key + different input is 409.";

export const MANUAL_START_FORBIDDEN_MESSAGE =
  "Start requires workflow.execute. HTTP 403 is fail-closed; this UI does not treat a run as started.";

export const MANUAL_START_UNAUTHENTICATED_MESSAGE =
  "Session is missing or stale (HTTP 401). Start is fail-closed; sign in again. This UI does not treat a run as started.";

export const MANUAL_START_CSRF_HELP =
  "Start sends X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const MANUAL_START_AUDIT_HELP =
  "This start is audited: actor, published workflowVersionId, digest, idempotency key, and redacted input. Secrets are stripped before display and POST.";

export const MANUAL_START_CONFIRM_HELP =
  "Review the published version digest, typed input, and idempotency key before starting. The confirmation below is what audit will record (secret-free).";

export const MANUAL_START_CREATED_MESSAGE = IDEMPOTENCY_CREATED_MESSAGE;
export const MANUAL_START_REPLAY_MESSAGE = IDEMPOTENCY_REPLAY_MESSAGE;
export const MANUAL_START_CONFLICT_MESSAGE = IDEMPOTENCY_CONFLICT_MESSAGE;

export const DEFAULT_MANUAL_START_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

export type ManualStartRouteMapSource = typeof MANUAL_START_ROUTE_MAP_SOURCE;

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
): { ok: boolean; key: string; error: string } {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    const generated = generateManualStartIdempotencyKey();
    return { ok: true, key: generated, error: "" };
  }
  if (!MANUAL_START_IDEMPOTENCY_KEY_RE.test(trimmed)) {
    return {
      ok: false,
      key: "",
      error:
        "Idempotency key must be 1–128 letters, digits, or ._: - and start with a letter.",
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
): string[] {
  const errors = validateValueAgainstSchema(input, schema);
  if (encodedJsonBytes(input) > MANUAL_START_MAX_INPUT_BYTES) {
    errors.push(
      `Start input exceeds the ${MANUAL_START_MAX_INPUT_BYTES} byte size bound.`,
    );
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
}): ManualStartConfirmation {
  const cleanedKeys: string[] = [...(input.strippedKeys ?? [])];
  const cleaned = stripSecretFields(input.input, cleanedKeys) as Record<string, unknown>;
  return {
    workflowVersionId: input.version.id,
    versionLabel: `v${input.version.versionNumber}`,
    digest: input.version.digest,
    idempotencyKey: input.idempotencyKey,
    input: cleaned,
    inputText: JSON.stringify(cleaned, null, 2),
    strippedKeys: unique(cleanedKeys),
    permission: MANUAL_START_PERMISSION,
    route: "POST /workflows/{id}/executions",
    routeMapSource: MANUAL_START_ROUTE_MAP_SOURCE,
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
  const key = normalizeManualStartIdempotencyKey(input.idempotencyKey);
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
  errors.push(...validateManualStartInput(parsed, schema));
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
    ...(Object.keys(parsed).length > 0 ? { input: parsed } : {}),
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
