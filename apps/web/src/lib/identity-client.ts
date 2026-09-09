import {
  attachCsrfHeader,
  captureCsrfFromResponse,
  missingCsrfProblem,
  resolveCsrfToken,
  shouldAttachCsrf,
} from "./csrf.ts";
import { attachEmbedWorkspaceHeaders } from "./embed-tenancy-client.ts";
import { headerFallbackEnabled } from "./header-fallback.ts";
import {
  clientOperatorHeaders,
  type DevIdentity,
} from "./identity-headers.ts";
import {
  isProblemContentType,
  isProblemDetails,
  type ProblemDetails,
  unreachableProblem,
  upstreamProblem,
} from "./problem.ts";
import { generateRequestId, REQUEST_ID_HEADER, resolveRequestId } from "./request-id.ts";
import { isStaleSessionProblem } from "./session.ts";
import { sameOriginProxyUrl } from "./session-contract.ts";
import {
  getSessionSnapshot,
  markSessionStale,
} from "./session-store.ts";

export type IdentityClientSuccess<T> = {
  ok: true;
  statusCode: number;
  requestId: string;
  data: T;
};

export type IdentityClientFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  problem: ProblemDetails;
};

export type IdentityClientResult<T> =
  | IdentityClientSuccess<T>
  | IdentityClientFailure;

export type IdentityStreamSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  blob: Blob;
  contentType: string | null;
  contentDisposition: string | null;
};

export type IdentityStreamResult = IdentityStreamSuccess | IdentityClientFailure;

export async function callIdentityProxy<T>(
  path: string,
  identity: DevIdentity,
  init: {
    method?: string;
    body?: unknown;
    mismatchWorkspaceId?: string;
    omitCsrf?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<IdentityClientResult<T>> {
  const requestId = generateRequestId();
  const method = init.method ?? "GET";
  const instance = sameOriginProxyUrl(path);
  if (!instance) {
    return {
      ok: false,
      statusCode: 400,
      requestId,
      problem: {
        type: "urn:flowforge:problem:invalid-request",
        title: "Invalid Request",
        status: 400,
        detail:
          "Browser session calls must use the same-origin /api/v1 proxy.",
        instance: path,
        code: "invalid-request",
        request_id: requestId,
      },
    };
  }

  const session = getSessionSnapshot();
  const extra = pickSafeClientHeaders(init.headers);
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
    ...clientOperatorHeaders(identity, {
      sessionActive: session.active,
      headerFallback: headerFallbackEnabled(),
      mismatchWorkspaceId: init.mismatchWorkspaceId,
    }),
    ...extra,
  };
  const hasBody = init.body !== undefined;
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  if (!init.omitCsrf) {
    const token = resolveCsrfToken();
    if (shouldAttachCsrf(method, instance) && session.active && !token) {
      return {
        ok: false,
        statusCode: 403,
        requestId,
        problem: missingCsrfProblem(instance, requestId),
      };
    }
    if (
      token &&
      (shouldAttachCsrf(method, instance) ||
        (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD"))
    ) {
      attachCsrfHeader(headers, token);
    }
  }

  return fetchSameOriginProxy<T>({
    instance,
    method,
    headers,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    requestId,
  });
}

/** GET bytes through the same-origin proxy. Never JSON-parses success bodies. */
export async function streamIdentityProxy(
  path: string,
  identity: DevIdentity,
): Promise<IdentityStreamResult> {
  const requestId = generateRequestId();
  const instance = sameOriginProxyUrl(path);
  if (!instance) {
    return {
      ok: false,
      statusCode: 400,
      requestId,
      problem: {
        type: "urn:flowforge:problem:invalid-request",
        title: "Invalid Request",
        status: 400,
        detail:
          "Browser session calls must use the same-origin /api/v1 proxy.",
        instance: path,
        code: "invalid-request",
        request_id: requestId,
      },
    };
  }

  const session = getSessionSnapshot();
  const headers: Record<string, string> = {
    Accept: "application/octet-stream, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
    ...clientOperatorHeaders(identity, {
      sessionActive: session.active,
      headerFallback: headerFallbackEnabled(),
    }),
  };

  try {
    const response = await fetch(instance, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers,
    });
    const echoed = resolveRequestId(
      response.headers.get(REQUEST_ID_HEADER) ?? requestId,
    );
    const contentType = response.headers.get("content-type");
    if (isProblemContentType(contentType) || !response.ok) {
      const parsed = await readJson(response);
      captureCsrfFromResponse(response.headers, parsed);
      const problem = isProblemDetails(parsed)
        ? parsed
        : upstreamProblem(
            response.status,
            instance,
            echoed,
            "The control plane returned a problem response that could not be parsed.",
          );
      if (isStaleSessionProblem(problem)) {
        markSessionStale();
      }
      return {
        ok: false,
        statusCode: response.status,
        requestId: problem.request_id || echoed,
        problem,
      };
    }
    const blob = await response.blob();
    captureCsrfFromResponse(response.headers, null);
    return {
      ok: true,
      statusCode: response.status,
      requestId: echoed,
      blob,
      contentType,
      contentDisposition: response.headers.get("content-disposition"),
    };
  } catch {
    const generated = resolveRequestId(requestId);
    return {
      ok: false,
      statusCode: 503,
      requestId: generated,
      problem: unreachableProblem(instance, generated),
    };
  }
}

export async function fetchSameOriginProxy<T>(options: {
  instance: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  requestId: string;
}): Promise<IdentityClientResult<T>> {
  try {
    const response = await fetch(options.instance, {
      method: options.method,
      cache: "no-store",
      credentials: "include",
      headers: attachEmbedWorkspaceHeaders(options.headers, options.instance),
      body: options.body,
    });
    const echoed = resolveRequestId(
      response.headers.get(REQUEST_ID_HEADER) ?? options.requestId,
    );
    const contentType = response.headers.get("content-type");

    if (response.status === 204) {
      captureCsrfFromResponse(response.headers, null);
      return {
        ok: true,
        statusCode: 204,
        requestId: echoed,
        data: undefined as T,
      };
    }

    const parsed = await readJson(response);
    captureCsrfFromResponse(response.headers, parsed);

    if (isProblemContentType(contentType) || isProblemDetails(parsed)) {
      const problem = isProblemDetails(parsed)
        ? parsed
        : upstreamProblem(
            response.status,
            options.instance,
            echoed,
            "The control plane returned a problem response that could not be parsed.",
          );
      if (isStaleSessionProblem(problem)) {
        markSessionStale();
      }
      return {
        ok: false,
        statusCode: response.status,
        requestId: problem.request_id || echoed,
        problem,
      };
    }

    if (response.ok) {
      return {
        ok: true,
        statusCode: response.status,
        requestId: echoed,
        data: parsed as T,
      };
    }

    return {
      ok: false,
      statusCode: response.status,
      requestId: echoed,
      problem: upstreamProblem(response.status, options.instance, echoed),
    };
  } catch {
    const generated = resolveRequestId(options.requestId);
    return {
      ok: false,
      statusCode: 503,
      requestId: generated,
      problem: unreachableProblem(options.instance, generated),
    };
  }
}

const BLOCKED_CLIENT_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
]);

/** Extra hop-by-hop-safe headers (If-Match). Never forwards Authorization. */
function pickSafeClientHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    const value = raw.trim();
    if (!value || BLOCKED_CLIENT_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}
