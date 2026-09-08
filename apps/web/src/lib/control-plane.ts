import { getApiInternalUrl } from "./config";
import {
  isProblemContentType,
  isProblemDetails,
  PROBLEM_JSON,
  type ProblemDetails,
  unreachableProblem,
  upstreamProblem,
} from "./problem";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-id";

export type ControlPlaneSuccess = {
  ok: true;
  statusCode: number;
  requestId: string;
  contentType: string;
  status: string;
  body: unknown;
};

export type ControlPlaneFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  contentType: typeof PROBLEM_JSON;
  status: null;
  problem: ProblemDetails;
};

export type ControlPlaneResult = ControlPlaneSuccess | ControlPlaneFailure;

export type ControlPlaneProbe = {
  ok: boolean;
  statusCode: number | null;
  status: string | null;
  requestId: string | null;
  problem: ProblemDetails | null;
};

type FetchOptions = {
  requestId?: string;
  instance: string;
};

export async function fetchControlPlane(
  path: string,
  options: FetchOptions,
): Promise<ControlPlaneResult> {
  const requestId = resolveRequestId(options.requestId);
  const url = `${getApiInternalUrl()}${path}`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: {
        Accept: "application/json, application/problem+json",
        [REQUEST_ID_HEADER]: requestId,
      },
    });

    const echoed = resolveRequestId(
      response.headers.get(REQUEST_ID_HEADER) ?? requestId,
    );
    const contentType = response.headers.get("content-type");
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
        status: null,
        problem,
      };
    }

    const status = readStatusField(parsed);
    if (response.ok && status) {
      return {
        ok: true,
        statusCode: response.status,
        requestId: echoed,
        contentType: mediaType(contentType) || "application/json",
        status,
        body: parsed,
      };
    }

    const problem = upstreamProblem(response.status, options.instance, echoed);
    return {
      ok: false,
      statusCode: response.status,
      requestId: echoed,
      contentType: PROBLEM_JSON,
      status: null,
      problem,
    };
  } catch {
    const problem = unreachableProblem(options.instance, requestId);
    return {
      ok: false,
      statusCode: 503,
      requestId,
      contentType: PROBLEM_JSON,
      status: null,
      problem,
    };
  }
}

export function toProbe(
  result: ControlPlaneResult,
  expectedStatus?: string,
): ControlPlaneProbe {
  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode,
      status: null,
      requestId: result.requestId,
      problem: result.problem,
    };
  }

  const ok = expectedStatus ? result.status === expectedStatus : true;
  return {
    ok,
    statusCode: result.statusCode,
    status: result.status,
    requestId: result.requestId,
    problem: null,
  };
}

export async function probeFromProxyResponse(
  response: Response,
  fallbackRequestId: string,
): Promise<ControlPlaneProbe> {
  const requestId =
    response.headers.get(REQUEST_ID_HEADER) || fallbackRequestId;
  const contentType = response.headers.get("content-type");
  const parsed = await readJsonBody(response);

  if (isProblemContentType(contentType) || isProblemDetails(parsed)) {
    const problem = isProblemDetails(parsed)
      ? parsed
      : unreachableProblem(proxyInstanceFromUrl(response.url), requestId);
    return {
      ok: false,
      statusCode: response.status,
      status: null,
      requestId: problem.request_id || requestId,
      problem,
    };
  }

  const status = readStatusField(parsed);
  return {
    ok: response.ok && status !== null,
    statusCode: response.status,
    status,
    requestId,
    problem: null,
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readStatusField(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "status" in body &&
    typeof body.status === "string"
  ) {
    return body.status;
  }
  return null;
}

function mediaType(contentType: string | null): string {
  return contentType?.split(";")[0]?.trim() ?? "";
}

function proxyInstanceFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/api/control-plane";
  }
}
