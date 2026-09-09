/**
 * Single retarget adapter for Chloe's E10.2 webhook trigger config UI.
 *
 * Wired to jonny's **#113** map on `main` (`e102-#113`).
 *
 * Admin (cookie session + `X-CSRF-Token` on POST/PATCH/DELETE):
 *   GET|POST /workflows/{id}/triggers
 *   GET|PATCH|DELETE /triggers/{id}
 *   POST /triggers/{id}/rotate|disable|enable
 * Catalog: GET /workflows/catalog `triggers[type=webhook].ingress` + `.admin`
 *
 * Public ingress is operator documentation only — not a session UI path:
 *   POST /hooks/{publicId}  →  POST /api/v1/hooks/{publicId}
 *   HMAC over `v1.{timestamp}.{rawBody}` before parse
 *   Headers: X-FlowForge-Timestamp, X-FlowForge-Signature: v1=<hex>
 *
 * Vault `webhook_secret` only. Never return or render `secret`.
 * Relates to #107 / Part of #105. Keep #107 open.
 * Do not change `apps/api`. Do not stack on an API feature branch.
 */

import { isSecretFieldName, stripSecretFields } from "./execution.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import type { ProblemDetails } from "./problem.ts";
import { isCsrfProblem, isUnauthenticatedProblem } from "./session.ts";
import { listYamlTriggers } from "./workflow-yaml-nodes.ts";
import type {
  CatalogTriggerAdmin,
  CatalogTriggerIngress,
  WorkflowCatalog,
} from "./workflow-types.ts";
import { canCreateWorkflows, canSeeWorkflowsNav } from "./workspace-nav.ts";

export const WEBHOOK_TRIGGER_STORY = 107;
export const WEBHOOK_TRIGGER_EPIC = 105;
/** Jonny's E10.2 webhook map on main. */
export const WEBHOOK_TRIGGER_API_PR = 113;
export const WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE = "e102-#113" as const;
export const WEBHOOK_TRIGGER_SEMANTICS = "E10.2" as const;

export const WEBHOOK_TRIGGER_TYPE = "webhook" as const;
export const WEBHOOK_TRIGGER_QUERY = "webhooks";
export const WEBHOOK_TRIGGER_COLLECTION = "triggers";
export const WEBHOOK_SECRET_CREDENTIAL_TYPE = "webhook_secret" as const;

export const WEBHOOK_TRIGGER_VIEW_PERMISSION = "workflow.view" as const;
export const WEBHOOK_TRIGGER_MANAGE_PERMISSION = "workflow.edit" as const;

export const WEBHOOK_TRIGGER_DEFAULT_MAX_BODY_BYTES = 65536;
export const WEBHOOK_TRIGGER_HARD_MAX_BODY_BYTES = 262144;
export const WEBHOOK_TRIGGER_DEFAULT_CLOCK_SKEW_SECONDS = 300;
export const WEBHOOK_TRIGGER_HARD_CLOCK_SKEW_SECONDS = 3600;
export const WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS = 600;
export const WEBHOOK_TRIGGER_HARD_REPLAY_SECONDS = 7200;
export const WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE = 60;
export const WEBHOOK_TRIGGER_HARD_RATE_PER_MINUTE = 600;
export const WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_RATE = 300;
export const WEBHOOK_TRIGGER_HARD_WORKSPACE_RATE = 3000;
export const WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENCY = 5;
export const WEBHOOK_TRIGGER_HARD_MAX_CONCURRENCY = 20;
export const WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_CONCURRENCY = 20;
export const WEBHOOK_TRIGGER_HARD_WORKSPACE_CONCURRENCY = 100;
export const WEBHOOK_TRIGGER_MAX_MAPPINGS = 32;
export const WEBHOOK_TRIGGER_MIN_RATE = 1;

export const WEBHOOK_PUBLIC_ID_PREFIX = "wh_";
export const WEBHOOK_PUBLIC_ID_RE = /^wh_[0-9a-f]{64}$/i;

export const WEBHOOK_TRIGGER_STATUSES = ["enabled", "disabled"] as const;
export type WebhookTriggerStatus = (typeof WEBHOOK_TRIGGER_STATUSES)[number];

export const WEBHOOK_TRIGGER_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

export const WEBHOOK_YAML_ONLY_FIELDS = [
  "schema",
  "inputSchema",
  "contentType",
] as const;

export const WEBHOOK_ALLOWED_CONTENT_TYPES = ["application/json"] as const;

export const WEBHOOK_SECRET_KEYS = [
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

export const WEBHOOK_TRIGGER_CATALOG_FALLBACK_HELP =
  "Using marked catalog-fallback #113 defaults because GET /workflows/catalog triggers[type=webhook] is missing ingress+admin. Admin: GET|POST /workflows/{id}/triggers and GET|PATCH|DELETE /triggers/{id} plus POST …/rotate|disable|enable. Public ingress POST /hooks/{publicId} is operator documentation only — not a session UI path. HMAC over v1.{timestamp}.{rawBody} before parse. Cookie session + X-CSRF-Token. camelCase. RFC 9457. Vault webhook_secret only; secret is never returned. Cite #113 / e102-#113. Relates to #107.";

export const WEBHOOK_TRIGGER_CATALOG_HELP =
  "Webhook trigger config follows jonny's #113 catalog map (e102-#113): GET /workflows/catalog triggers[type=webhook].ingress + .admin. Admin mutations send X-CSRF-Token. Public POST /hooks/{publicId} is not a browser session route. HMAC is verified over v1.{timestamp}.{rawBody} before parse. The vault webhook_secret is never returned.";

export const WEBHOOK_INGRESS_HELP =
  "Public ingress is server-to-server, not a session UI path: POST /hooks/{publicId} (POST /api/v1/hooks/{publicId}). Send X-FlowForge-Timestamp (unix seconds) and X-FlowForge-Signature: v1=<hex>. HMAC-SHA256 over v1.{timestamp}.{rawBody} is verified before JSON parse. No cookie, no CSRF. Optional Idempotency-Key. Never put the secret in the URL.";

export const WEBHOOK_SIGNATURE_HELP =
  "Ingress verifies a v1 HMAC over the exact raw body and timestamp before parsing. Absent, invalid, expired, or replayed signatures are rejected. This UI has no toggle that skips signature-before-parse and does not POST /hooks/{publicId} from the browser session.";

export const WEBHOOK_REPLAY_HELP =
  "Replay protection retains the signed-payload digest for at least the clock-skew window (default 600s). Replayed or stale timestamps fail closed. Skew and replay retention are bounded; they cannot turn protection off.";

export const WEBHOOK_RATE_HELP =
  "Per-trigger and workspace rate/concurrency limits apply before enqueue. Oversized bodies and unsupported content types are rejected. Defaults fail closed (JSON only, 64 KiB body, 60/min, 5 in-flight).";

export const WEBHOOK_SECRET_HELP =
  "Pick an existing vault webhook_secret or send {secret:{secret}} once on create/rotate. The API never returns secret. Later GETs are metadata only (publicId, ingressPath, secretCredentialId). This UI never writes secrets to localStorage, the URL, or YAML.";

export const WEBHOOK_YAML_HELP =
  "Workflow YAML may declare only schema / inputSchema and contentType on type=webhook. The opaque publicId (wh_…) and vault secret reference live outside YAML.";

export const WEBHOOK_FIELD_MAPPING_HELP =
  "Map destination identifier → dotted source path. Empty mapping copies the root JSON object. Payload text is never YAML, shell, template, or code. Secret-shaped destination or source names are rejected.";

export const WEBHOOK_CSRF_HELP =
  "Create, patch, rotate, disable, enable, and delete send X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called. Public ingress does not use CSRF.";

export const WEBHOOK_FORBIDDEN_MESSAGE =
  "Webhook trigger changes require workflow.edit. HTTP 403 is fail-closed; this UI does not keep leftover rows or treat the secret as rotated.";

export const WEBHOOK_VIEW_FORBIDDEN_MESSAGE =
  "Listing webhook triggers requires workflow.view. HTTP 403 is fail-closed; the list stays empty.";

export const WEBHOOK_UNAUTHENTICATED_MESSAGE =
  "Session is missing or stale (HTTP 401). Mutation is fail-closed; sign in again.";

export const WEBHOOK_CATALOG_FALLBACK_MESSAGE =
  "GET /workflows/catalog triggers[type=webhook] is missing ingress+admin. Using marked #113 catalog-fallback admin paths. HTTP 404 is fail-closed — no local secret store and no invented ingress.";

export const WEBHOOK_HOST_SUPPLIED_MESSAGE =
  "Do not send id or workspaceId on writes. Workspace scope comes from the session and tenant + workbench headers. Host-supplied identity is HTTP 400.";

export const WEBHOOK_CREATED_MESSAGE =
  "Webhook trigger created. Copy publicId and ingressPath. The HMAC secret is never returned — it lives only in the vault webhook_secret.";

export const WEBHOOK_UPDATED_MESSAGE =
  "Webhook trigger settings saved. Secret was not sent (PATCH rejects secret; rotate is the only secret write path).";

export const WEBHOOK_ROTATED_MESSAGE =
  "Webhook secret rotated on the existing vault credential. Plaintext was not returned.";

export const WEBHOOK_DISABLED_MESSAGE =
  "Webhook trigger disabled. Ingress for this publicId is HTTP 404 until it is enabled again.";

export const WEBHOOK_ENABLED_MESSAGE =
  "Webhook trigger enabled. Signature, timestamp, and replay checks stay required.";

export const WEBHOOK_DELETED_MESSAGE =
  "Webhook trigger deleted.";

export const WEBHOOK_SECRET_LEAK_MESSAGE =
  "The API unexpectedly included a secret field, contrary to #113 secretNeverReturned. It was discarded and not shown.";

export const WEBHOOK_PUBLISHED_ONLY_HELP =
  "Webhook triggers must pin a published workflowVersionId. Drafts are HTTP 400.";

export const WEBHOOK_ROTATE_SECRET_HELP =
  "Rotate is rotate-only: POST /triggers/{id}/rotate {secret:{secret}}. PATCH rejects secret.";

export type WebhookTriggerRouteMapSource =
  | typeof WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE
  | `e102-#${number}`;

export type WebhookTriggerCatalogSource = "workflows-catalog" | "catalog-fallback";

export type WebhookFieldMapping = Record<string, string>;

export type WebhookTriggerSettings = {
  workflowVersionId: string;
  contentType: string;
  maxBodyBytes: number;
  clockSkewSeconds: number;
  replayRetentionSeconds: number;
  rateLimitPerMinute: number;
  workspaceRatePerMinute: number;
  maxConcurrency: number;
  workspaceMaxConcurrency: number;
  fieldMapping: WebhookFieldMapping;
  signatureRequired: true;
  replayRequired: true;
  rawBodyBeforeParse: true;
};

export type WebhookTriggerDraft = {
  workflowVersionId: string;
  secretMode: "vault" | "inline";
  secretCredentialId: string;
  inlineSecret: string;
  contentType: string;
  maxBodyBytes: string;
  clockSkewSeconds: string;
  replayRetentionSeconds: string;
  rateLimitPerMinute: string;
  workspaceRatePerMinute: string;
  maxConcurrency: string;
  workspaceMaxConcurrency: string;
  fieldMappingText: string;
};

export type WebhookTriggerRecord = {
  id: string;
  publicId: string;
  ingressPath: string;
  workflowId: string;
  workflowVersionId: string;
  type: typeof WEBHOOK_TRIGGER_TYPE;
  status: WebhookTriggerStatus;
  secretCredentialId: string;
  contentType: string;
  maxBodyBytes: number;
  clockSkewSeconds: number;
  replayRetentionSeconds: number;
  rateLimitPerMinute: number;
  workspaceRatePerMinute: number;
  maxConcurrency: number;
  workspaceMaxConcurrency: number;
  fieldMapping: WebhookFieldMapping;
  signatureRequired: true;
  replayRequired: true;
  rawBodyBeforeParse: true;
  createdAt?: string;
  updatedAt?: string;
};

export type WebhookTriggerWriteBody = {
  type?: typeof WEBHOOK_TRIGGER_TYPE;
  workflowVersionId?: string;
  secretCredentialId?: string;
  secret?: { secret: string };
  contentType?: string;
  fieldMapping?: WebhookFieldMapping;
  maxBodyBytes?: number;
  clockSkewSeconds?: number;
  replayRetentionSeconds?: number;
  rateLimitPerMinute?: number;
  workspaceRatePerMinute?: number;
  maxConcurrency?: number;
  workspaceMaxConcurrency?: number;
};

export type WebhookTriggerRotateBody = {
  secret: { secret: string };
};

export type WebhookSecretLeak = {
  leaked: boolean;
  strippedKeys: string[];
};

export type WebhookTriggerAdminRoutes = {
  listRoute: string;
  createRoute: string;
  itemRoute: string;
  rotateRoute: string;
  disableRoute: string;
  enableRoute: string;
  deleteRoute: string;
};

export type WebhookTriggerResolved = {
  source: WebhookTriggerCatalogSource;
  routeMapSource: typeof WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE;
  apiPr: number;
  collection: string;
  permission: string;
  viewPermission: string;
  csrf: boolean;
  secretNeverReturned: true;
  signatureRequired: true;
  replayRequired: true;
  rawBodyBeforeParse: true;
  maxBodyBytes: number;
  hardMaxBodyBytes: number;
  clockSkewSeconds: number;
  hardClockSkewSeconds: number;
  replayRetentionSeconds: number;
  hardReplayRetentionSeconds: number;
  defaultRatePerMinute: number;
  hardRatePerMinute: number;
  defaultWorkspaceRatePerMinute: number;
  hardWorkspaceRatePerMinute: number;
  defaultMaxConcurrency: number;
  hardMaxConcurrency: number;
  defaultWorkspaceMaxConcurrency: number;
  hardWorkspaceMaxConcurrency: number;
  contentTypes: string[];
  admin: WebhookTriggerAdminRoutes;
  ingress: Required<
    Pick<
      CatalogTriggerIngress,
      | "route"
      | "method"
      | "public"
      | "csrf"
      | "session"
      | "signatureHeader"
      | "timestampHeader"
      | "signatureVersion"
      | "idempotencyHeader"
      | "help"
    >
  >;
  help: string;
  ingressHelp: string;
};

export const WEBHOOK_TRIGGER_DEFAULT_ADMIN: WebhookTriggerAdminRoutes = {
  listRoute: "/workflows/{workflowId}/triggers",
  createRoute: "/workflows/{workflowId}/triggers",
  itemRoute: "/triggers/{triggerId}",
  rotateRoute: "/triggers/{triggerId}/rotate",
  disableRoute: "/triggers/{triggerId}/disable",
  enableRoute: "/triggers/{triggerId}/enable",
  deleteRoute: "/triggers/{triggerId}",
};

export const WEBHOOK_TRIGGER_DEFAULT_INGRESS = {
  route: "POST /api/v1/hooks/{publicId}",
  method: "POST",
  public: true,
  csrf: false,
  session: false,
  signatureHeader: "X-FlowForge-Signature",
  timestampHeader: "X-FlowForge-Timestamp",
  signatureVersion: "v1",
  idempotencyHeader: "Idempotency-Key",
  help: WEBHOOK_INGRESS_HELP,
};

export function emptyWebhookTriggerDraft(
  seed: Partial<WebhookTriggerDraft> = {},
): WebhookTriggerDraft {
  return {
    workflowVersionId: seed.workflowVersionId ?? "",
    secretMode: seed.secretMode ?? "vault",
    secretCredentialId: seed.secretCredentialId ?? "",
    inlineSecret: seed.inlineSecret ?? "",
    contentType: seed.contentType ?? "application/json",
    maxBodyBytes:
      seed.maxBodyBytes ?? String(WEBHOOK_TRIGGER_DEFAULT_MAX_BODY_BYTES),
    clockSkewSeconds:
      seed.clockSkewSeconds ?? String(WEBHOOK_TRIGGER_DEFAULT_CLOCK_SKEW_SECONDS),
    replayRetentionSeconds:
      seed.replayRetentionSeconds ?? String(WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS),
    rateLimitPerMinute:
      seed.rateLimitPerMinute ?? String(WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE),
    workspaceRatePerMinute:
      seed.workspaceRatePerMinute ?? String(WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_RATE),
    maxConcurrency:
      seed.maxConcurrency ?? String(WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENCY),
    workspaceMaxConcurrency:
      seed.workspaceMaxConcurrency ??
      String(WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_CONCURRENCY),
    fieldMappingText: seed.fieldMappingText ?? "",
  };
}

export function forgetWebhookInlineSecret(
  draft: WebhookTriggerDraft,
): WebhookTriggerDraft {
  draft.inlineSecret = "";
  return { ...draft, inlineSecret: "" };
}

export function resolveWebhookTriggerContract(
  catalog?: WorkflowCatalog | null,
): WebhookTriggerResolved {
  const listed = catalog?.triggers?.find(
    (item) => item.type === WEBHOOK_TRIGGER_TYPE,
  );
  const hasMap = Boolean(listed?.ingress && listed?.admin);
  if (!listed || !hasMap) {
    return defaultResolved("catalog-fallback", WEBHOOK_TRIGGER_CATALOG_FALLBACK_HELP);
  }
  return {
    ...defaultResolved("workflows-catalog", stringOr(listed.admin?.help, WEBHOOK_TRIGGER_CATALOG_HELP)),
    permission: stringOr(listed.admin?.permission, WEBHOOK_TRIGGER_MANAGE_PERMISSION),
    viewPermission: stringOr(
      listed.admin?.viewPermission,
      WEBHOOK_TRIGGER_VIEW_PERMISSION,
    ),
    csrf: listed.admin?.csrf !== false,
    maxBodyBytes: positiveIntOr(
      listed.ingress?.maxBodyBytes,
      WEBHOOK_TRIGGER_DEFAULT_MAX_BODY_BYTES,
    ),
    clockSkewSeconds: positiveIntOr(
      listed.ingress?.clockSkewSeconds,
      WEBHOOK_TRIGGER_DEFAULT_CLOCK_SKEW_SECONDS,
    ),
    replayRetentionSeconds: positiveIntOr(
      listed.ingress?.replayRetentionSeconds,
      WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS,
    ),
    defaultRatePerMinute: positiveIntOr(
      listed.ingress?.defaultRatePerMinute,
      WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE,
    ),
    defaultWorkspaceRatePerMinute: positiveIntOr(
      listed.ingress?.defaultWorkspaceRatePerMinute,
      WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_RATE,
    ),
    defaultMaxConcurrency: positiveIntOr(
      listed.ingress?.defaultMaxConcurrency,
      WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENCY,
    ),
    defaultWorkspaceMaxConcurrency: positiveIntOr(
      listed.ingress?.defaultWorkspaceMaxConcurrency,
      WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_CONCURRENCY,
    ),
    contentTypes: listedContentTypes(listed.ingress?.contentTypes),
    admin: mergeAdminRoutes(listed.admin),
    ingress: mergeIngress(listed.ingress),
    help: stringOr(listed.admin?.help, WEBHOOK_TRIGGER_CATALOG_HELP),
    ingressHelp: stringOr(listed.ingress?.help, WEBHOOK_INGRESS_HELP),
  };
}

function defaultResolved(
  source: WebhookTriggerCatalogSource,
  help: string,
): WebhookTriggerResolved {
  return {
    source,
    routeMapSource: WEBHOOK_TRIGGER_ROUTE_MAP_SOURCE,
    apiPr: WEBHOOK_TRIGGER_API_PR,
    collection: WEBHOOK_TRIGGER_COLLECTION,
    permission: WEBHOOK_TRIGGER_MANAGE_PERMISSION,
    viewPermission: WEBHOOK_TRIGGER_VIEW_PERMISSION,
    csrf: true,
    secretNeverReturned: true,
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
    maxBodyBytes: WEBHOOK_TRIGGER_DEFAULT_MAX_BODY_BYTES,
    hardMaxBodyBytes: WEBHOOK_TRIGGER_HARD_MAX_BODY_BYTES,
    clockSkewSeconds: WEBHOOK_TRIGGER_DEFAULT_CLOCK_SKEW_SECONDS,
    hardClockSkewSeconds: WEBHOOK_TRIGGER_HARD_CLOCK_SKEW_SECONDS,
    replayRetentionSeconds: WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS,
    hardReplayRetentionSeconds: WEBHOOK_TRIGGER_HARD_REPLAY_SECONDS,
    defaultRatePerMinute: WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE,
    hardRatePerMinute: WEBHOOK_TRIGGER_HARD_RATE_PER_MINUTE,
    defaultWorkspaceRatePerMinute: WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_RATE,
    hardWorkspaceRatePerMinute: WEBHOOK_TRIGGER_HARD_WORKSPACE_RATE,
    defaultMaxConcurrency: WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENCY,
    hardMaxConcurrency: WEBHOOK_TRIGGER_HARD_MAX_CONCURRENCY,
    defaultWorkspaceMaxConcurrency: WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_CONCURRENCY,
    hardWorkspaceMaxConcurrency: WEBHOOK_TRIGGER_HARD_WORKSPACE_CONCURRENCY,
    contentTypes: [...WEBHOOK_ALLOWED_CONTENT_TYPES],
    admin: { ...WEBHOOK_TRIGGER_DEFAULT_ADMIN },
    ingress: { ...WEBHOOK_TRIGGER_DEFAULT_INGRESS },
    help,
    ingressHelp: WEBHOOK_INGRESS_HELP,
  };
}

function mergeAdminRoutes(listed?: CatalogTriggerAdmin): WebhookTriggerAdminRoutes {
  return {
    listRoute: catalogPath(listed?.listRoute, WEBHOOK_TRIGGER_DEFAULT_ADMIN.listRoute),
    createRoute: catalogPath(
      listed?.createRoute,
      WEBHOOK_TRIGGER_DEFAULT_ADMIN.createRoute,
    ),
    itemRoute: catalogPath(listed?.itemRoute, WEBHOOK_TRIGGER_DEFAULT_ADMIN.itemRoute),
    rotateRoute: catalogPath(
      listed?.rotateRoute,
      WEBHOOK_TRIGGER_DEFAULT_ADMIN.rotateRoute,
    ),
    disableRoute: catalogPath(
      listed?.disableRoute,
      WEBHOOK_TRIGGER_DEFAULT_ADMIN.disableRoute,
    ),
    enableRoute: catalogPath(
      listed?.enableRoute,
      WEBHOOK_TRIGGER_DEFAULT_ADMIN.enableRoute,
    ),
    deleteRoute: catalogPath(
      listed?.deleteRoute,
      WEBHOOK_TRIGGER_DEFAULT_ADMIN.deleteRoute,
    ),
  };
}

function mergeIngress(
  listed?: CatalogTriggerIngress,
): WebhookTriggerResolved["ingress"] {
  return {
    route: stringOr(listed?.route, WEBHOOK_TRIGGER_DEFAULT_INGRESS.route),
    method: stringOr(listed?.method, WEBHOOK_TRIGGER_DEFAULT_INGRESS.method),
    public: listed?.public !== false,
    csrf: listed?.csrf === true,
    session: listed?.session === true,
    signatureHeader: stringOr(
      listed?.signatureHeader,
      WEBHOOK_TRIGGER_DEFAULT_INGRESS.signatureHeader,
    ),
    timestampHeader: stringOr(
      listed?.timestampHeader,
      WEBHOOK_TRIGGER_DEFAULT_INGRESS.timestampHeader,
    ),
    signatureVersion: stringOr(
      listed?.signatureVersion,
      WEBHOOK_TRIGGER_DEFAULT_INGRESS.signatureVersion,
    ),
    idempotencyHeader: stringOr(
      listed?.idempotencyHeader,
      WEBHOOK_TRIGGER_DEFAULT_INGRESS.idempotencyHeader,
    ),
    help: stringOr(listed?.help, WEBHOOK_INGRESS_HELP),
  };
}

/** Strip HTTP method prefixes and /api/v1 from catalog route strings. */
export function catalogPath(route: string | undefined, fallback: string): string {
  const trimmed = route?.trim() ?? "";
  if (!trimmed) {
    return fallback;
  }
  const withoutMethod = trimmed.replace(
    /^(GET|POST|PATCH|PUT|DELETE)(\|(GET|POST|PATCH|PUT|DELETE))*\s+/i,
    "",
  );
  const withoutPrefix = withoutMethod.replace(/^\/api\/v1/, "");
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

function listedContentTypes(value: string[] | undefined): string[] {
  const items = (value ?? [])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : [...WEBHOOK_ALLOWED_CONTENT_TYPES];
}

export function webhookTriggerHelp(catalog?: WorkflowCatalog | null): string {
  const resolved = resolveWebhookTriggerContract(catalog);
  return resolved.source === "catalog-fallback"
    ? WEBHOOK_TRIGGER_CATALOG_FALLBACK_HELP
    : resolved.help || WEBHOOK_TRIGGER_CATALOG_HELP;
}

export function webhookIngressHelp(catalog?: WorkflowCatalog | null): string {
  return resolveWebhookTriggerContract(catalog).ingressHelp;
}

export function retargetWebhookTriggerApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function applyWebhookRouteTemplate(
  template: string,
  ids: { workflowId?: string; triggerId?: string; publicId?: string },
): string {
  const filled = catalogPath(template, template)
    .replaceAll("{workflowId}", ids.workflowId ?? "")
    .replaceAll("{workflow_id}", ids.workflowId ?? "")
    .replaceAll("{triggerId}", ids.triggerId ?? "")
    .replaceAll("{trigger_id}", ids.triggerId ?? "")
    .replaceAll("{publicId}", ids.publicId ?? "")
    .replaceAll("{public_id}", ids.publicId ?? "");
  return retargetWebhookTriggerApiPath(filled.startsWith("/") ? filled : `/${filled}`);
}

export function webhookTriggerListPath(
  workflowId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.listRoute,
    { workflowId },
  );
}

export function webhookTriggerCreatePath(
  workflowId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.createRoute,
    { workflowId },
  );
}

export function webhookTriggerPath(
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.itemRoute,
    { triggerId },
  );
}

export function webhookTriggerUpdatePath(
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return webhookTriggerPath(triggerId, catalog);
}

export function webhookTriggerDeletePath(
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.deleteRoute,
    { triggerId },
  );
}

export function webhookTriggerRotatePath(
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.rotateRoute,
    { triggerId },
  );
}

export function webhookTriggerDisablePath(
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.disableRoute,
    { triggerId },
  );
}

export function webhookTriggerEnablePath(
  triggerId: string,
  catalog?: WorkflowCatalog | null,
): string {
  return applyWebhookRouteTemplate(
    resolveWebhookTriggerContract(catalog).admin.enableRoute,
    { triggerId },
  );
}

export function webhookIngressPath(
  publicId: string,
  catalog?: WorkflowCatalog | null,
): string {
  const route = resolveWebhookTriggerContract(catalog).ingress.route;
  return applyWebhookRouteTemplate(route, { publicId });
}

/** Operator copy path. Keeps `/api/v1` — this is not a session UI route. */
export function webhookIngressDisplayPath(
  publicId: string,
  catalog?: WorkflowCatalog | null,
): string {
  const route = resolveWebhookTriggerContract(catalog).ingress.route;
  const path = route
    .replace(/^(GET|POST|PATCH|PUT|DELETE)(\|(GET|POST|PATCH|PUT|DELETE))*\s+/i, "")
    .replaceAll("{publicId}", publicId)
    .replaceAll("{public_id}", publicId);
  return path.startsWith("/") ? path : `/${path}`;
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

export function isWebhookPublicId(value: string | undefined): boolean {
  return Boolean(value && WEBHOOK_PUBLIC_ID_RE.test(value));
}

/** Item routes accept a UUID or opaque publicId (`wh_` + 64 hex). */
export function isWebhookTriggerRef(value: string | undefined): boolean {
  return isResourceId(value) || isWebhookPublicId(value);
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
  mapping: WebhookFieldMapping;
  errors: string[];
} {
  const errors: string[] = [];
  const mapping: WebhookFieldMapping = {};
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > WEBHOOK_TRIGGER_MAX_MAPPINGS) {
    errors.push(`Field mapping is limited to ${WEBHOOK_TRIGGER_MAX_MAPPINGS} rows.`);
    return { mapping: {}, errors };
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
    if (row.dest in mapping) {
      errors.push(`Destination ${row.dest} is already mapped.`);
      continue;
    }
    mapping[row.dest] = row.from;
  }
  return { mapping, errors };
}

export function fieldMappingText(mapping: WebhookFieldMapping): string {
  return Object.entries(mapping)
    .map(([dest, from]) => `${dest}: ${from}`)
    .join("\n");
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

export type WebhookDraftKind = "create" | "update";

export function validateWebhookTriggerDraft(
  draft: WebhookTriggerDraft,
  catalog?: WorkflowCatalog | null,
  kind: WebhookDraftKind = "create",
): { ok: true; settings: WebhookTriggerSettings; body: WebhookTriggerWriteBody } | {
  ok: false;
  errors: string[];
} {
  const resolved = resolveWebhookTriggerContract(catalog);
  const errors: string[] = [];
  if (!isResourceId(draft.workflowVersionId)) {
    errors.push("workflowVersionId must be a published version UUID.");
  }
  if (kind === "create") {
    if (draft.secretMode === "vault") {
      if (!isResourceId(draft.secretCredentialId)) {
        errors.push("Pick an active vault webhook_secret, or enter an inline secret.");
      }
    } else if (!draft.inlineSecret.trim()) {
      errors.push("Inline secret is required when not picking a vault webhook_secret.");
    }
  } else if (draft.secretMode === "inline" && draft.inlineSecret.trim()) {
    errors.push(WEBHOOK_ROTATE_SECRET_HELP);
  }
  const contentType = draft.contentType.trim().toLowerCase();
  if (!contentType) {
    errors.push("contentType is required.");
  } else if (!resolved.contentTypes.includes(contentType)) {
    errors.push(
      `contentType ${contentType} is not allowlisted. Supported: ${resolved.contentTypes.join(", ")}.`,
    );
  }
  const mapping = parseFieldMappingText(draft.fieldMappingText);
  errors.push(...mapping.errors);
  const maxBodyBytes = parseBoundedInt(
    draft.maxBodyBytes,
    1,
    resolved.hardMaxBodyBytes,
    "maxBodyBytes",
  );
  if (maxBodyBytes.error) {
    errors.push(maxBodyBytes.error);
  }
  const skew = parseBoundedInt(
    draft.clockSkewSeconds,
    1,
    resolved.hardClockSkewSeconds,
    "clockSkewSeconds",
  );
  if (skew.error) {
    errors.push(skew.error);
  }
  const replay = parseBoundedInt(
    draft.replayRetentionSeconds,
    1,
    resolved.hardReplayRetentionSeconds,
    "replayRetentionSeconds",
  );
  if (replay.error) {
    errors.push(replay.error);
  }
  if (!skew.error && !replay.error && replay.value < skew.value) {
    errors.push("replayRetentionSeconds must be at least clockSkewSeconds.");
  }
  const rate = parseBoundedInt(
    draft.rateLimitPerMinute,
    WEBHOOK_TRIGGER_MIN_RATE,
    resolved.hardRatePerMinute,
    "rateLimitPerMinute",
  );
  if (rate.error) {
    errors.push(rate.error);
  }
  const workspaceRate = parseBoundedInt(
    draft.workspaceRatePerMinute,
    WEBHOOK_TRIGGER_MIN_RATE,
    resolved.hardWorkspaceRatePerMinute,
    "workspaceRatePerMinute",
  );
  if (workspaceRate.error) {
    errors.push(workspaceRate.error);
  }
  const concurrent = parseBoundedInt(
    draft.maxConcurrency,
    1,
    resolved.hardMaxConcurrency,
    "maxConcurrency",
  );
  if (concurrent.error) {
    errors.push(concurrent.error);
  }
  const workspaceConcurrent = parseBoundedInt(
    draft.workspaceMaxConcurrency,
    1,
    resolved.hardWorkspaceMaxConcurrency,
    "workspaceMaxConcurrency",
  );
  if (workspaceConcurrent.error) {
    errors.push(workspaceConcurrent.error);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const settings: WebhookTriggerSettings = {
    workflowVersionId: draft.workflowVersionId,
    contentType,
    maxBodyBytes: maxBodyBytes.value,
    clockSkewSeconds: skew.value,
    replayRetentionSeconds: replay.value,
    rateLimitPerMinute: rate.value,
    workspaceRatePerMinute: workspaceRate.value,
    maxConcurrency: concurrent.value,
    workspaceMaxConcurrency: workspaceConcurrent.value,
    fieldMapping: mapping.mapping,
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
  };
  return {
    ok: true,
    settings,
    body:
      kind === "create"
        ? webhookTriggerCreateBody(draft, settings)
        : webhookTriggerPatchBody(settings),
  };
}

export function webhookTriggerCreateBody(
  draft: WebhookTriggerDraft,
  settings: WebhookTriggerSettings,
): WebhookTriggerWriteBody {
  const body: WebhookTriggerWriteBody = {
    type: WEBHOOK_TRIGGER_TYPE,
    workflowVersionId: settings.workflowVersionId,
    contentType: settings.contentType,
    fieldMapping: { ...settings.fieldMapping },
    maxBodyBytes: settings.maxBodyBytes,
    clockSkewSeconds: settings.clockSkewSeconds,
    replayRetentionSeconds: settings.replayRetentionSeconds,
    rateLimitPerMinute: settings.rateLimitPerMinute,
    workspaceRatePerMinute: settings.workspaceRatePerMinute,
    maxConcurrency: settings.maxConcurrency,
    workspaceMaxConcurrency: settings.workspaceMaxConcurrency,
  };
  if (draft.secretMode === "vault") {
    body.secretCredentialId = draft.secretCredentialId;
  } else {
    body.secret = { secret: draft.inlineSecret };
  }
  return body;
}

export function webhookTriggerPatchBody(
  settings: WebhookTriggerSettings,
): WebhookTriggerWriteBody {
  return {
    workflowVersionId: settings.workflowVersionId,
    contentType: settings.contentType,
    fieldMapping: { ...settings.fieldMapping },
    maxBodyBytes: settings.maxBodyBytes,
    clockSkewSeconds: settings.clockSkewSeconds,
    replayRetentionSeconds: settings.replayRetentionSeconds,
    rateLimitPerMinute: settings.rateLimitPerMinute,
    workspaceRatePerMinute: settings.workspaceRatePerMinute,
    maxConcurrency: settings.maxConcurrency,
    workspaceMaxConcurrency: settings.workspaceMaxConcurrency,
  };
}

export function webhookTriggerRotateBody(secret: string): WebhookTriggerRotateBody {
  return { secret: { secret } };
}

export function rejectHostSuppliedWebhookBody<T extends Record<string, unknown>>(
  body: T,
): T {
  const copy = { ...body };
  for (const key of WEBHOOK_HOST_SUPPLIED_KEYS) {
    delete copy[key];
  }
  return copy;
}

export function stripUnexpectedWebhookSecret(payload: unknown): {
  leaked: boolean;
  strippedKeys: string[];
  record: Record<string, unknown>;
} {
  const strippedKeys: string[] = [];
  const sanitized = stripSecretFields(payload, strippedKeys);
  const record =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : {};
  let leaked = strippedKeys.some((key) =>
    WEBHOOK_SECRET_KEYS.includes(key as (typeof WEBHOOK_SECRET_KEYS)[number]),
  );
  for (const key of WEBHOOK_SECRET_KEYS) {
    if (key in record) {
      delete record[key];
      if (!strippedKeys.includes(key)) {
        strippedKeys.push(key);
      }
      leaked = true;
    }
  }
  for (const nested of ["secret", "reveal", "oneTime", "one_time"]) {
    if (nested in record) {
      delete record[nested];
      if (!strippedKeys.includes(nested)) {
        strippedKeys.push(nested);
      }
      leaked = true;
    }
  }
  return { leaked, strippedKeys, record };
}

export function parseWebhookTriggerRecord(
  payload: unknown,
  fallbackWorkflowId = "",
  catalog?: WorkflowCatalog | null,
): WebhookTriggerRecord | null {
  const { record } = stripUnexpectedWebhookSecret(payload);
  const source = unwrapTriggerRecord(record);
  const id = readString(source.id);
  const publicId = readString(source.publicId, source.public_id);
  if (!id && !publicId) {
    return null;
  }
  const resolvedPublicId = publicId || (isWebhookPublicId(id) ? id : "");
  const ingressPath =
    optionalString(source.ingressPath, source.ingress_path) ??
    (resolvedPublicId ? webhookIngressDisplayPath(resolvedPublicId, catalog) : "");
  return {
    id: id || resolvedPublicId,
    publicId: resolvedPublicId,
    ingressPath,
    workflowId: readString(source.workflowId, source.workflow_id) || fallbackWorkflowId,
    workflowVersionId: readString(
      source.workflowVersionId,
      source.workflow_version_id,
    ),
    type: WEBHOOK_TRIGGER_TYPE,
    status: readStatus(source.status),
    secretCredentialId: readString(
      source.secretCredentialId,
      source.secret_credential_id,
    ),
    contentType:
      optionalString(source.contentType, source.content_type) ?? "application/json",
    maxBodyBytes: positiveIntOr(
      numberish(source.maxBodyBytes ?? source.max_body_bytes),
      WEBHOOK_TRIGGER_DEFAULT_MAX_BODY_BYTES,
    ),
    clockSkewSeconds: positiveIntOr(
      numberish(source.clockSkewSeconds ?? source.clock_skew_seconds),
      WEBHOOK_TRIGGER_DEFAULT_CLOCK_SKEW_SECONDS,
    ),
    replayRetentionSeconds: positiveIntOr(
      numberish(source.replayRetentionSeconds ?? source.replay_retention_seconds),
      WEBHOOK_TRIGGER_DEFAULT_REPLAY_SECONDS,
    ),
    rateLimitPerMinute: positiveIntOr(
      numberish(source.rateLimitPerMinute ?? source.rate_limit_per_minute),
      WEBHOOK_TRIGGER_DEFAULT_RATE_PER_MINUTE,
    ),
    workspaceRatePerMinute: positiveIntOr(
      numberish(source.workspaceRatePerMinute ?? source.workspace_rate_per_minute),
      WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_RATE,
    ),
    maxConcurrency: positiveIntOr(
      numberish(source.maxConcurrency ?? source.max_concurrency),
      WEBHOOK_TRIGGER_DEFAULT_MAX_CONCURRENCY,
    ),
    workspaceMaxConcurrency: positiveIntOr(
      numberish(
        source.workspaceMaxConcurrency ?? source.workspace_max_concurrency,
      ),
      WEBHOOK_TRIGGER_DEFAULT_WORKSPACE_CONCURRENCY,
    ),
    fieldMapping: readFieldMapping(source.fieldMapping ?? source.field_mapping),
    signatureRequired: true,
    replayRequired: true,
    rawBodyBeforeParse: true,
    createdAt: optionalString(source.createdAt, source.created_at),
    updatedAt: optionalString(source.updatedAt, source.updated_at),
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
  catalog?: WorkflowCatalog | null,
): WebhookTriggerRecord[] {
  const records: WebhookTriggerRecord[] = [];
  for (const item of readItems(payload)) {
    const record = parseWebhookTriggerRecord(item, fallbackWorkflowId, catalog);
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

export function seedDraftFromRecord(
  record: WebhookTriggerRecord,
): WebhookTriggerDraft {
  return emptyWebhookTriggerDraft({
    workflowVersionId: record.workflowVersionId,
    secretMode: "vault",
    secretCredentialId: record.secretCredentialId,
    contentType: record.contentType,
    maxBodyBytes: String(record.maxBodyBytes),
    clockSkewSeconds: String(record.clockSkewSeconds),
    replayRetentionSeconds: String(record.replayRetentionSeconds),
    rateLimitPerMinute: String(record.rateLimitPerMinute),
    workspaceRatePerMinute: String(record.workspaceRatePerMinute),
    maxConcurrency: String(record.maxConcurrency),
    workspaceMaxConcurrency: String(record.workspaceMaxConcurrency),
    fieldMappingText: fieldMappingText(record.fieldMapping),
  });
}

export function seedDraftFromYaml(
  yaml: string | null | undefined,
): Partial<WebhookTriggerDraft> {
  const webhook = (yaml ? listYamlTriggers(yaml) : []).find(
    (item) => item.type === WEBHOOK_TRIGGER_TYPE,
  );
  if (!webhook) {
    return {};
  }
  const contentType = stringFromUnknown(
    webhook.with.contentType ?? webhook.with.content_type,
  );
  return {
    contentType: contentType || "application/json",
  };
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

export function isWebhookCatalogFallback(
  catalog?: WorkflowCatalog | null,
): boolean {
  return resolveWebhookTriggerContract(catalog).source === "catalog-fallback";
}

export function webhookMutationOutcomeMessage(
  action: "create" | "update" | "rotate" | "disable" | "enable" | "delete",
  leak?: WebhookSecretLeak,
): string {
  const base =
    action === "create"
      ? WEBHOOK_CREATED_MESSAGE
      : action === "update"
        ? WEBHOOK_UPDATED_MESSAGE
        : action === "rotate"
          ? WEBHOOK_ROTATED_MESSAGE
          : action === "disable"
            ? WEBHOOK_DISABLED_MESSAGE
            : action === "enable"
              ? WEBHOOK_ENABLED_MESSAGE
              : WEBHOOK_DELETED_MESSAGE;
  if (leak?.leaked) {
    return `${base} ${WEBHOOK_SECRET_LEAK_MESSAGE}`;
  }
  return base;
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

function readFieldMapping(value: unknown): WebhookFieldMapping {
  const mapping: WebhookFieldMapping = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [dest, from] of Object.entries(value as Record<string, unknown>)) {
      const source = stringFromUnknown(from);
      if (
        !dest ||
        !source ||
        isSecretFieldName(dest) ||
        isSecretFieldName(source)
      ) {
        continue;
      }
      mapping[dest] = source;
    }
    return mapping;
  }
  if (Array.isArray(value)) {
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
      mapping[dest] = from;
    }
  }
  return mapping;
}

function readStatus(value: unknown): WebhookTriggerStatus {
  const status = stringFromUnknown(value).toLowerCase();
  return status === "disabled" ? "disabled" : "enabled";
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
