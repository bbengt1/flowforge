/**
 * Single retarget adapter for Chloe's E10.3 schedule admin UI.
 *
 * Wired to jonny's **#116** map on `main` (`e103-#116`).
 *
 * Admin (cookie session + `X-CSRF-Token` on POST/PATCH/DELETE):
 *   GET  /schedules/catalog
 *   GET  /schedules?workflowId=
 *   POST /schedules
 *   GET|PATCH|DELETE /schedules/{scheduleId}
 *   POST /schedules/{scheduleId}/enable|disable
 * Operator tick (not public ingress):
 *   POST /schedules/dispatch  {scheduleId?}
 * Catalog: GET /workflows/catalog `triggers[type=schedule].admin`
 *          + GET /schedules/catalog
 *
 * Required IANA timezone; cron XOR interval (interval max P7D).
 * Defaults: overlapPolicy=skip, misfirePolicy=ignore, catchUp=0.
 * Pins published workflowVersionId only. Host-supplied id/workspaceId is 400.
 *
 * Relates to #108 / Part of #105. Keep #108 open.
 * Do not change `apps/api`. Do not invent `/executions/{id}/resume`.
 */

import { isCsrfProblem, isUnauthenticatedProblem } from "./session.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { listYamlTriggers } from "./workflow-yaml-nodes.ts";
import type { CatalogTriggerAdmin, WorkflowCatalog } from "./workflow-types.ts";
import {
  canCreateWorkflows,
  canExecuteWorkflows,
  canSeeWorkflowsNav,
} from "./workspace-nav.ts";
import type { ProblemDetails } from "./problem.ts";

export const SCHEDULE_TRIGGER_STORY = 108;
export const SCHEDULE_TRIGGER_EPIC = 105;
/** Jonny's E10.3 schedule + durable approval map on main. */
export const SCHEDULE_TRIGGER_API_PR = 116;
export const SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE = "e103-#116" as const;
export const SCHEDULE_TRIGGER_SEMANTICS = "E10.3" as const;

export const SCHEDULE_TRIGGER_TYPE = "schedule" as const;
export const SCHEDULE_TRIGGER_QUERY = "schedules";
export const SCHEDULE_TRIGGER_COLLECTION = "schedules";
export const SCHEDULE_CATALOG_ACTION = "catalog";
export const SCHEDULE_DISPATCH_ACTION = "dispatch";

export const SCHEDULE_TRIGGER_VIEW_PERMISSION = "workflow.view" as const;
export const SCHEDULE_TRIGGER_MANAGE_PERMISSION = "workflow.edit" as const;
export const SCHEDULE_TRIGGER_DISPATCH_PERMISSION = "workflow.execute" as const;

export const SCHEDULE_OVERLAP_POLICIES = ["skip", "reject", "queue"] as const;
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];

export const SCHEDULE_MISFIRE_POLICIES = ["ignore", "fire-once"] as const;
export type ScheduleMisfirePolicy = (typeof SCHEDULE_MISFIRE_POLICIES)[number];

export const SCHEDULE_EXPRESSION_KINDS = ["cron", "interval"] as const;
export type ScheduleExpressionKind = (typeof SCHEDULE_EXPRESSION_KINDS)[number];

export const SCHEDULE_TRIGGER_STATUSES = ["enabled", "disabled"] as const;
export type ScheduleTriggerStatus = (typeof SCHEDULE_TRIGGER_STATUSES)[number];

export const SCHEDULE_DEFAULT_OVERLAP: ScheduleOverlapPolicy = "skip";
export const SCHEDULE_DEFAULT_MISFIRE: ScheduleMisfirePolicy = "ignore";
export const SCHEDULE_DEFAULT_CATCH_UP = 0;
export const SCHEDULE_MAX_CATCH_UP = 5;
export const SCHEDULE_DEFAULT_TIMEZONE = "UTC";
export const SCHEDULE_MAX_INTERVAL = "P7D";
export const SCHEDULE_MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

export const IANA_TIMEZONE_RE =
  /^(UTC|GMT|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;
export const CRON_FIVE_FIELD_RE =
  /^([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)$/;
export const ISO_DURATION_RE =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

export const COMMON_IANA_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Stockholm",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

export const SCHEDULE_YAML_FIELDS = [
  "timezone",
  "cron",
  "interval",
  "overlapPolicy",
  "misfirePolicy",
  "catchUp",
] as const;

export const SCHEDULE_HOST_SUPPLIED_KEYS = [
  "id",
  "workspaceId",
  "workspace_id",
] as const;

export const SCHEDULE_TRIGGER_PROBLEM_CODES = {
  invalidRequest: "invalid-request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  notFound: "not-found",
  conflict: "conflict",
} as const;

export const SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP =
  "Using marked catalog-fallback because GET /workflows/catalog triggers[type=schedule].admin and GET /schedules/catalog are missing. #116 collection stays GET|POST /schedules, GET|PATCH|DELETE /schedules/{scheduleId}, POST …/enable|disable, and POST /schedules/dispatch. Cookie session + X-CSRF-Token. camelCase. RFC 9457. Timezone-explicit; safe defaults are overlap=skip, misfire=ignore, catchUp=0. Cite #116. Relates to #108. Keep #108 open.";

export const SCHEDULE_TRIGGER_CATALOG_HELP =
  "Schedule admin follows GET /workflows/catalog triggers[type=schedule].admin and GET /schedules/catalog (#116). Mutations send X-CSRF-Token. Bind a published workflowVersionId. Timezone is IANA; cron XOR interval (max P7D); overlap and catch-up stay explicit.";

export const SCHEDULE_TIMEZONE_HELP =
  "Schedules are timezone-explicit. Use an IANA name such as UTC or America/Chicago. The scheduler is server-owned and does not inherit the browser timezone.";

export const SCHEDULE_EXPRESSION_HELP =
  "Exactly one of cron (5-field) or interval (ISO-8601 duration, max P7D). Expression and timezone are evaluated server-side.";

export const SCHEDULE_OVERLAP_HELP =
  "Safe default is skip: one active execution per schedule. reject fails a colliding tick. queue is opt-in and still version-pinned.";

export const SCHEDULE_CATCH_UP_HELP =
  "Safe default is no catch-up (0 / ignore misfire). catchUp is a bounded integer 0–5. fire-once misfire is the only bounded catch-up alternative.";

export const SCHEDULE_YAML_HELP =
  "Workflow YAML may declare timezone, cron or interval, overlapPolicy, misfirePolicy, and catchUp on type=schedule. Admin enable/disable and the published workflowVersionId pin live on the /schedules collection (#116).";

export const SCHEDULE_PUBLISHED_ONLY_HELP =
  "Schedules must pin a published workflowVersionId. Drafts are HTTP 400.";

export const SCHEDULE_DISPATCH_HELP =
  "POST /schedules/dispatch is an operator tick (workflow.execute + CSRF), not public ingress. Optional {scheduleId} limits the tick. Waiting jobs are not claimed from the browser.";

export const SCHEDULE_CSRF_HELP =
  "Create, patch, disable, enable, delete, and dispatch send X-CSRF-Token with the session cookie. Missing CSRF fails closed before the Go API is called.";

export const SCHEDULE_FORBIDDEN_MESSAGE =
  "Schedule changes require workflow.edit. HTTP 403 is fail-closed; this UI does not keep leftover rows.";

export const SCHEDULE_VIEW_FORBIDDEN_MESSAGE =
  "Listing schedules requires workflow.view. HTTP 403 is fail-closed; the list stays empty.";

export const SCHEDULE_DISPATCH_FORBIDDEN_MESSAGE =
  "Dispatching a schedule tick requires workflow.execute. HTTP 403 is fail-closed.";

export const SCHEDULE_UNAUTHENTICATED_MESSAGE =
  "Session is missing or stale (HTTP 401). Mutation is fail-closed; sign in again.";

export const SCHEDULE_CATALOG_FALLBACK_MESSAGE =
  "GET /workflows/catalog triggers[type=schedule].admin and GET /schedules/catalog are missing. Using marked catalog-fallback on the #116 /schedules collection. HTTP 404 is fail-closed — no local cron runner.";

export const SCHEDULE_HOST_SUPPLIED_MESSAGE =
  "Do not send id or workspaceId on writes. Workspace scope comes from the session and tenant + workbench headers. Host-supplied identity is HTTP 400.";

export const SCHEDULE_CREATED_MESSAGE =
  "Schedule created. Timezone, expression, overlap, and catch-up are explicit. The pin is a published workflow version.";

export const SCHEDULE_UPDATED_MESSAGE =
  "Schedule settings saved. Catch-up and overlap stay at the values you sent — safe defaults are skip / 0.";

export const SCHEDULE_DISABLED_MESSAGE =
  "Schedule disabled. The dispatcher will not start this pin until it is enabled again.";

export const SCHEDULE_ENABLED_MESSAGE =
  "Schedule enabled. Catch-up stays bounded and overlap stays explicit.";

export const SCHEDULE_DELETED_MESSAGE = "Schedule deleted.";

export const SCHEDULE_DISPATCHED_MESSAGE =
  "Schedule dispatch tick sent. This is an operator tick, not a public ingress.";

export type ScheduleTriggerRouteMapSource =
  | typeof SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE
  | `e103-#${number}`;

export type ScheduleTriggerCatalogSource =
  | "workflows-catalog"
  | "schedules-catalog"
  | "catalog-fallback";

export type ScheduleTypeCatalog = {
  statuses?: string[];
  overlapPolicies?: string[];
  misfirePolicies?: string[];
  defaultOverlapPolicy?: string;
  defaultMisfirePolicy?: string;
  defaultCatchUp?: number | boolean;
  maxCatchUp?: number;
  timezoneRequired?: boolean;
  safeDefaults?: string;
  failClosedUnpublished?: boolean;
  failClosedDisabled?: boolean;
  idempotencyKeyPattern?: string;
  dispatchRoute?: string;
  permission?: string;
  viewPermission?: string;
  dispatchPermission?: string;
  csrf?: boolean;
  help?: string;
};

export type ScheduleTriggerSettings = {
  workflowVersionId: string;
  timezone: string;
  expressionKind: ScheduleExpressionKind;
  cron: string;
  interval: string;
  overlapPolicy: ScheduleOverlapPolicy;
  misfirePolicy: ScheduleMisfirePolicy;
  catchUp: number;
};

export type ScheduleTriggerDraft = {
  workflowVersionId: string;
  timezone: string;
  expressionKind: ScheduleExpressionKind;
  cron: string;
  interval: string;
  overlapPolicy: ScheduleOverlapPolicy;
  misfirePolicy: ScheduleMisfirePolicy;
  catchUp: string;
};

export type ScheduleTriggerRecord = {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  workflowDigest?: string;
  triggerId?: string;
  type: typeof SCHEDULE_TRIGGER_TYPE;
  status: ScheduleTriggerStatus;
  timezone: string;
  cron: string;
  interval: string;
  overlapPolicy: ScheduleOverlapPolicy;
  misfirePolicy: ScheduleMisfirePolicy;
  catchUp: number;
  nextFireAt?: string;
  lastFiredAt?: string;
  lastExecutionId?: string;
  lastError?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ScheduleTriggerWriteBody = {
  workflowId?: string;
  workflowVersionId: string;
  timezone: string;
  cron?: string;
  interval?: string;
  overlapPolicy: ScheduleOverlapPolicy;
  misfirePolicy: ScheduleMisfirePolicy;
  catchUp: number;
};

export type ScheduleDispatchBody = {
  scheduleId?: string;
};

export type ScheduleDispatchItem = {
  scheduleId: string;
  executionId?: string;
  skipReason?: string;
  fireAt?: string;
  error?: string;
};

export type ScheduleTriggerAdminRoutes = {
  catalogRoute: string;
  listRoute: string;
  createRoute: string;
  itemRoute: string;
  disableRoute: string;
  enableRoute: string;
  deleteRoute: string;
  dispatchRoute: string;
};

export type ScheduleTriggerResolved = {
  source: ScheduleTriggerCatalogSource;
  routeMapSource: ScheduleTriggerRouteMapSource;
  apiPr: number;
  collection: string;
  permission: string;
  viewPermission: string;
  dispatchPermission: string;
  csrf: boolean;
  defaultOverlapPolicy: ScheduleOverlapPolicy;
  defaultMisfirePolicy: ScheduleMisfirePolicy;
  defaultCatchUp: number;
  maxCatchUp: number;
  overlapPolicies: readonly ScheduleOverlapPolicy[];
  misfirePolicies: readonly ScheduleMisfirePolicy[];
  expressionKinds: readonly ScheduleExpressionKind[];
  publishedVersionRequired: true;
  timezoneRequired: true;
  admin: ScheduleTriggerAdminRoutes;
  help: string;
};

export const SCHEDULE_TRIGGER_DEFAULT_ADMIN: ScheduleTriggerAdminRoutes = {
  catalogRoute: "/schedules/catalog",
  listRoute: "/schedules",
  createRoute: "/schedules",
  itemRoute: "/schedules/{scheduleId}",
  disableRoute: "/schedules/{scheduleId}/disable",
  enableRoute: "/schedules/{scheduleId}/enable",
  deleteRoute: "/schedules/{scheduleId}",
  dispatchRoute: "/schedules/dispatch",
};

export function emptyScheduleTriggerDraft(
  seed: Partial<ScheduleTriggerDraft> = {},
): ScheduleTriggerDraft {
  return {
    workflowVersionId: seed.workflowVersionId ?? "",
    timezone: seed.timezone ?? SCHEDULE_DEFAULT_TIMEZONE,
    expressionKind: seed.expressionKind ?? "cron",
    cron: seed.cron ?? "0 0 * * *",
    interval: seed.interval ?? "",
    overlapPolicy: seed.overlapPolicy ?? SCHEDULE_DEFAULT_OVERLAP,
    misfirePolicy: seed.misfirePolicy ?? SCHEDULE_DEFAULT_MISFIRE,
    catchUp: seed.catchUp ?? String(SCHEDULE_DEFAULT_CATCH_UP),
  };
}

export function resolveScheduleTriggerContract(
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): ScheduleTriggerResolved {
  const listed = catalog?.triggers?.find(
    (item) => item.type === SCHEDULE_TRIGGER_TYPE,
  );
  const hasWorkflowAdmin = Boolean(listed?.admin);
  const hasScheduleCatalog = Boolean(
    scheduleCatalog &&
      (scheduleCatalog.dispatchRoute ||
        scheduleCatalog.help ||
        scheduleCatalog.overlapPolicies?.length ||
        scheduleCatalog.defaultOverlapPolicy),
  );
  const source: ScheduleTriggerCatalogSource = hasWorkflowAdmin
    ? "workflows-catalog"
    : hasScheduleCatalog
      ? "schedules-catalog"
      : "catalog-fallback";
  const help = stringOr(
    listed?.admin?.help ?? scheduleCatalog?.help ?? listed?.schedule?.help,
    source === "catalog-fallback"
      ? SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP
      : SCHEDULE_TRIGGER_CATALOG_HELP,
  );
  return {
    ...defaultResolved(source, help),
    permission: stringOr(
      listed?.admin?.permission ?? scheduleCatalog?.permission,
      SCHEDULE_TRIGGER_MANAGE_PERMISSION,
    ),
    viewPermission: stringOr(
      listed?.admin?.viewPermission ?? scheduleCatalog?.viewPermission,
      SCHEDULE_TRIGGER_VIEW_PERMISSION,
    ),
    dispatchPermission: stringOr(
      listed?.admin?.dispatchPermission ?? scheduleCatalog?.dispatchPermission,
      SCHEDULE_TRIGGER_DISPATCH_PERMISSION,
    ),
    csrf: listed?.admin?.csrf !== false && scheduleCatalog?.csrf !== false,
    defaultOverlapPolicy: requireOverlap(
      listed?.schedule?.defaultOverlapPolicy ??
        scheduleCatalog?.defaultOverlapPolicy ??
        "",
      SCHEDULE_DEFAULT_OVERLAP,
    ),
    defaultMisfirePolicy: requireMisfire(
      listed?.schedule?.defaultMisfirePolicy ??
        scheduleCatalog?.defaultMisfirePolicy ??
        "",
      SCHEDULE_DEFAULT_MISFIRE,
    ),
    defaultCatchUp: boundedCatchUp(
      listed?.schedule?.defaultCatchUp ?? scheduleCatalog?.defaultCatchUp,
      SCHEDULE_DEFAULT_CATCH_UP,
    ),
    maxCatchUp: positiveIntOr(
      listed?.schedule?.maxCatchUp ?? scheduleCatalog?.maxCatchUp,
      SCHEDULE_MAX_CATCH_UP,
    ),
    overlapPolicies: listedPolicies(
      listed?.schedule?.overlapPolicies ?? scheduleCatalog?.overlapPolicies,
      SCHEDULE_OVERLAP_POLICIES,
      isOverlap,
    ),
    misfirePolicies: listedPolicies(
      listed?.schedule?.misfirePolicies ?? scheduleCatalog?.misfirePolicies,
      SCHEDULE_MISFIRE_POLICIES,
      isMisfire,
    ),
    admin: mergeAdminRoutes(listed?.admin, scheduleCatalog),
    help,
  };
}

function defaultResolved(
  source: ScheduleTriggerCatalogSource,
  help: string,
): ScheduleTriggerResolved {
  return {
    source,
    routeMapSource: SCHEDULE_TRIGGER_ROUTE_MAP_SOURCE,
    apiPr: SCHEDULE_TRIGGER_API_PR,
    collection: SCHEDULE_TRIGGER_COLLECTION,
    permission: SCHEDULE_TRIGGER_MANAGE_PERMISSION,
    viewPermission: SCHEDULE_TRIGGER_VIEW_PERMISSION,
    dispatchPermission: SCHEDULE_TRIGGER_DISPATCH_PERMISSION,
    csrf: true,
    defaultOverlapPolicy: SCHEDULE_DEFAULT_OVERLAP,
    defaultMisfirePolicy: SCHEDULE_DEFAULT_MISFIRE,
    defaultCatchUp: SCHEDULE_DEFAULT_CATCH_UP,
    maxCatchUp: SCHEDULE_MAX_CATCH_UP,
    overlapPolicies: SCHEDULE_OVERLAP_POLICIES,
    misfirePolicies: SCHEDULE_MISFIRE_POLICIES,
    expressionKinds: SCHEDULE_EXPRESSION_KINDS,
    publishedVersionRequired: true,
    timezoneRequired: true,
    admin: { ...SCHEDULE_TRIGGER_DEFAULT_ADMIN },
    help,
  };
}

function mergeAdminRoutes(
  listed?: CatalogTriggerAdmin,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): ScheduleTriggerAdminRoutes {
  return {
    catalogRoute: catalogPath(
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.catalogRoute,
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.catalogRoute,
    ),
    listRoute: catalogPath(listed?.listRoute, SCHEDULE_TRIGGER_DEFAULT_ADMIN.listRoute),
    createRoute: catalogPath(
      listed?.createRoute,
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.createRoute,
    ),
    itemRoute: catalogPath(listed?.itemRoute, SCHEDULE_TRIGGER_DEFAULT_ADMIN.itemRoute),
    disableRoute: catalogPath(
      listed?.disableRoute,
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.disableRoute,
    ),
    enableRoute: catalogPath(
      listed?.enableRoute,
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.enableRoute,
    ),
    deleteRoute: catalogPath(
      listed?.deleteRoute,
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.deleteRoute,
    ),
    dispatchRoute: catalogPath(
      listed?.dispatchRoute ?? scheduleCatalog?.dispatchRoute,
      SCHEDULE_TRIGGER_DEFAULT_ADMIN.dispatchRoute,
    ),
  };
}

export function scheduleTriggerHelp(
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  const resolved = resolveScheduleTriggerContract(catalog, scheduleCatalog);
  return resolved.source === "catalog-fallback"
    ? SCHEDULE_TRIGGER_CATALOG_FALLBACK_HELP
    : resolved.help || SCHEDULE_TRIGGER_CATALOG_HELP;
}

export function retargetScheduleTriggerApiPath(uiApiPath: string): string {
  return uiApiPath;
}

export function applyScheduleRouteTemplate(
  template: string,
  ids: { workflowId?: string; scheduleId?: string; triggerId?: string },
): string {
  const scheduleId = ids.scheduleId ?? ids.triggerId ?? "";
  const filled = catalogPath(template, template)
    .replaceAll("{workflowId}", ids.workflowId ?? "")
    .replaceAll("{workflow_id}", ids.workflowId ?? "")
    .replaceAll("{scheduleId}", scheduleId)
    .replaceAll("{schedule_id}", scheduleId)
    .replaceAll("{triggerId}", scheduleId)
    .replaceAll("{trigger_id}", scheduleId);
  return retargetScheduleTriggerApiPath(
    filled.startsWith("/") ? filled : `/${filled}`,
  );
}

export function scheduleCatalogPath(
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.catalogRoute,
    {},
  );
}

export function scheduleTriggerListPath(
  workflowId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  const base = applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.listRoute,
    { workflowId },
  );
  if (/[?&]workflowId=/.test(base)) {
    return base;
  }
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}workflowId=${encodeURIComponent(workflowId)}`;
}

export function scheduleTriggerCreatePath(
  workflowId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.createRoute,
    { workflowId },
  );
}

export function scheduleTriggerPath(
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.itemRoute,
    { scheduleId },
  );
}

export function scheduleTriggerUpdatePath(
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return scheduleTriggerPath(scheduleId, catalog, scheduleCatalog);
}

export function scheduleTriggerDeletePath(
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.deleteRoute,
    { scheduleId },
  );
}

export function scheduleTriggerDisablePath(
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.disableRoute,
    { scheduleId },
  );
}

export function scheduleTriggerEnablePath(
  scheduleId: string,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.enableRoute,
    { scheduleId },
  );
}

export function scheduleDispatchPath(
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): string {
  return applyScheduleRouteTemplate(
    resolveScheduleTriggerContract(catalog, scheduleCatalog).admin.dispatchRoute,
    {},
  );
}

export function scheduleTriggersHref(workflowId?: string): string {
  if (workflowId && isResourceId(workflowId)) {
    return `/workflows?${SCHEDULE_TRIGGER_QUERY}=${encodeURIComponent(workflowId)}`;
  }
  return `/workflows?${SCHEDULE_TRIGGER_QUERY}=1`;
}

export function editorScheduleTriggersHref(workflowId: string): string {
  if (!isResourceId(workflowId)) {
    return "/workflows";
  }
  return `/workflows/${workflowId}#schedule-triggers`;
}

export function canViewScheduleTriggers(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canSeeWorkflowsNav(permissions);
}

export function canManageScheduleTriggers(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canCreateWorkflows(permissions);
}

export function canDispatchScheduleTriggers(
  permissions: readonly string[] | null | undefined,
): boolean {
  return canExecuteWorkflows(permissions);
}

export function isScheduleTriggerRef(value: string | undefined): boolean {
  return isResourceId(value);
}

export function isValidIanaTimezone(value: string | undefined): boolean {
  return Boolean(value && IANA_TIMEZONE_RE.test(value.trim()));
}

export function isValidCronExpression(value: string | undefined): boolean {
  return Boolean(value && CRON_FIVE_FIELD_RE.test(value.trim()));
}

export function isValidIsoDuration(value: string | undefined): boolean {
  return Boolean(value && ISO_DURATION_RE.test(value.trim()));
}

export function isoDurationSeconds(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  const match = trimmed.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match || trimmed === "P") {
    return null;
  }
  const years = Number(match[1] || 0);
  const months = Number(match[2] || 0);
  if (years > 0 || months > 0) {
    return null;
  }
  const weeks = Number(match[3] || 0);
  const days = Number(match[4] || 0);
  const hours = Number(match[5] || 0);
  const minutes = Number(match[6] || 0);
  const seconds = Number(match[7] || 0);
  const total =
    weeks * 7 * 24 * 60 * 60 +
    days * 24 * 60 * 60 +
    hours * 60 * 60 +
    minutes * 60 +
    seconds;
  return total > 0 ? total : null;
}

export function isValidScheduleInterval(value: string | undefined): boolean {
  const seconds = isoDurationSeconds(value);
  return seconds !== null && seconds <= SCHEDULE_MAX_INTERVAL_SECONDS;
}

export function validateScheduleTriggerDraft(
  draft: ScheduleTriggerDraft,
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
):
  | { ok: true; settings: ScheduleTriggerSettings; body: ScheduleTriggerWriteBody }
  | { ok: false; errors: string[] } {
  const resolved = resolveScheduleTriggerContract(catalog, scheduleCatalog);
  const errors: string[] = [];
  const workflowVersionId = draft.workflowVersionId.trim();
  if (!isResourceId(workflowVersionId)) {
    errors.push("Published workflowVersionId is required.");
  }
  const timezone = draft.timezone.trim();
  if (!isValidIanaTimezone(timezone)) {
    errors.push("timezone must be an IANA name such as UTC or America/Chicago.");
  }
  const kind = draft.expressionKind;
  const cron = draft.cron.trim();
  const interval = draft.interval.trim();
  if (kind === "cron") {
    if (!isValidCronExpression(cron)) {
      errors.push("cron must be a 5-field expression.");
    }
    if (interval) {
      errors.push("schedule requires exactly one of cron or interval.");
    }
  } else if (kind === "interval") {
    if (!isValidScheduleInterval(interval)) {
      errors.push("interval must be an ISO-8601 duration up to P7D.");
    }
  } else {
    errors.push("schedule requires exactly one of cron or interval.");
  }
  const overlapPolicy = asOverlap(draft.overlapPolicy, "");
  if (!overlapPolicy || !resolved.overlapPolicies.includes(overlapPolicy)) {
    errors.push("overlapPolicy must be skip, reject, or queue.");
  }
  const misfirePolicy = asMisfire(draft.misfirePolicy, "");
  if (!misfirePolicy || !resolved.misfirePolicies.includes(misfirePolicy)) {
    errors.push("misfirePolicy must be ignore or fire-once.");
  }
  const catchUpParsed = parseBoundedInt(
    draft.catchUp,
    0,
    resolved.maxCatchUp,
    "catchUp",
  );
  if (catchUpParsed.error) {
    errors.push(catchUpParsed.error);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const settings: ScheduleTriggerSettings = {
    workflowVersionId,
    timezone,
    expressionKind: kind,
    cron: kind === "cron" ? cron : "",
    interval: kind === "interval" ? interval : "",
    overlapPolicy: overlapPolicy as ScheduleOverlapPolicy,
    misfirePolicy: misfirePolicy as ScheduleMisfirePolicy,
    catchUp: catchUpParsed.value,
  };
  return { ok: true, settings, body: scheduleTriggerWriteBody(settings) };
}

export function scheduleTriggerWriteBody(
  settings: ScheduleTriggerSettings,
  workflowId?: string,
): ScheduleTriggerWriteBody {
  const body: ScheduleTriggerWriteBody = {
    workflowVersionId: settings.workflowVersionId,
    timezone: settings.timezone,
    overlapPolicy: settings.overlapPolicy,
    misfirePolicy: settings.misfirePolicy,
    catchUp: settings.catchUp,
  };
  if (workflowId && isResourceId(workflowId)) {
    body.workflowId = workflowId;
  }
  if (settings.expressionKind === "cron") {
    body.cron = settings.cron;
  } else {
    body.interval = settings.interval;
  }
  return rejectHostSuppliedScheduleBody(body) as ScheduleTriggerWriteBody;
}

export function hostSuppliedScheduleIdentityKeys(
  body: Record<string, unknown>,
): string[] {
  return SCHEDULE_HOST_SUPPLIED_KEYS.filter((key) => key in body);
}

export function rejectHostSuppliedScheduleBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if ((SCHEDULE_HOST_SUPPLIED_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function parseScheduleTypeCatalog(payload: unknown): ScheduleTypeCatalog | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  return {
    statuses: stringList(row.statuses),
    overlapPolicies: stringList(row.overlapPolicies),
    misfirePolicies: stringList(row.misfirePolicies),
    defaultOverlapPolicy: optionalString(row.defaultOverlapPolicy),
    defaultMisfirePolicy: optionalString(row.defaultMisfirePolicy),
    defaultCatchUp: numberish(row.defaultCatchUp),
    maxCatchUp: numberish(row.maxCatchUp),
    timezoneRequired: row.timezoneRequired !== false,
    safeDefaults: optionalString(row.safeDefaults),
    failClosedUnpublished: row.failClosedUnpublished === true,
    failClosedDisabled: row.failClosedDisabled === true,
    idempotencyKeyPattern: optionalString(row.idempotencyKeyPattern),
    dispatchRoute: optionalString(row.dispatchRoute),
    permission: optionalString(row.permission),
    viewPermission: optionalString(row.viewPermission),
    dispatchPermission: optionalString(row.dispatchPermission),
    csrf: row.csrf !== false,
    help: optionalString(row.help),
  };
}

export function parseScheduleTriggerRecord(
  payload: unknown,
  fallbackWorkflowId = "",
): ScheduleTriggerRecord | null {
  const source = unwrapTriggerRecord(payload);
  const listedType = readString(source.type);
  if (listedType && listedType !== SCHEDULE_TRIGGER_TYPE) {
    return null;
  }
  const id = readString(source.id);
  if (!isResourceId(id)) {
    return null;
  }
  const timezone = readString(source.timezone, source.timeZone, source.time_zone);
  const cron = readString(source.cron);
  const interval = readString(source.interval);
  if (!timezone && !cron && !interval) {
    const nestedSource = source.config ?? source.settings ?? source.with;
    if (nestedSource && typeof nestedSource === "object" && !Array.isArray(nestedSource)) {
      const nested = unwrapTriggerRecord(nestedSource);
      if (readString(nested.timezone, nested.cron, nested.interval)) {
        return parseScheduleTriggerRecord(
          { ...source, ...nested, id, type: SCHEDULE_TRIGGER_TYPE },
          fallbackWorkflowId,
        );
      }
    }
    return null;
  }
  if (!isValidIanaTimezone(timezone)) {
    return null;
  }
  return {
    id,
    workflowId:
      readString(source.workflowId, source.workflow_id) || fallbackWorkflowId,
    workflowVersionId: readString(
      source.workflowVersionId,
      source.workflow_version_id,
    ),
    workflowDigest: optionalString(source.workflowDigest, source.workflow_digest),
    triggerId: optionalString(source.triggerId, source.trigger_id),
    type: SCHEDULE_TRIGGER_TYPE,
    status: readStatus(source.status),
    timezone,
    cron,
    interval,
    overlapPolicy: requireOverlap(
      readString(source.overlapPolicy, source.overlap_policy),
      SCHEDULE_DEFAULT_OVERLAP,
    ),
    misfirePolicy: requireMisfire(
      readString(source.misfirePolicy, source.misfire_policy),
      SCHEDULE_DEFAULT_MISFIRE,
    ),
    catchUp: boundedCatchUp(source.catchUp ?? source.catch_up, SCHEDULE_DEFAULT_CATCH_UP),
    nextFireAt: optionalTime(source.nextFireAt, source.next_fire_at),
    lastFiredAt: optionalTime(source.lastFiredAt, source.last_fired_at),
    lastExecutionId: optionalString(
      source.lastExecutionId,
      source.last_execution_id,
    ),
    lastError: optionalString(source.lastError, source.last_error),
    createdAt: optionalTime(source.createdAt, source.created_at),
    updatedAt: optionalTime(source.updatedAt, source.updated_at),
  };
}

export function parseScheduleTriggerList(
  payload: unknown,
  fallbackWorkflowId = "",
): ScheduleTriggerRecord[] {
  const records: ScheduleTriggerRecord[] = [];
  for (const item of readItems(payload)) {
    const record = parseScheduleTriggerRecord(item, fallbackWorkflowId);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

export function parseScheduleDispatchItems(payload: unknown): ScheduleDispatchItem[] {
  const records: ScheduleDispatchItem[] = [];
  for (const item of readItems(payload)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const scheduleId = readString(row.scheduleId, row.schedule_id, row.id);
    if (!isResourceId(scheduleId)) {
      continue;
    }
    records.push({
      scheduleId,
      executionId: optionalString(row.executionId, row.execution_id),
      skipReason: optionalString(row.skipReason, row.skip_reason),
      fireAt: optionalTime(row.fireAt, row.fire_at),
      error: optionalString(row.error),
    });
  }
  return records;
}

export function seedDraftFromRecord(
  record: ScheduleTriggerRecord,
): ScheduleTriggerDraft {
  return emptyScheduleTriggerDraft({
    workflowVersionId: record.workflowVersionId,
    timezone: record.timezone,
    expressionKind: record.interval ? "interval" : "cron",
    cron: record.cron,
    interval: record.interval,
    overlapPolicy: record.overlapPolicy,
    misfirePolicy: record.misfirePolicy,
    catchUp: String(record.catchUp),
  });
}

export function seedDraftFromYaml(
  yaml: string | null | undefined,
): Partial<ScheduleTriggerDraft> {
  const first = yamlScheduleTriggers(yaml)[0];
  if (!first) {
    return {};
  }
  return {
    timezone: first.timezone || SCHEDULE_DEFAULT_TIMEZONE,
    expressionKind: first.interval ? "interval" : "cron",
    cron: first.cron,
    interval: first.interval,
    overlapPolicy: first.overlapPolicy || SCHEDULE_DEFAULT_OVERLAP,
    misfirePolicy: first.misfirePolicy || SCHEDULE_DEFAULT_MISFIRE,
    catchUp: String(first.catchUp),
  };
}

export function yamlScheduleTriggers(yaml: string | null | undefined): {
  id: string;
  timezone: string;
  cron: string;
  interval: string;
  overlapPolicy: ScheduleOverlapPolicy | "";
  misfirePolicy: ScheduleMisfirePolicy | "";
  catchUp: number;
}[] {
  if (!yaml?.trim()) {
    return [];
  }
  return listYamlTriggers(yaml)
    .filter((item) => item.type === SCHEDULE_TRIGGER_TYPE)
    .map((item) => ({
      id: item.id,
      timezone: stringFromUnknown(item.with.timezone),
      cron: stringFromUnknown(item.with.cron),
      interval: stringFromUnknown(item.with.interval),
      overlapPolicy: asOverlap(stringFromUnknown(item.with.overlapPolicy), ""),
      misfirePolicy: asMisfire(stringFromUnknown(item.with.misfirePolicy), ""),
      catchUp: boundedCatchUp(item.with.catchUp, SCHEDULE_DEFAULT_CATCH_UP),
    }));
}

export function isScheduleCatalogFallback(
  catalog?: WorkflowCatalog | null,
  scheduleCatalog?: ScheduleTypeCatalog | null,
): boolean {
  return resolveScheduleTriggerContract(catalog, scheduleCatalog).source ===
    "catalog-fallback";
}

export function scheduleTriggerAuthFailureMessage(
  problem: ProblemDetails | null | undefined,
): string {
  if (!problem) {
    return "";
  }
  if (isCsrfProblem(problem)) {
    return SCHEDULE_CSRF_HELP;
  }
  if (isUnauthenticatedProblem(problem)) {
    return SCHEDULE_UNAUTHENTICATED_MESSAGE;
  }
  if (
    problem.status === 403 ||
    problem.code === SCHEDULE_TRIGGER_PROBLEM_CODES.forbidden
  ) {
    return SCHEDULE_FORBIDDEN_MESSAGE;
  }
  return "";
}

export function isScheduleTriggerAuthFailure(
  problem: ProblemDetails | null | undefined,
): boolean {
  return Boolean(scheduleTriggerAuthFailureMessage(problem));
}

export function scheduleMutationOutcomeMessage(
  action: "create" | "update" | "disable" | "enable" | "delete" | "dispatch",
): string {
  switch (action) {
    case "create":
      return SCHEDULE_CREATED_MESSAGE;
    case "update":
      return SCHEDULE_UPDATED_MESSAGE;
    case "disable":
      return SCHEDULE_DISABLED_MESSAGE;
    case "enable":
      return SCHEDULE_ENABLED_MESSAGE;
    case "delete":
      return SCHEDULE_DELETED_MESSAGE;
    case "dispatch":
      return SCHEDULE_DISPATCHED_MESSAGE;
  }
}

export function scheduleExpressionLabel(record: {
  cron: string;
  interval: string;
}): string {
  if (record.cron) {
    return `cron ${record.cron}`;
  }
  if (record.interval) {
    return `interval ${record.interval}`;
  }
  return "no expression";
}

export type ScheduleProxyRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

/**
 * E10.3 /schedules allowlist (#116). identity-proxy spreads this so a
 * retarget only edits this adapter. Webhook /triggers stay in
 * webhook-trigger-contract.ts.
 */
export const SCHEDULE_TRIGGER_PROXY_ROUTES: readonly ScheduleProxyRoute[] = [
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 &&
      s[0] === SCHEDULE_TRIGGER_COLLECTION &&
      s[1] === SCHEDULE_CATALOG_ACTION,
  },
  {
    methods: ["GET", "POST"],
    match: (s) => s.length === 1 && s[0] === SCHEDULE_TRIGGER_COLLECTION,
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 2 &&
      s[0] === SCHEDULE_TRIGGER_COLLECTION &&
      s[1] === SCHEDULE_DISPATCH_ACTION,
  },
  {
    methods: ["GET", "PATCH", "DELETE"],
    match: (s) =>
      s.length === 2 &&
      s[0] === SCHEDULE_TRIGGER_COLLECTION &&
      isResourceId(s[1]),
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === SCHEDULE_TRIGGER_COLLECTION &&
      isResourceId(s[1]) &&
      (s[2] === "disable" || s[2] === "enable"),
  },
];

export function isScheduleTriggerProxySegments(segments: string[]): boolean {
  return SCHEDULE_TRIGGER_PROXY_ROUTES.some((route) => route.match(segments));
}

function catalogPath(listed: string | undefined, fallback: string): string {
  if (!listed?.trim()) {
    return fallback;
  }
  return listed
    .trim()
    .replace(/^(GET|POST|PATCH|PUT|DELETE)(\|(GET|POST|PATCH|PUT|DELETE))*\s+/i, "")
    .replace(/^\/api\/v1/, "")
    .replace(/^\/api\/control-plane/, "");
}

function unwrapTriggerRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const row = payload as Record<string, unknown>;
  if (row.schedule && typeof row.schedule === "object" && !Array.isArray(row.schedule)) {
    return row.schedule as Record<string, unknown>;
  }
  if (row.trigger && typeof row.trigger === "object" && !Array.isArray(row.trigger)) {
    return row.trigger as Record<string, unknown>;
  }
  return row;
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
  if (Array.isArray(body.schedules)) {
    return body.schedules;
  }
  if (Array.isArray(body.triggers)) {
    return body.triggers;
  }
  return [];
}

function readStatus(value: unknown): ScheduleTriggerStatus {
  const status = stringFromUnknown(value).toLowerCase();
  return status === "disabled" ? "disabled" : "enabled";
}

function isOverlap(value: string): value is ScheduleOverlapPolicy {
  return (SCHEDULE_OVERLAP_POLICIES as readonly string[]).includes(value);
}

function isMisfire(value: string): value is ScheduleMisfirePolicy {
  return (SCHEDULE_MISFIRE_POLICIES as readonly string[]).includes(value);
}

function asOverlap(value: string, fallback: ScheduleOverlapPolicy | ""): ScheduleOverlapPolicy | "" {
  return isOverlap(value) ? value : fallback;
}

function requireOverlap(
  value: string,
  fallback: ScheduleOverlapPolicy,
): ScheduleOverlapPolicy {
  return isOverlap(value) ? value : fallback;
}

function asMisfire(value: string, fallback: ScheduleMisfirePolicy | ""): ScheduleMisfirePolicy | "" {
  return isMisfire(value) ? value : fallback;
}

function requireMisfire(
  value: string,
  fallback: ScheduleMisfirePolicy,
): ScheduleMisfirePolicy {
  return isMisfire(value) ? value : fallback;
}

function listedPolicies<T extends string>(
  listed: string[] | undefined,
  fallback: readonly T[],
  guard: (value: string) => value is T,
): readonly T[] {
  if (!listed?.length) {
    return fallback;
  }
  const out = listed.filter(guard);
  return out.length > 0 ? out : fallback;
}

function boundedCatchUp(value: unknown, fallback: number): number {
  if (value === false) {
    return 0;
  }
  if (value === true) {
    return fallback;
  }
  const n = numberish(value);
  if (n === undefined) {
    return fallback;
  }
  if (n < 0) {
    return 0;
  }
  if (n > SCHEDULE_MAX_CATCH_UP) {
    return SCHEDULE_MAX_CATCH_UP;
  }
  return n;
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

function optionalTime(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?[0-9]+$/.test(value.trim())) {
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
