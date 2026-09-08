import { getApiInternalUrl } from "./config.ts";
import { pickForwardedIdentityHeaders } from "./identity-headers.ts";
import {
  isProblemContentType,
  isProblemDetails,
  PROBLEM_JSON,
  type ProblemDetails,
  unreachableProblem,
  upstreamProblem,
} from "./problem.ts";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.ts";

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
];

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

  return {
    method,
    apiPath: `${API_PREFIX}/${segments.join("/")}`,
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
};

export type IdentityProxyFailure = {
  ok: false;
  statusCode: number;
  requestId: string;
  contentType: typeof PROBLEM_JSON;
  problem: ProblemDetails;
};

export type IdentityProxyResult = IdentityProxySuccess | IdentityProxyFailure;

export async function fetchIdentityControlPlane(options: {
  method: string;
  apiPath: string;
  instance: string;
  requestId?: string;
  identityHeaders: Headers;
  body?: string | null;
  contentType?: string | null;
}): Promise<IdentityProxyResult> {
  const requestId = resolveRequestId(options.requestId);
  const url = `${getApiInternalUrl()}${options.apiPath}`;
  const headers = pickForwardedIdentityHeaders(options.identityHeaders);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("Accept", "application/json, application/problem+json");
  if (options.body && options.method !== "GET" && options.method !== "HEAD") {
    headers.set(
      "Content-Type",
      mediaType(options.contentType) || "application/json",
    );
  }

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

    if (response.status === 204) {
      return {
        ok: true,
        statusCode: 204,
        requestId: echoed,
        contentType: null,
        body: null,
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
      };
    }

    if (response.ok) {
      return {
        ok: true,
        statusCode: response.status,
        requestId: echoed,
        contentType: mediaType(contentType) || "application/json",
        body: parsed,
      };
    }

    const problem = upstreamProblem(response.status, options.instance, echoed);
    return {
      ok: false,
      statusCode: response.status,
      requestId: echoed,
      contentType: PROBLEM_JSON,
      problem,
    };
  } catch {
    const problem = unreachableProblem(options.instance, requestId);
    return {
      ok: false,
      statusCode: 503,
      requestId,
      contentType: PROBLEM_JSON,
      problem,
    };
  }
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
