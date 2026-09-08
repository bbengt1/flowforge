import {
  attachCsrfHeader,
  captureCsrfFromResponse,
  missingCsrfProblem,
  resolveCsrfToken,
  shouldAttachCsrf,
} from "./csrf.ts";
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

export async function callIdentityProxy<T>(
  path: string,
  identity: DevIdentity,
  init: {
    method?: string;
    body?: unknown;
    mismatchWorkspaceId?: string;
    omitCsrf?: boolean;
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
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
    ...clientOperatorHeaders(identity, {
      sessionActive: session.active,
      headerFallback: headerFallbackEnabled(),
      mismatchWorkspaceId: init.mismatchWorkspaceId,
    }),
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
      headers: options.headers,
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
