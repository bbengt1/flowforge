import { clientIsolationHeaders, type DevIdentity } from "./identity-headers";
import {
  isProblemContentType,
  isProblemDetails,
  type ProblemDetails,
  unreachableProblem,
  upstreamProblem,
} from "./problem";
import { generateRequestId, REQUEST_ID_HEADER, resolveRequestId } from "./request-id";

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

const PROXY_PREFIX = "/api/control-plane";

export async function callIdentityProxy<T>(
  path: string,
  identity: DevIdentity,
  init: { method?: string; body?: unknown; mismatchWorkspaceId?: string } = {},
): Promise<IdentityClientResult<T>> {
  const requestId = generateRequestId();
  const method = init.method ?? "GET";
  const instance = `${PROXY_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
    ...clientIsolationHeaders(identity, init.mismatchWorkspaceId),
  };
  const hasBody = init.body !== undefined;
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(instance, {
      method,
      cache: "no-store",
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
    const echoed = resolveRequestId(
      response.headers.get(REQUEST_ID_HEADER) ?? requestId,
    );
    const contentType = response.headers.get("content-type");

    if (response.status === 204) {
      return {
        ok: true,
        statusCode: 204,
        requestId: echoed,
        data: undefined as T,
      };
    }

    const parsed = await readJson(response);

    if (isProblemContentType(contentType) || isProblemDetails(parsed)) {
      const problem = isProblemDetails(parsed)
        ? parsed
        : upstreamProblem(
            response.status,
            instance,
            echoed,
            "The control plane returned a problem response that could not be parsed.",
          );
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
      problem: upstreamProblem(response.status, instance, echoed),
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
