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
import { CSRF_HEADER } from "./session-contract.ts";

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
      s[4] === "export",
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

const RESOURCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workflow/version/execution path ids are UUIDs — never catalog/validate/normalize. */
export function isResourceId(value: string | undefined): boolean {
  return Boolean(value && RESOURCE_ID.test(value));
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

const IF_MATCH_HEADER = "If-Match";

/** Forwards If-Match so draft PUT can use revision + header concurrency. */
export function pickConditionalHeaders(
  source: Headers,
  target = new Headers(),
): Headers {
  const ifMatch = source.get(IF_MATCH_HEADER)?.trim();
  if (ifMatch) {
    target.set(IF_MATCH_HEADER, ifMatch);
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
