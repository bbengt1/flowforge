import { getApiInternalUrl } from "./config.ts";
import { pickIsolationForwardedHeaders } from "./identity-headers.ts";
import {
  isProblemContentType,
  isProblemDetails,
  PROBLEM_JSON,
  type ProblemDetails,
  unreachableProblem,
  upstreamProblem,
} from "./problem.ts";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.ts";
import {
  collectSetCookies,
  rewriteUpstreamSetCookies,
} from "./session-cookies.ts";
import { APPROVAL_PROXY_ROUTES } from "./approval-contract.ts";
import { SCHEDULE_TRIGGER_PROXY_ROUTES } from "./schedule-trigger-contract.ts";
import { WEBHOOK_TRIGGER_PROXY_ROUTES } from "./webhook-trigger-contract.ts";
import {
  ALERT_PROXY_ROUTES,
  isAlertProxySegments,
  retargetAlertApiPath,
} from "./alert-contract.ts";
import {
  EXECUTION_PROXY_ROUTES,
  isArtifactDownloadStreamSegments,
  isExecutionProxySegments,
  retargetExecutionApiPath,
} from "./execution-contract.ts";
import {
  KUBERNETES_PROXY_ROUTES,
  isKubernetesProxySegments,
  retargetKubernetesApiPath,
} from "./kubernetes-contract.ts";
import {
  SSH_PROXY_ROUTES,
  isSshProxySegments,
  retargetSshApiPath,
} from "./ssh-contract.ts";
import {
  SCRIPT_PROXY_ROUTES,
  isScriptProxySegments,
  retargetScriptApiPath,
} from "./script-contract.ts";
import {
  SCRIPT_OPS_PROXY_ROUTES,
  isScriptOpsProxySegments,
  retargetScriptOpsApiPath,
} from "./script-ops-contract.ts";
import {
  HTTP_NOTIFICATION_PROXY_ROUTES,
  isHttpNotificationProxySegments,
  retargetHttpNotificationApiPath,
} from "./core-http-notification-contract.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { isOpsConfigCollection } from "./ops-config-contract.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import { EMBED_PROXY_ROUTES } from "./embed-contract.ts";
import { PORTAL_PROXY_ROUTES } from "./portal-adapter-contract.ts";
import {
  EMBED_TENANCY_PROXY_ROUTES,
  isEmbedTenancyProxySegments,
  retargetEmbedTenancyApiPath,
} from "./embed-tenancy-contract.ts";
import {
  isSessionEmbedProxySegments,
  retargetSessionEmbedApiPath,
} from "./session-embed-contract.ts";

export { isResourceId } from "./identity-proxy-ids.ts";

const API_PREFIX = "/api/v1";
const PROXY_PREFIX = "/api/control-plane";
const IDENTITY_TIMEOUT_MS = 8000;

type AllowedRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { methods: ["GET"], match: (s) => eq(s, ["permission-matrix"]) },
  { methods: ["GET"], match: (s) => eq(s, ["roles"]) },
  { methods: ["GET"], match: (s) => eq(s, ["permissions"]) },
  { methods: ["POST"], match: (s) => eq(s, ["tenants"]) },
  { methods: ["GET", "POST"], match: (s) => eq(s, ["workspaces"]) },
  { methods: ["GET"], match: (s) => eq(s, ["workspace"]) },
  { methods: ["GET", "PUT"], match: (s) => eq(s, ["workspace", "members"]) },
  {
    methods: ["DELETE"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workspace" &&
      s[1] === "members" &&
      Boolean(s[2]),
  },
  { methods: ["GET", "POST"], match: (s) => eq(s, ["workspace", "records"]) },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workspace" &&
      s[1] === "records" &&
      Boolean(s[2]),
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 4 &&
      s[0] === "workspace" &&
      s[1] === "credentials" &&
      s[3] === "use" &&
      Boolean(s[2]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workspace" &&
      s[1] === "artifacts" &&
      Boolean(s[2]),
  },
  { methods: ["GET", "POST"], match: (s) => eq(s, ["workspace", "jobs"]) },
  {
    methods: ["GET", "PUT"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workspace" &&
      s[1] === "cache" &&
      Boolean(s[2]),
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "workspace" &&
      s[1] === "realtime" &&
      s[2] === "channels" &&
      s[4] === "subscribe" &&
      Boolean(s[3]),
  },
  { methods: ["GET"], match: (s) => eq(s, ["workspace", "audit-events"]) },
  { methods: ["GET", "POST"], match: (s) => eq(s, ["session"]) },
  { methods: ["POST"], match: (s) => eq(s, ["session", "refresh"]) },
  { methods: ["POST"], match: (s) => eq(s, ["session", "logout"]) },
  { methods: ["GET"], match: (s) => eq(s, ["session", "audit-events"]) },
  // E11.1 embed catalog / JWKS / mint / exchange. Paths live in embed-contract.ts.
  ...EMBED_PROXY_ROUTES,
  // E11.2 tenancy retarget. Empty until jonny publishes new embed tenancy
  // routes. GET /workspace + GET /workspaces stay on the E2 allowlist.
  ...EMBED_TENANCY_PROXY_ROUTES,
  // E11.3 CP Ops Portal adapter. Catalog + role-mapped mint. Exchange stays embed.
  ...PORTAL_PROXY_ROUTES,
  { methods: ["GET"], match: (s) => eq(s, ["workflows", "catalog"]) },
  { methods: ["POST"], match: (s) => eq(s, ["workflows", "validate"]) },
  { methods: ["POST"], match: (s) => eq(s, ["workflows", "normalize"]) },
  { methods: ["GET", "POST"], match: (s) => eq(s, ["workflows"]) },
  {
    methods: ["GET"],
    match: (s) => s.length === 2 && s[0] === "workflows" && isResourceId(s[1]),
  },
  {
    methods: ["GET", "PUT"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "draft",
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      (s[2] === "publish" || s[2] === "compare" || s[2] === "executions"),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "executions",
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "versions",
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 4 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "versions" &&
      isResourceId(s[3]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "versions" &&
      isResourceId(s[3]) &&
      (s[4] === "export" || s[4] === "pins"),
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 5 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "versions" &&
      isResourceId(s[3]) &&
      s[4] === "restore",
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 4 &&
      s[0] === "workflows" &&
      isResourceId(s[1]) &&
      s[2] === "executions" &&
      isResourceId(s[3]),
  },
  // E4.1 vault UI (#35) stacked on jonny's #38 routes. Isolation hook
  // POST /workspace/credentials/{id}/use stays above this block.
  { methods: ["GET"], match: (s) => eq(s, ["credentials", "catalog"]) },
  { methods: ["GET", "POST"], match: (s) => eq(s, ["credentials"]) },
  {
    methods: ["GET", "PATCH", "DELETE"],
    match: (s) =>
      s.length === 2 && s[0] === "credentials" && isResourceId(s[1]),
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "credentials" &&
      isResourceId(s[1]) &&
      (s[2] === "rotate" ||
        s[2] === "disable" ||
        s[2] === "enable" ||
        s[2] === "test" ||
        s[2] === "use"),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      s[0] === "credentials" &&
      isResourceId(s[1]) &&
      (s[2] === "usage" || s[2] === "events" || s[2] === "deletion-impact"),
  },
  // E4.2 ops config UI aligned to #41 on main.
  { methods: ["GET"], match: (s) => eq(s, ["ops-config", "catalog"]) },
  { methods: ["POST"], match: (s) => eq(s, ["ops-config", "select"]) },
  { methods: ["GET"], match: (s) => eq(s, ["kubernetes", "catalog"]) },
  { methods: ["GET"], match: (s) => eq(s, ["ssh", "catalog"]) },
  {
    methods: ["GET", "POST"],
    match: (s) => s.length === 1 && isOpsConfigCollection(s[0]),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 2 && isOpsConfigCollection(s[0]) && isResourceId(s[1]),
  },
  {
    methods: ["GET", "PUT"],
    match: (s) =>
      s.length === 3 &&
      isOpsConfigCollection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === "draft",
  },
  {
    methods: ["POST"],
    match: (s) =>
      s.length === 3 &&
      isOpsConfigCollection(s[0]) &&
      isResourceId(s[1]) &&
      (s[2] === "publish" ||
        s[2] === "select" ||
        s[2] === "disable" ||
        s[2] === "enable"),
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 3 &&
      isOpsConfigCollection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === "versions",
  },
  {
    methods: ["GET"],
    match: (s) =>
      s.length === 4 &&
      isOpsConfigCollection(s[0]) &&
      isResourceId(s[1]) &&
      s[2] === "versions" &&
      isResourceId(s[3]),
  },
  // E10.2 webhook admin (#113). Paths live in webhook-trigger-contract.ts.
  ...WEBHOOK_TRIGGER_PROXY_ROUTES,
  // E10.3 schedules (#116). Paths live in schedule-trigger-contract.ts.
  ...SCHEDULE_TRIGGER_PROXY_ROUTES,
  // E4.3 policy-eval / approvals UI (#44 on main). Paths live in
  // approval-contract.ts.
  ...APPROVAL_PROXY_ROUTES,
  // E5.1/E5.2/E5.3 execution UI. Paths live in execution-contract.ts.
  // POST start stays above this block. Cancel/retry/downloads are CSRF
  // POSTs. Do not invent POST /executions or any /jobs/* worker route.
  // GET /workspace/artifacts/{id} above is the E2.2 isolation hook.
  // GET /artifact-downloads/{grantId} streams bytes (not JSON).
  ...EXECUTION_PROXY_ROUTES,
  // E5.4 alert/audit UI (#58). Paths live in alert-contract.ts.
  // GET /audit-events list stays on EXECUTION_PROXY_ROUTES. This
  // block adds GET /alerts, GET /alerts/{id}, and CSRF POST
  // /alerts/{id}/ack. No catalog, resolve, or GET
  // /audit-events/{id}. Do not allowlist audit mutations.
  // Isolation GET /workspace/audit-events stays above this block.
  ...ALERT_PROXY_ROUTES,
  // E7.1 cluster-target + Kubernetes policy UI (#70 / #74). Paths live
  // in kubernetes-contract.ts. Upstream is ops-config collections plus
  // GET /kubernetes/catalog. Duplicate ops-config allowlist matches
  // are intentional.
  ...KUBERNETES_PROXY_ROUTES,
  // E8.1 SSH target + command-profile UI (#82 / #86). Paths live in
  // ssh-contract.ts. Upstream is ops-config collections plus
  // GET /ssh/catalog. Duplicate allowlist matches are intentional.
  ...SSH_PROXY_ROUTES,
  // E9.1 script catalog / artifact UI (#92 / #97). Paths live in
  // script-contract.ts. GET /scripts/catalog, POST /scripts,
  // GET /scripts/{id}, GET …/script-artifacts. Never package blobs.
  ...SCRIPT_PROXY_ROUTES,
  // E9.4 revoke + emergency-stop UI (#95 / #103). Paths live in
  // script-ops-contract.ts. POST /scripts/{id}/revoke and
  // POST /executions/{id}/emergency-stop (+ step twin). CSRF POSTs.
  ...SCRIPT_OPS_PROXY_ROUTES,
  // E10.4 HTTP/notification catalog (#118). Paths live in
  // core-http-notification-contract.ts. GET /http/catalog only.
  // Connection / recipient / template collections stay on ops-config.
  ...HTTP_NOTIFICATION_PROXY_ROUTES,
];

/** Append the inbound query string so GET /workspace/records?kind= is mirrored. */
export function withRequestSearch(apiPath: string, requestUrl: string): string {
  try {
    const search = new URL(requestUrl).search;
    return search ? `${apiPath}${search}` : apiPath;
  } catch {
    return apiPath;
  }
}

function eq(segments: string[], expected: string[]): boolean {
  return (
    segments.length === expected.length &&
    expected.every((part, index) => segments[index] === part)
  );
}

export type IdentityProxyTarget = {
  method: string;
  apiPath: string;
  instance: string;
};

export type IdentityProxyDenial = {
  status: 404 | 405;
  problem: (instance: string, requestId: string) => ProblemDetails;
};

export function resolveIdentityProxyTarget(
  method: string,
  segments: string[],
): IdentityProxyTarget | IdentityProxyDenial {
  const known = ALLOWED_ROUTES.filter((route) => route.match(segments));
  const instance = `${PROXY_PREFIX}/${segments.join("/")}`;

  if (known.length === 0) {
    return {
      status: 404,
      problem: (inst, requestId) => notFoundProblem(inst, requestId),
    };
  }

  const allowed = known.find((route) => route.methods.includes(method));
  if (!allowed) {
    const allow = [...new Set(known.flatMap((route) => route.methods))].join(
      ", ",
    );
    return {
      status: 405,
      problem: (inst, requestId) =>
        methodNotAllowedProblem(inst, requestId, method, allow),
    };
  }

  const mapped = `${API_PREFIX}/${segments.join("/")}`;
  let apiPath = mapped;
  if (isExecutionProxySegments(segments)) {
    apiPath = retargetExecutionApiPath(mapped);
  } else if (isAlertProxySegments(segments)) {
    apiPath = retargetAlertApiPath(mapped);
  } else if (isKubernetesProxySegments(segments)) {
    apiPath = retargetKubernetesApiPath(mapped);
  } else if (isSshProxySegments(segments)) {
    apiPath = retargetSshApiPath(mapped);
  } else if (isScriptOpsProxySegments(segments)) {
    apiPath = retargetScriptOpsApiPath(mapped);
  } else if (isScriptProxySegments(segments)) {
    apiPath = retargetScriptApiPath(mapped);
  } else if (isHttpNotificationProxySegments(segments)) {
    apiPath = retargetHttpNotificationApiPath(mapped);
  } else if (isEmbedTenancyProxySegments(segments)) {
    apiPath = retargetEmbedTenancyApiPath(mapped);
  } else if (isSessionEmbedProxySegments(segments)) {
    apiPath = retargetSessionEmbedApiPath(mapped);
  }
  return {
    method,
    apiPath,
    instance,
  };
}

export function notFoundProblem(
  instance: string,
  requestId: string,
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:not-found",
    title: "Not Found",
    status: 404,
    detail: "The requested path does not exist.",
    instance,
    code: "not-found",
    request_id: requestId,
  };
}

export function methodNotAllowedProblem(
  instance: string,
  requestId: string,
  method: string,
  allow?: string,
): ProblemDetails {
  const suffix = allow ? ` Allowed: ${allow}.` : "";
  return {
    type: "urn:flowforge:problem:method-not-allowed",
    title: "Method Not Allowed",
    status: 405,
    detail: `The ${method} method is not allowed for this path.${suffix}`,
    instance,
    code: "method-not-allowed",
    request_id: requestId,
  };
}

export type IdentityProxySuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  contentType: string | null;
  body: unknown;
  setCookies: string[];
  csrfToken: string | null;
};

export type IdentityProxyFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  contentType: typeof PROBLEM_JSON;
  problem: ProblemDetails;
  setCookies: string[];
  csrfToken: string | null;
};

export type IdentityProxyResult = IdentityProxySuccess | IdentityProxyFailure;

export type IdentityProxyStreamSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  contentType: string | null;
  contentDisposition: string | null;
  cacheControl: string | null;
  body: ArrayBuffer;
  setCookies: string[];
  csrfToken: string | null;
};

export type IdentityProxyStreamResult =
  | IdentityProxyStreamSuccess
  | IdentityProxyFailure;

export function isArtifactDownloadStreamTarget(
  method: string,
  segments: string[],
): boolean {
  return method.toUpperCase() === "GET" && isArtifactDownloadStreamSegments(segments);
}

/** Never forward bucket URLs or header injection via Content-Disposition. */
export function sanitizeContentDisposition(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    return null;
  }
  if (/https?:|s3:|gs:|azblob:|storageRef/i.test(trimmed)) {
    return "attachment";
  }
  if (!/^attachment\b/i.test(trimmed)) {
    return "attachment";
  }
  return trimmed.slice(0, 256);
}

export async function fetchIdentityControlPlane(options: {
  method: string;
  apiPath: string;
  instance: string;
  requestId?: string;
  identityHeaders: Headers;
  body?: string | null;
  contentType?: string | null;
  requestSecure?: boolean;
}): Promise<IdentityProxyResult> {
  const requestId = resolveRequestId(options.requestId);
  const url = `${getApiInternalUrl()}${options.apiPath}`;
  const headers = pickIsolationForwardedHeaders(options.identityHeaders);
  pickSessionCredentialHeaders(options.identityHeaders, headers);
  pickConditionalHeaders(options.identityHeaders, headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("Accept", "application/json, application/problem+json");
  if (options.body && options.method !== "GET" && options.method !== "HEAD") {
    headers.set(
      "Content-Type",
      mediaType(options.contentType) || "application/json",
    );
  }

  // Never log Authorization, Cookie, or request bodies (vault create/rotate
  // carry plaintext once). Problem+json is returned to the caller only.
  try {
    const response = await fetch(url, {
      method: options.method,
      cache: "no-store",
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      headers,
      body:
        options.body && options.method !== "GET" && options.method !== "HEAD"
          ? options.body
          : undefined,
    });

    const echoed = resolveRequestId(
      response.headers.get(REQUEST_ID_HEADER) ?? requestId,
    );
    const contentType = response.headers.get("content-type");
    const setCookies = rewriteUpstreamSetCookies(collectSetCookies(response.headers), {
      requestSecure: options.requestSecure === true,
    });
    const csrfToken = response.headers.get(CSRF_HEADER)?.trim() || null;

    if (response.status === 204) {
      return {
        ok: true,
        statusCode: 204,
        requestId: echoed,
        contentType: null,
        body: null,
        setCookies,
        csrfToken,
      };
    }

    const parsed = await readJsonBody(response);

    if (isProblemContentType(contentType) || isProblemDetails(parsed)) {
      const problem = isProblemDetails(parsed)
        ? parsed
        : upstreamProblem(
            response.status,
            options.instance,
            echoed,
            "The control plane returned a problem response that could not be parsed.",
          );
      return {
        ok: false,
        statusCode: response.status,
        requestId: problem.request_id || echoed,
        contentType: PROBLEM_JSON,
        problem,
        setCookies,
        csrfToken,
      };
    }

    if (response.ok) {
      return {
        ok: true,
        statusCode: response.status,
        requestId: echoed,
        contentType: mediaType(contentType) || "application/json",
        body: parsed,
        setCookies,
        csrfToken,
      };
    }

    const problem = upstreamProblem(response.status, options.instance, echoed);
    return {
      ok: false,
      statusCode: response.status,
      requestId: echoed,
      contentType: PROBLEM_JSON,
      problem,
      setCookies,
      csrfToken,
    };
  } catch {
    const problem = unreachableProblem(options.instance, requestId);
    return {
      ok: false,
      statusCode: 503,
      requestId,
      contentType: PROBLEM_JSON,
      problem,
      setCookies: [],
      csrfToken: null,
    };
  }
}

/**
 * Binary hop for GET /artifact-downloads/{grantId}. Never JSON-parses
 * success bodies or logs bytes / grant tokens.
 */
export async function fetchIdentityControlPlaneStream(options: {
  method: string;
  apiPath: string;
  instance: string;
  requestId?: string;
  identityHeaders: Headers;
  requestSecure?: boolean;
}): Promise<IdentityProxyStreamResult> {
  const requestId = resolveRequestId(options.requestId);
  const url = `${getApiInternalUrl()}${options.apiPath}`;
  const headers = pickIsolationForwardedHeaders(options.identityHeaders);
  pickSessionCredentialHeaders(options.identityHeaders, headers);
  pickConditionalHeaders(options.identityHeaders, headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("Accept", "application/octet-stream, application/problem+json");

  try {
    const response = await fetch(url, {
      method: options.method,
      cache: "no-store",
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      headers,
    });

    const echoed = resolveRequestId(
      response.headers.get(REQUEST_ID_HEADER) ?? requestId,
    );
    const contentType = response.headers.get("content-type");
    const setCookies = rewriteUpstreamSetCookies(collectSetCookies(response.headers), {
      requestSecure: options.requestSecure === true,
    });
    const csrfToken = response.headers.get(CSRF_HEADER)?.trim() || null;
    const body = await response.arrayBuffer();

    if (isProblemContentType(contentType) || !response.ok) {
      const parsed = decodeJsonBuffer(body);
      const problem = isProblemDetails(parsed)
        ? parsed
        : upstreamProblem(
            response.status,
            options.instance,
            echoed,
            "The control plane returned a problem response that could not be parsed.",
          );
      return {
        ok: false,
        statusCode: response.status,
        requestId: problem.request_id || echoed,
        contentType: PROBLEM_JSON,
        problem,
        setCookies,
        csrfToken,
      };
    }

    return {
      ok: true,
      statusCode: response.status,
      requestId: echoed,
      contentType: mediaType(contentType) || "application/octet-stream",
      contentDisposition: response.headers.get("content-disposition"),
      cacheControl: response.headers.get("cache-control"),
      body,
      setCookies,
      csrfToken,
    };
  } catch {
    const problem = unreachableProblem(options.instance, requestId);
    return {
      ok: false,
      statusCode: 503,
      requestId,
      contentType: PROBLEM_JSON,
      problem,
      setCookies: [],
      csrfToken: null,
    };
  }
}

function decodeJsonBuffer(body: ArrayBuffer): unknown {
  if (body.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

const IF_MATCH_HEADER = "If-Match";
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Forwards If-Match and #111 Idempotency-Key. Never Authorization. */
export function pickConditionalHeaders(
  source: Headers,
  target = new Headers(),
): Headers {
  const ifMatch = source.get(IF_MATCH_HEADER)?.trim();
  if (ifMatch) {
    target.set(IF_MATCH_HEADER, ifMatch);
  }
  const idempotencyKey = source.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (idempotencyKey) {
    target.set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
  }
  return target;
}

/** Cookie + CSRF only. Authorization / bearer tokens are never forwarded. */
export function pickSessionCredentialHeaders(
  source: Headers,
  target = new Headers(),
): Headers {
  const cookie = source.get("cookie")?.trim();
  if (cookie) {
    target.set("Cookie", cookie);
  }
  const csrf = source.get(CSRF_HEADER)?.trim();
  if (csrf) {
    target.set(CSRF_HEADER, csrf);
  }
  return target;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mediaType(contentType: string | null | undefined): string {
  return contentType?.split(";")[0]?.trim() ?? "";
}
