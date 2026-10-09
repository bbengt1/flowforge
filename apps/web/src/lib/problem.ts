import {
  PROBLEM_HEADING_BAD_REQUEST,
  PROBLEM_HEADING_CONFLICT,
  PROBLEM_HEADING_FORBIDDEN,
  PROBLEM_HEADING_NOT_FOUND,
  PROBLEM_HEADING_RATE_LIMITED,
  PROBLEM_HEADING_SERVER,
  PROBLEM_HEADING_UNAUTHENTICATED,
  PROBLEM_HEADING_UNREACHABLE,
  PROBLEM_SENSITIVE_DETAIL,
} from "./problem-copy.ts";

/** Field-level workflow validation error from `invalid-workflow` problems. */
export type ProblemFieldError = {
  path: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
};

/** RFC 9457 problem details plus the FlowForge `code` and `request_id` fields. */
export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  request_id: string;
  /** Machine-readable cause on retry 409s. Never shown raw in the UI. */
  reason?: string;
  /** Free slug hint on a create or import slug 409. Never sent unasked. */
  suggestedSlug?: string;
  errors?: ProblemFieldError[];
};

export const PROBLEM_JSON = "application/problem+json";

const SENSITIVE_DETAIL =
  /password|secret|token|authorization|database_url|postgres:\/\//i;

export function isProblemContentType(contentType: string | null | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const media = contentType.split(";")[0]?.trim().toLowerCase();
  return media === PROBLEM_JSON;
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (!value || typeof value !== "object") {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    typeof body.type === "string" &&
    typeof body.title === "string" &&
    typeof body.status === "number" &&
    typeof body.detail === "string" &&
    typeof body.instance === "string" &&
    typeof body.code === "string" &&
    typeof body.request_id === "string"
  );
}

/** Copy `errors[]` from an invalid-workflow problem. Never invents a graph. */
export function problemFieldErrors(value: unknown): ProblemFieldError[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const raw = (value as Record<string, unknown>).errors;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ProblemFieldError[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.code !== "string" || typeof row.message !== "string") {
      continue;
    }
    const error: ProblemFieldError = {
      path: typeof row.path === "string" ? row.path : "",
      code: row.code,
      message: row.message,
    };
    if (typeof row.line === "number" && Number.isFinite(row.line)) {
      error.line = row.line;
    }
    if (typeof row.column === "number" && Number.isFinite(row.column)) {
      error.column = row.column;
    }
    out.push(error);
  }
  return out;
}

export function unreachableProblem(
  instance: string,
  requestId: string,
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:control-plane-unreachable",
    title: "Control Plane Unreachable",
    status: 503,
    detail: "Check your connection, then try again.",
    instance,
    code: "control-plane-unreachable",
    request_id: requestId,
  };
}

export function upstreamProblem(
  status: number,
  instance: string,
  requestId: string,
  detail = "FlowForge's server sent a response it couldn't read.",
): ProblemDetails {
  return {
    type: "urn:flowforge:problem:upstream-error",
    title: "Upstream Error",
    status,
    detail,
    instance,
    code: "upstream-error",
    request_id: requestId,
  };
}

/** UI-safe detail: never surface credentials or connection strings. */
export function safeProblemDetail(detail: string): string {
  if (!detail || SENSITIVE_DETAIL.test(detail)) {
    return PROBLEM_SENSITIVE_DETAIL;
  }
  return detail;
}

/**
 * ProblemBanner heading: a plain sentence for the status. Never shows the
 * HTTP status code or the API's reason phrase (such as "Conflict (409)").
 */
export function problemBannerHeading(
  problem: Pick<ProblemDetails, "title" | "status"> & { code?: string },
): string {
  const status = problem.status;
  if (problem.code === "control-plane-unreachable") {
    return PROBLEM_HEADING_UNREACHABLE;
  }
  if (status === 400 || status === 413 || status === 422) {
    return PROBLEM_HEADING_BAD_REQUEST;
  }
  if (status === 401) {
    return PROBLEM_HEADING_UNAUTHENTICATED;
  }
  if (status === 403) {
    return PROBLEM_HEADING_FORBIDDEN;
  }
  if (status === 404 || status === 410) {
    return PROBLEM_HEADING_NOT_FOUND;
  }
  if (status === 409 || status === 412) {
    return PROBLEM_HEADING_CONFLICT;
  }
  if (status === 429) {
    return PROBLEM_HEADING_RATE_LIMITED;
  }
  if (status >= 500) {
    return PROBLEM_HEADING_SERVER;
  }
  return problem.title || PROBLEM_HEADING_CONFLICT;
}
