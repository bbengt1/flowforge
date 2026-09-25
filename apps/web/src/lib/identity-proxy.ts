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
import {
  isAlertProxySegments,
  retargetAlertApiPath,
} from "./alert-contract.ts";
import {
  isArtifactDownloadStreamSegments,
  isExecutionProxySegments,
  retargetExecutionApiPath,
} from "./execution-contract.ts";
import {
  isKubernetesProxySegments,
  retargetKubernetesApiPath,
} from "./kubernetes-contract.ts";
import {
  isSshProxySegments,
  retargetSshApiPath,
} from "./ssh-contract.ts";
import {
  isScriptProxySegments,
  retargetScriptApiPath,
} from "./script-contract.ts";
import {
  isScriptOpsProxySegments,
  retargetScriptOpsApiPath,
} from "./script-ops-contract.ts";
import {
  isHttpNotificationProxySegments,
  retargetHttpNotificationApiPath,
} from "./core-http-notification-contract.ts";
import { isResourceId } from "./identity-proxy-ids.ts";
import { CSRF_HEADER } from "./session-contract.ts";
import {
  isEmbedTenancyProxySegments,
  retargetEmbedTenancyApiPath,
} from "./embed-tenancy-contract.ts";
import {
  isSessionEmbedProxySegments,
  retargetSessionEmbedApiPath,
} from "./session-embed-contract.ts";
import { isWebhookTriggerRef } from "./webhook-trigger-contract.ts";
import { GENERATED_PROXY_ROUTES } from "./identity-proxy-allowlist.gen.ts";

export { isResourceId } from "./identity-proxy-ids.ts";

const API_PREFIX = "/api/v1";
const PROXY_PREFIX = "/api/control-plane";
const IDENTITY_TIMEOUT_MS = 8000;

type AllowedRoute = {
  methods: readonly string[];
  match: (segments: string[]) => boolean;
};

function proxyParamMatches(
  kind: "uuid" | "segment" | "trigger" | undefined,
  value: string,
): boolean {
  if (!value) {
    return false;
  }
  if (kind === "segment") {
    return true;
  }
  if (kind === "trigger") {
    return isWebhookTriggerRef(value);
  }
  return isResourceId(value);
}

function proxyPatternMatches(
  route: (typeof GENERATED_PROXY_ROUTES)[number],
  segments: string[],
): boolean {
  if (route.pattern.length !== segments.length) {
    return false;
  }
  return route.pattern.every((part, index) => {
    const value = segments[index] ?? "";
    if (part.startsWith("{") && part.endsWith("}")) {
      return proxyParamMatches(route.params[part.slice(1, -1)], value);
    }
    return part === value;
  });
}

// Browser allowlist generated from the API route table. Hand-written
// adapters such as WORKFLOW_FOLDER_PROXY_ROUTES are not a second list.
const ALLOWED_ROUTES: readonly AllowedRoute[] = GENERATED_PROXY_ROUTES.map(
  (route) => ({
    methods: route.methods,
    match: (segments) => proxyPatternMatches(route, segments),
  }),
);

/** Append the inbound query string so GET /workspace/records?kind= is mirrored. */
export function withRequestSearch(apiPath: string, requestUrl: string): string {
  try {
    const search = new URL(requestUrl).search;
    return search ? `${apiPath}${search}` : apiPath;
  } catch {
    return apiPath;
  }
}

export type IdentityProxyTarget = {
  method: string;
  apiPath: string;
  instance: string;
};

export type IdentityProxyDenial = {
  status: 403 | 404 | 405;
  problem: (instance: string, requestId: string) => ProblemDetails;
};

export type IdentityProxyContext = {
  embedSession?: boolean;
};

const EMBED_UI_PREFIX = "/embed/v1";

// requestIsEmbedSession is true when the browser Referer is the embed UI.
// The session cookie itself is opaque here. A missing Referer is not treated
// as embed; the API still refuses embed delete.
export function requestIsEmbedSession(headers: Headers): boolean {
  const referer = headers.get("referer") ?? headers.get("referrer") ?? "";
  if (!referer) {
    return false;
  }
  let path = "";
  try {
    path = new URL(referer).pathname;
  } catch {
    return false;
  }
  return path === EMBED_UI_PREFIX || path.startsWith(`${EMBED_UI_PREFIX}/`);
}

function embedWorkflowDelete(method: string, segments: string[]): boolean {
  return (
    method === "DELETE" && segments.length === 2 && segments[0] === "workflows"
  );
}

export function resolveIdentityProxyTarget(
  method: string,
  segments: string[],
  context?: IdentityProxyContext,
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

  if (context?.embedSession && embedWorkflowDelete(method, segments)) {
    return {
      status: 403,
      problem: (inst, requestId) =>
        embedDeleteForbiddenProblem(inst, requestId),
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

export function embedDeleteForbiddenProblem(
  instance: string,
  requestId: string,
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:forbidden",
    title: "Forbidden",
    status: 403,
    detail: "Embed sessions cannot delete workflows.",
    instance,
    code: "forbidden",
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
