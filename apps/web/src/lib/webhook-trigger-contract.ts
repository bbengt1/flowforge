/**
 * Single retarget adapter for Chloe's E10.2 webhook trigger config UI.
 *
 * Jonny owns ingress + security (#107). This UI does **not** invent a
 * route map. Prefer `GET /workflows/catalog` `triggers[type=webhook]`
 * when jonny posts routes/fields there. Until that map lands, use the
 * marked **contract-fallback** nested under existing workflows
 * (same house style as `/workflows/{id}/executions`).
 *
 * Cookie session + `X-CSRF-Token`. camelCase JSON. RFC 9457.
 * Relates to #107 / Part of #105. Keep #107 open.
 * Do not change `apps/api`. Do not stack on an API feature branch.
 */

import { isSecretFieldName, stripSecretFields } from "./execution.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import { isCsrfProblem, isUnauthenticatedProblem } from "./session.ts";
import { listYamlTriggers } from "./workflow-yaml-nodes.ts";
import type {
  CatalogTriggerWebhook,
  CatalogTriggerWebhookRoutes,
  WorkflowCatalog,
} from "./workflow-types.ts";
import { canCreateWorkflows, canSeeWorkflowsNav } from "./workspace-nav.ts";

export const WEBHOOK_TRIGGER_STORY = 107;
export const WEBHOOK_TRIGGER_EPIC = 105;
/** 0 = jonny's webhook route map is not on main yet. */
export const WEBHOOK_TRIGGER_API_PR = 0;
export const WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE = "contract-fallback" as const;
export const WEBHOOK_TRIGGER_SEMANTICS = "E10.2" as const;

export const WEBHOOK_TRIGGER_TYPE = "webhook" as const;
export const WEBHOOK_TRIGGER_QUERY = "webhooks";
export const WEBHOOK_TRIGGER_COLLECTION = "triggers";

export const WEBHOOK_TRIGGER_VIEW_PERMISSION = "workflow.view" as const;
export const WEBHOOK_TRIGGER_MANAGE_PERMISSION = "workflow.edit" as const;

export const WEBHOOK_TRIGGER_MAX_BODY_BYTES = 16 * 1024;
export const WEBHOOK_TRIGGER_MAX_MAPPINGS = 32;
export const WEBHOOK_TRIGGER_MAX_CONTENT_TYPE = 128;
export const WEBHOOK_TRIGGER_DEFAULT_SKEW_SECONDS = 300;
export const WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS = 300;
export const WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE = 60;
export const WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENT = 1;
export const WEBHOOK_TRIGGER_MIN_RATE = 1;
export const WEBHOOK_TRIGGER_MAX_RATE = 600;
export const WEBHOOK_TRIGGER_MAX_CONCURRENT_CAP = 32;
export const WEBHOOK_TRIGGER_MAX_SKEW_SECONDS = 600;

export const WEBHOOK_TRIGGER_STATUSES = ["active", "disabled"] as const;
export type WebhookTriggerStatus = (typeof WEBHOOK_TRIGGER_STATUSES)[number];

export const WEBHOOK_TRIGGER_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

export const WEBHOOK_YAML_ONLY_FIELDS = ["inputSchema", "contentType"] as const;

export const WEBHOOK_ALLOWED_CONTENT_TYPES = [
  "application/json",
] as const;

export const WEBHOOK_ONE_TIME_SECRET_KEYS = [
  "secret",
  "plaintext",
  "webhookSecret",
  "webhook_secret",
  "oneTimeSecret",
  "one_time_secret",
  "revealedSecret",
  "revealed_secret",
] as const;

export const WEBHOOK_HOST_SUPPLIED_KEYS = [
  "id",
  "workspaceId",
  "workspace_id",
] as const;

export const FIELD_MAPPING_PATH_RE =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export const WEBHOOK_TRIGGER_CONTRACT_FALLBACK_HELP =
  "Using marked contract-fallback webhook trigger paths because GET /workflows/catalog triggers[type=webhook] has no route map yet (jonny / #107). Assumed nested collection: GET|POST /workflows/{workflowId}/triggers, GET|PATCH /workflows/{workflowId}/triggers/{triggerId}, POST …/rotate|disable|enable. Cookie session + X-CSRF-Token. camelCase. RFC 9457. Do not invent ingress URLs, POST /executions, or a local secret store. Retarget this adapter when jonny posts the map.";

export const WEBHOOK_TRIGGER_CATALOG_HELP =
  "Webhook trigger config follows GET /workflows/catalog triggers[type=webhook]. Mutations send X-CSRF-Token. Secrets are shown once on create/rotate if the map returns them, then stripped. Signature is verified on the raw body before parse. Timestamp and replay protection stay on. Rate and concurrency limits apply before enqueue.";

export const WEBHOOK_SIGNATURE_HELP =
  "Ingress verifies a versioned signature over the exact raw body and timestamp before parsing. Absent, invalid, expired, or replayed signatures are rejected. This UI has no toggle that skips signature-before-parse.";

export const WEBHOOK_REPLAY_HELP =
  "Replay protection keeps request identifiers for at least the clock-skew window. Replayed or stale timestamps fail closed. Skew and replay window are bounded; they cannot turn protection off.";

export const WEBHOOK_RATE_HELP =
  "Per-trigger rate and concurrency limits apply before enqueue. Oversized bodies and unsupported content types are rejected. Defaults fail closed (JSON only, 16 KiB).";

export const WEBHOOK_SECRET_HELP =
  "The server owns the webhook secret reference. Plaintext is shown once after create or rotate if the API returns it, then discarded. Later GETs are metadata only (opaque id, fingerprint, secretRef). This UI never writes secrets to localStorage, the URL, or YAML.";

export const WEBHOOK_YAML_HELP =
  "Workflow YAML may declare only inputSchema and contentType on type=webhook. The opaque trigger id and secret reference live outside YAML.";

export const WEBHOOK_FIELD_MAPPING_HELP =
  "Map only allowlisted dotted fields into typed trigger input. Payload text is never YAML, shell, template, or code. Secret-shaped destination or source names are rejected.";

export const WEBHOOK_CSRF_HELP =
  "Create, update, rotate, disable, and enable send X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const WEBHOOK_FORBIDDEN_MESSAGE =
  "Webhook trigger changes require workflow.edit. HTTP 403 is fail-closed; this UI does not keep leftover rows or treat the secret as rotated.";

export const WEBHOOK_VIEW_FORBIDDEN_MESSAGE =
  "Listing webhook triggers requires workflow.view. HTTP 403 is fail-closed; the list stays empty.";

export const WEBHOOK_UNAUTHENTICATED_MESSAGE =
  "Session is missing or stale (HTTP 401). Mutation is fail-closed; sign in again.";

export const WEBHOOK_MAP_PENDING_MESSAGE =
  "Jonny's webhook route map is not on main yet (#107). This adapter uses marked contract-fallback paths. HTTP 404 is fail-closed — no local secret store and no invented ingress.";

export const WEBHOOK_HOST_SUPPLIED_MESSAGE =
  "Do not send id or workspaceId on writes. Workspace scope comes from the session and tenant + workbench headers. Host-supplied identity is HTTP 400.";

export const WEBHOOK_CREATED_MESSAGE =
  "Webhook trigger created. Copy the one-time secret now if the API revealed it. It will not be shown again.";

export const WEBHOOK_ROTATED_MESSAGE =
  "Webhook secret rotated. Copy the one-time secret now if the API revealed it. The previous secret is no longer valid in this UI.";

export const WEBHOOK_DISABLED_MESSAGE =
  "Webhook trigger disabled. Ingress for this opaque id fails closed until it is enabled again.";

export const WEBHOOK_ENABLED_MESSAGE =
  "Webhook trigger enabled. Signature, timestamp, and replay checks stay required.";

export const WEBHOOK_NO_REVEAL_MESSAGE =
  "The API did not return a one-time secret. This UI never invents or re-displays plaintext. Rotate again after jonny's map lands if you need a reveal.";

export const WEBHOOK_COPY_DISMISS_HELP =
  "I copied it — discard the one-time secret from this page. It is not stored in browser state after dismiss.";

export type WebhookTriggerRouteMapSource =
  | typeof WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE
  | `e102-#${number}`;

export type WebhookTriggerCatalogSource = "workflows-catalog" | "contract-fallback";

export type WebhookFieldMapping = {
  dest: string;
  from: string;
};

export type WebhookTriggerSettings = {
  contentType: string;
  inputSchema: Record<string, unknown>;
  maxBodyBytes: number;
  timestampSkewSeconds: number;
  replayWindowSeconds: number;
  rateLimitPerMinute: number;
  maxConcurrent: number;
  fieldMapping: WebhookFieldMapping[];
  signatureRequired: true;
  replayRequired: true;
  rawBodyBeforeParse: true;
};

export type WebhookTriggerDraft = {
  contentType: string;
  inputSchemaText: string;
  maxBodyBytes: string;
  timestampSkewSeconds: string;
  replayWindowSeconds: string;
  rateLimitPerMinute: string;
  maxConcurrent: string;
  fieldMappingText: string;
};

export type WebhookTriggerRecord = {
  id: string;
  workflowId: string;
  type: typeof WEBHOOK_TRIGGER_TYPE;
  status: WebhookTriggerStatus;
  opaqueId: string;
  secretRef?: string;
  fingerprint?: string;
  contentType: string;
  inputSchema?: Record<string, unknown>;
  maxBodyBytes: number;
  timestampSkewSeconds: number;
  replayWindowSeconds: number;
  rateLimitPerMinute: number;
  maxConcurrent: number;
  fieldMapping: WebhookFieldMapping[];
  signatureRequired: true;
  replayRequired: true;
  rawBodyBeforeParse: true;
  createdAt?: string;
  rotatedAt?: string;
  disabledAt?: string;
};

export type WebhookTriggerWriteBody = {
  contentType: string;
  inputSchema?: Record<string, unknown>;
  maxBodyBytes: number;
  timestampSkewSeconds: number;
  replayWindowSeconds: number;
  rateLimitPerMinute: number;
  maxConcurrent: number;
  fieldMapping: WebhookFieldMapping[];
};

export type WebhookOneTimeReveal = {
  secret: string | null;
  revealed: boolean;
};

export type WebhookTriggerResolved = {
  source: WebhookTriggerCatalogSource;
  routeMapSource: typeof WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE | "workflows-catalog";
  apiPr: number;
  collection: string;
  permission: string;
  managePermission: string;
  csrf: boolean;
  secretRevealOnce: boolean;
  signatureRequired: true;
  replayRequired: true;
  rawBodyBeforeParse: true;
  maxBodyBytes: number;
  defaultTimestampSkewSeconds: number;
  defaultReplayWindowSeconds: number;
  defaultRateLimitPerMinute: number;
  defaultMaxConcurrent: number;
  contentTypes: string[];
  routes: Required<CatalogTriggerWebhookRoutes>;
  help: string;
};

export const WEBHOOK_TRIGGER_DEFAULT_ROUTES: Required<CatalogTriggerWebhookRoutes> =
  {
    list: "/workflows/{workflowId}/triggers",
    create: "/workflows/{workflowId}/triggers",
    get: "/workflows/{workflowId}/triggers/{triggerId}",
    update: "/workflows/{workflowId}/triggers/{triggerId}",
    rotate: "/workflows/{workflowId}/triggers/{triggerId}/rotate",
    disable: "/workflows/{workflowId}/triggers/{triggerId}/disable",
    enable: "/workflows/{workflowId}/triggers/{triggerId}/enable",
  };

export const WEBHOOK_TRIGGER_DEFAULT_CONTRACT = {
  collection: WEBHOOK_TRIGGER_COLLECTION,
  permission: WEBHOOK_TRIGGER_VIEW_PERMISSION,
  managePermission: WEBHOOK_TRIGGER_MANAGE_PERMISSION,
  csrf: true,
  secretRevealOnce: true,
  signatureRequired: true as const,
  replayRequired: true as const,
  rawBodyBeforeParse: true as const,
  maxBodyBytes: WEBHOOK_TRIGGER_MAX_BODY_BYTES,
  defaultTimestampSkewSeconds: WEBHOOK_TRIGGER_DEFAULT_SKEW_SECONDS,
  defaultReplayWindowSeconds: WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS,
  defaultRateLimitPerMinute: WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE,
  defaultMaxConcurrent: WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENT,
  contentTypes: [...WEBHOOK_ALLOWED_CONTENT_TYPES],
  routes: { ...WEBHOOK_TRIGGER_DEFAULT_ROUTES },
  help: WEBHOOK_TRIGGER_CONTRACT_FALLBACK_HELP,
};

export function emptyWebhookTriggerDraft(
  seed: Partial<WebhookTriggerDraft> = {},
): WebhookTriggerDraft {
  return {
    contentType: seed.contentType ?? "application/json",
    inputSchemaText: seed.inputSchemaText ?? '{\n  "type": "object"\n}',
    maxBodyBytes: seed.maxBodyBytes ?? String(WEBHOOK_TRIGGER_MAX_BODY_BYTES),
    timestampSkewSeconds:
      seed.timestampSkewSeconds ?? String(WEBHOOK_TRIGGER_DEFAULT_SKEW_SECONDS),
    replayWindowSeconds:
      seed.replayWindowSeconds ?? String(WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS),
    rateLimitPerMinute:
      seed.rateLimitPerMinute ?? String(WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE),
    maxConcurrent:
      seed.maxConcurrent ?? String(WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENT),
    fieldMappingText: seed.fieldMappingText ?? "",
  };
}

export function resolveWebhookTriggerContract(
  catalog?: WorkflowCatalog | null,
): WebhookTriggerResolved {
  const listed = catalog?.triggers?.find(
    (item) => item.type === WEBHOOK_TRIGGER_TYPE,
  )?.webhook;
  if (!listed || !catalogHasWebhookRoutes(listed)) {
    return {
      source: "contract-fallback",
      routeMapSource: WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE,
      apiPr: WEBHOOK_TRIGGER_API_PR,
      ...WEBHOOK_TRIGGER_DEFAULT_CONTRACT,
      routes: { ...WEBHOOK_TRIGGER_DEFAULT_ROUTES },
      contentTypes: [...WEBHOOK_TRIGGER_DEFAULT_CONTRACT.contentTypes],
    };
  }
  return {
    source: "workflows-catalog",
    routeMapSource: "workflows-catalog",
    apiPr: WEBHOOK_TRIGGER_API_PR,
    collection: stringOr(listed.collection, WEBHOOK_TRIGGER_COLLECTION),
    permission: stringOr(listed.permission, WEBHOOK_TRIGGER_VIEW_PERMISSION),
    managePermission: stringOr(
      listed.managePermission,
      WEBHOOK_TRIGGER_MANAGE_PERMISSION,
    ),
    csrf: listed.csrf !== false,
    secretRevealOnce: listed.secretRevealOnce !== false,
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
    maxBodyBytes: positiveIntOr(listed.maxBodyBytes, WEBHOOK_TRIGGER_MAX_BODY_BYTES),
    defaultTimestampSkewSeconds: positiveIntOr(
      listed.defaultTimestampSkewSeconds,
      WEBHOOK_TRIGGER_DEFAULT_SKEW_SECONDS,
    ),
    defaultReplayWindowSeconds: positiveIntOr(
      listed.defaultReplayWindowSeconds,
      WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS,
    ),
    defaultRateLimitPerMinute: positiveIntOr(
      listed.defaultRateLimitPerMinute,
      WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE,
    ),
    defaultMaxConcurrent: positiveIntOr(
      listed.defaultMaxConcurrent,
      WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENT,
    ),
    contentTypes: listedContentTypes(listed.contentTypes),
    routes: mergeRoutes(listed.routes),
    help: stringOr(listed.help, WEBHOOK_TRIGGER_CATALOG_HELP),
  };
}

function catalogHasWebhookRoutes(listed: CatalogTriggerWebhook): boolean {
  const routes = listed.routes;
  if (!routes) {
    return false;
  }
  return Boolean(
    routes.list ||
      routes.create ||
      routes.get ||
      routes.update ||
      routes.rotate ||
      routes.disable ||
      routes.enable,
  );
}

function mergeRoutes(
  listed?: CatalogTriggerWebhookRoutes,
): Required<CatalogTriggerWebhookRoutes> {
  return {
    list: stringOr(listed?.list, WEBHOOK_TRIGGER_DEFAULT_ROUTES.list),
    create: stringOr(listed?.create, WEBHOOK_TRIGGER_DEFAULT_ROUTES.create),
    get: stringOr(listed?.get, WEBHOOK_TRIGGER_DEFAULT_ROUTES.get),
    update: stringOr(listed?.update, WEBHOOK_TRIGGER_DEFAULT_ROUTES.update),
    rotate: stringOr(listed?.rotate, WEBHOOK_TRIGGER_DEFAULT_ROUTES.rotate),
    disable: stringOr(listed?.disable, WEBHOOK_TRIGGER_DEFAULT_ROUTES.disable),
    enable: stringOr(listed?.enable, WEBHOOK_TRIGGER_DEFAULT_ROUTES.enable),
  };
}

function listedContentTypes(value: string[] | undefined): string[] {
  const items = (value ?? [])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : [...WEBHOOK_ALLOWED_CONTENT_TYPES];
}

export function webhookTriggerHelp(catalog?: WorkflowCatalog | null): string {
  const resolved = resolveWebhookTriggerContract(catalog);
  return resolved.source === "contract-fallback"
    ? WEBHOOK_TRIGGER_CONTRACT_FALLBACK_HELP
    : resolved.help || WEBHOOK_TRIGGER_CATALOG_HELP;
}

/**
 * Single rewrite point when jonny shares the map.
 * Identity today: fallback paths are already the documented assumption.
 */
export function retargetWebhookTriggerApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function applyWebhookRouteTemplate(
  template: string,
  ids: { workflowId: string; triggerId?: string },
): string {
  const triggerId = ids.triggerId ?? "";
  const filled = template
    .replaceAll("{workflowId}", ids.workflowId)
    .replaceAll("{workflow_id}", ids.workflowId)
    .replaceAll("{triggerId}", triggerId)
    .replaceAll("{trigger_id}", triggerId)
    .replace(/^\/api\/v1/, "");
  return retargetWebhookTriggerApiPath(filled.startsWith("/") ? filled : `/${filled}`);
}

export function webhookTriggerListPath(
  workflowId: string,
  catalog?: WorkflowCatalog | null,
): string {
  const resolved = resolveWebhookTriggerContract(catalog);
  const path = applyWebhookRouteTemplate(resolved.routes.list, { workflowId });
  if (path.includes("?")) {
    return path.includes("type=") ? path : `${path}&type=${WEBHOOK_TRIGGER_TYPE}`;
  }
  return `${path}?type=${WEBHOOK_TRIGGER_TYPE}`;
}

export function webhookTriggerCreatePath(
  workflowId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).routes.create,
    { workflowId },
  );
}

export function webhookTriggerPath(
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).routes.get,
    { workflowId, triggerId },
  );
}

export function webhookTriggerUpdatePath(
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).routes.update,
    { workflowId, triggerId },
  );
}

export function webhookTriggerRotatePath(
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).routes.rotate,
    { workflowId, triggerId },
  );
}

export function webhookTriggerDisablePath(
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).routes.disable,
    { workflowId, triggerId },
  );
}

export function webhookTriggerEnablePath(
  workflowId: string,
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).routes.enable,
    { workflowId, triggerId },
  );
}

export function webhookTriggersHref(workflowId?: string): string {
  if (workflowId && isResourceId(workflowId)) {
    return `/workflows?${WEBHOOK_TRIGGER_QUERY}=${encodeURIComponent(workflowId)}`;
  }
  return `/workflows?${WEBHOOK_TRIGGER_QUERY}=1`;
}

export function editorWebhookTriggersHref(workflowId: string): string {
  if (!isResourceId(workflowId)) {
    return "/workflows";
  }
  return `/workflows/${workflowId}#webhook-triggers`;
}

export function canViewWebhookTriggers(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeWorkflowsNav(permissions);
}

export function canManageWebhookTriggers(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canCreateWorkflows(permissions);
}

export function hostSuppliedWebhookIdentityKeys(
  body: Record<string, unknown> | null | undefined,
): string[] {
  if (!body) {
    return [];
  }
  return WEBHOOK_HOST_SUPPLIED_KEYS.filter((key) => key in body);
}

export function parseFieldMappingText(text: string): {
  mapping: WebhookFieldMapping[];
  errors: string[];
} {
  const errors: string[] = [];
  const mapping: WebhookFieldMapping[] = [];
  const seen = new Set<string>();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > WEBHOOK_TRIGGER_MAX_MAPPINGS) {
    errors.push(`Field mapping is limited to ${WEBHOOK_TRIGGER_MAX_MAPPINGS} rows.`);
    return { mapping: [], errors };
  }
  for (const line of lines) {
    const sep = line.includes(":") ? ":" : line.includes("=") ? "=" : "";
    if (!sep) {
      errors.push(`Mapping ${line} must be dest: from.`);
      continue;
    }
    const dest = line.slice(0, line.indexOf(sep)).trim();
    const from = line.slice(line.indexOf(sep) + 1).trim();
    const row = validateFieldMappingRow(dest, from);
    if (row.error) {
      errors.push(row.error);
      continue;
    }
    if (seen.has(row.dest)) {
      errors.push(`Destination ${row.dest} is already mapped.`);
      continue;
    }
    seen.add(row.dest);
    mapping.push({ dest: row.dest, from: row.from });
  }
  return { mapping, errors };
}

function validateFieldMappingRow(
  dest: string,
  from: string,
): { dest: string; from: string; error?: string } {
  if (!FIELD_MAPPING_PATH_RE.test(dest)) {
    return { dest, from, error: `Destination ${dest || "(empty)"} is not a dotted identifier.` };
  }
  if (!FIELD_MAPPING_PATH_RE.test(from)) {
    return { dest, from, error: `Source ${from || "(empty)"} is not a dotted identifier.` };
  }
  if (isSecretFieldName(dest) || isSecretFieldName(from)) {
    return {
      dest,
      from,
      error: "Field mapping cannot use secret-shaped names.",
    };
  }
  return { dest, from };
}

export function parseInputSchemaText(text: string): {
  schema: Record<string, unknown>;
  error: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { schema: { type: "object" }, error: "" };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { schema: {}, error: "inputSchema must be a JSON object." };
    }
    const schema = parsed as Record<string, unknown>;
    const strippedKeys: string[] = [];
    const clean = stripSecretFields(schema, strippedKeys) as Record<string, unknown>;
    if (strippedKeys.length > 0) {
      return { schema: {}, error: "inputSchema cannot declare secret field names." };
    }
    if (schema.type !== undefined && schema.type !== "object") {
      return { schema: {}, error: "inputSchema type must be object." };
    }
    return { schema: clean, error: "" };
  } catch {
    return { schema: {}, error: "inputSchema must be valid JSON." };
  }
}

export function validateWebhookTriggerDraft(
  draft: WebhookTriggerDraft,
  catalog?: WorkflowCatalog | null,
): { ok: true; settings: WebhookTriggerSettings; body: WebhookTriggerWriteBody } | {
  ok: false;
  errors: string[];
} {
  const resolved = resolveWebhookTriggerContract(catalog);
  const errors: string[] = [];
  const contentType = draft.contentType.trim().toLowerCase();
  if (!contentType) {
    errors.push("contentType is required.");
  } else if (!resolved.contentTypes.includes(contentType)) {
    errors.push(
      `contentType ${contentType} is not allowlisted. Supported: ${resolved.contentTypes.join(", ")}.`,
    );
  }
  const schema = parseInputSchemaText(draft.inputSchemaText);
  if (schema.error) {
    errors.push(schema.error);
  }
  const mapping = parseFieldMappingText(draft.fieldMappingText);
  errors.push(...mapping.errors);
  const maxBodyBytes = parseBoundedInt(
    draft.maxBodyBytes,
    1,
    resolved.maxBodyBytes,
    "maxBodyBytes",
  );
  if (maxBodyBytes.error) {
    errors.push(maxBodyBytes.error);
  }
  const skew = parseBoundedInt(
    draft.timestampSkewSeconds,
    1,
    WEBHOOK_TRIGGER_MAX_SKEW_SECONDS,
    "timestampSkewSeconds",
  );
  if (skew.error) {
    errors.push(skew.error);
  }
  const replay = parseBoundedInt(
    draft.replayWindowSeconds,
    1,
    WEBHOOK_TRIGGER_MAX_SKEW_SECONDS,
    "replayWindowSeconds",
  );
  if (replay.error) {
    errors.push(replay.error);
  }
  if (!skew.error && !replay.error && replay.value < skew.value) {
    errors.push("replayWindowSeconds must be at least timestampSkewSeconds.");
  }
  const rate = parseBoundedInt(
    draft.rateLimitPerMinute,
    WEBHOOK_TRIGGER_MIN_RATE,
    WEBHOOK_TRIGGER_MAX_RATE,
    "rateLimitPerMinute",
  );
  if (rate.error) {
    errors.push(rate.error);
  }
  const concurrent = parseBoundedInt(
    draft.maxConcurrent,
    1,
    WEBHOOK_TRIGGER_MAX_CONCURRENT_CAP,
    "maxConcurrent",
  );
  if (concurrent.error) {
    errors.push(concurrent.error);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const settings: WebhookTriggerSettings = {
    contentType,
    inputSchema: schema.schema,
    maxBodyBytes: maxBodyBytes.value,
    timestampSkewSeconds: skew.value,
    replayWindowSeconds: replay.value,
    rateLimitPerMinute: rate.value,
    maxConcurrent: concurrent.value,
    fieldMapping: mapping.mapping,
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
  };
  return { ok: true, settings, body: webhookTriggerWriteBody(settings) };
}

export function webhookTriggerWriteBody(
  settings: WebhookTriggerSettings,
): WebhookTriggerWriteBody {
  const body: WebhookTriggerWriteBody = {
    contentType: settings.contentType,
    maxBodyBytes: settings.maxBodyBytes,
    timestampSkewSeconds: settings.timestampSkewSeconds,
    replayWindowSeconds: settings.replayWindowSeconds,
    rateLimitPerMinute: settings.rateLimitPerMinute,
    maxConcurrent: settings.maxConcurrent,
    fieldMapping: settings.fieldMapping.map((row) => ({
      dest: row.dest,
      from: row.from,
    })),
  };
  if (Object.keys(settings.inputSchema).length > 0) {
    body.inputSchema = settings.inputSchema;
  }
  return body;
}

export function rejectHostSuppliedWebhookBody(
  body: WebhookTriggerWriteBody,
): WebhookTriggerWriteBody {
  const copy = { ...body };
  for (const key of WEBHOOK_HOST_SUPPLIED_KEYS) {
    delete (copy as Record<string, unknown>)[key];
  }
  return copy;
}

export function takeOneTimeSecret(payload: unknown): {
  secret: string | null;
  strippedKeys: string[];
  record: Record<string, unknown>;
} {
  const strippedKeys: string[] = [];
  const secret = extractOneTimeSecret(payload);
  const sanitized = stripSecretFields(payload, strippedKeys);
  const record =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : {};
  for (const key of WEBHOOK_ONE_TIME_SECRET_KEYS) {
    if (key in record) {
      delete record[key];
      if (!strippedKeys.includes(key)) {
        strippedKeys.push(key);
      }
    }
  }
  delete record.reveal;
  delete record.oneTime;
  delete record.one_time;
  return { secret, strippedKeys, record };
}

function extractOneTimeSecret(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const bags = [root];
  for (const nestedKey of ["reveal", "oneTime", "one_time", "trigger", "webhookTrigger"]) {
    const nested = root[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      bags.push(nested as Record<string, unknown>);
    }
  }
  for (const bag of bags) {
    for (const key of WEBHOOK_ONE_TIME_SECRET_KEYS) {
      const value = bag[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return null;
}

export function parseWebhookTriggerRecord(
  payload: unknown,
  fallbackWorkflowId = "",
): WebhookTriggerRecord | null {
  const { record } = takeOneTimeSecret(payload);
  const source = unwrapTriggerRecord(record);
  const id = readString(source.id);
  const opaqueId = readString(source.opaqueId, source.opaque_id, source.triggerId, source.id);
  if (!id && !opaqueId) {
    return null;
  }
  const workflowId = readString(source.workflowId, source.workflow_id) || fallbackWorkflowId;
  const status = readStatus(source.status);
  const mapping = readFieldMapping(source.fieldMapping ?? source.field_mapping);
  return {
    id: id || opaqueId,
    workflowId,
    type: WEBHOOK_TRIGGER_TYPE,
    status,
    opaqueId: opaqueId || id,
    secretRef: optionalString(source.secretRef, source.secret_ref),
    fingerprint: optionalString(source.fingerprint),
    contentType:
      optionalString(source.contentType, source.content_type) ?? "application/json",
    inputSchema: readObject(source.inputSchema ?? source.input_schema),
    maxBodyBytes: positiveIntOr(
      numberish(source.maxBodyBytes ?? source.max_body_bytes),
      WEBHOOK_TRIGGER_MAX_BODY_BYTES,
    ),
    timestampSkewSeconds: positiveIntOr(
      numberish(source.timestampSkewSeconds ?? source.timestamp_skew_seconds),
      WEBHOOK_TRIGGER_DEFAULT_SKEW_SECONDS,
    ),
    replayWindowSeconds: positiveIntOr(
      numberish(source.replayWindowSeconds ?? source.replay_window_seconds),
      WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS,
    ),
    rateLimitPerMinute: positiveIntOr(
      numberish(source.rateLimitPerMinute ?? source.rate_limit_per_minute),
      WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE,
    ),
    maxConcurrent: positiveIntOr(
      numberish(source.maxConcurrent ?? source.max_concurrent),
      WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENT,
    ),
    fieldMapping: mapping,
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
    createdAt: optionalString(source.createdAt, source.created_at),
    rotatedAt: optionalString(source.rotatedAt, source.rotated_at),
    disabledAt: optionalString(source.disabledAt, source.disabled_at),
  };
}

function unwrapTriggerRecord(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["trigger", "webhookTrigger", "item"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return record;
}

export function parseWebhookTriggerList(
  payload: unknown,
  fallbackWorkflowId = "",
): WebhookTriggerRecord[] {
  const items = readItems(payload);
  const records: WebhookTriggerRecord[] = [];
  for (const item of items) {
    const record = parseWebhookTriggerRecord(item, fallbackWorkflowId);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function readItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const body = payload as Record<string, unknown>;
  if (Array.isArray(body.items)) {
    return body.items;
  }
  if (Array.isArray(body.triggers)) {
    return body.triggers;
  }
  return [];
}

export function seedDraftFromYaml(
  yaml: string | null | undefined,
): WebhookTriggerDraft {
  const webhook = (yaml ? listYamlTriggers(yaml) : []).find(
    (item) => item.type === WEBHOOK_TRIGGER_TYPE,
  );
  if (!webhook) {
    return emptyWebhookTriggerDraft();
  }
  const contentType = stringFromUnknown(
    webhook.with.contentType ?? webhook.with.content_type,
  );
  const schema =
    webhook.inputSchema ??
    readObject(webhook.with.inputSchema) ??
    readObject(webhook.with.schema);
  return emptyWebhookTriggerDraft({
    contentType: contentType || "application/json",
    inputSchemaText: schema
      ? JSON.stringify(schema, null, 2)
      : '{\n  "type": "object"\n}',
  });
}

export function yamlWebhookTriggers(yaml: string | null | undefined): {
  id: string;
  contentType: string;
  hasSchema: boolean;
}[] {
  return (yaml ? listYamlTriggers(yaml) : [])
    .filter((item) => item.type === WEBHOOK_TRIGGER_TYPE)
    .map((item) => ({
      id: item.id,
      contentType: stringFromUnknown(item.with.contentType) || "application/json",
      hasSchema: Boolean(
        item.inputSchema ||
          readObject(item.with.inputSchema) ||
          readObject(item.with.schema),
      ),
    }));
}

export function webhookTriggerAuthFailureMessage(
  problem: ProblemDetails | null | undefined,
): string {
  if (!problem) {
    return "";
  }
  if (isCsrfProblem(problem)) {
    return WEBHOOK_CSRF_HELP;
  }
  if (isUnauthenticatedProblem(problem)) {
    return WEBHOOK_UNAUTHENTICATED_MESSAGE;
  }
  if (
    problem.status === 403 ||
    problem.code === WEBHOOK_TRIGGER_PROBLEM_CODES.forbidden
  ) {
    return WEBHOOK_FORBIDDEN_MESSAGE;
  }
  return "";
}

export function isWebhookTriggerAuthFailure(
  problem: ProblemDetails | null | undefined,
): boolean {
  return Boolean(webhookTriggerAuthFailureMessage(problem));
}

export function isWebhookMapPending(
  statusCode: number,
  problem?: ProblemDetails | null,
): boolean {
  if (statusCode === 404) {
    return true;
  }
  return problem?.code === WEBHOOK_TRIGGER_PROBLEM_CODES.notFound;
}

export function webhookMutationOutcomeMessage(
  action: "create" | "rotate" | "disable" | "enable",
  reveal: WebhookOneTimeReveal,
): string {
  if (action === "create") {
    return reveal.revealed ? WEBHOOK_CREATED_MESSAGE : WEBHOOK_NO_REVEAL_MESSAGE;
  }
  if (action === "rotate") {
    return reveal.revealed ? WEBHOOK_ROTATED_MESSAGE : WEBHOOK_NO_REVEAL_MESSAGE;
  }
  if (action === "disable") {
    return WEBHOOK_DISABLED_MESSAGE;
  }
  return WEBHOOK_ENABLED_MESSAGE;
}

export function forgetOneTimeSecret(reveal: WebhookOneTimeReveal): WebhookOneTimeReveal {
  if (reveal.secret) {
    reveal.secret = "";
  }
  return { secret: null, revealed: false };
}

function parseBoundedInt(
  raw: string,
  min: number,
  max: number,
  name: string,
): { value: number; error: string } {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return { value: 0, error: `${name} must be an integer.` };
  }
  const value = Number(trimmed);
  if (value < min || value > max) {
    return { value, error: `${name} must be between ${min} and ${max}.` };
  }
  return { value, error: "" };
}

function readFieldMapping(value: unknown): WebhookFieldMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mapping: WebhookFieldMapping[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const dest = stringFromUnknown(row.dest);
    const from = stringFromUnknown(row.from);
    if (!dest || !from || isSecretFieldName(dest) || isSecretFieldName(from)) {
      continue;
    }
    mapping.push({ dest, from });
  }
  return mapping;
}

function readStatus(value: unknown): WebhookTriggerStatus {
  const status = stringFromUnknown(value).toLowerCase();
  return status === "disabled" ? "disabled" : "active";
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const strippedKeys: string[] = [];
  return stripSecretFields(value, strippedKeys) as Record<string, unknown>;
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringFromUnknown(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function optionalString(...values: unknown[]): string | undefined {
  const text = readString(...values);
  return text || undefined;
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function stringOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || fallback;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}
