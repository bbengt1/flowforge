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
    detail: "The Go control plane did not respond.",
    instance,
    code: "control-plane-unreachable",
    request_id: requestId,
  };
}

export function upstreamProblem(
  status: number,
  instance: string,
  requestId: string,
  detail = `The control plane returned HTTP ${status} without problem details.`,
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
    return "The control plane reported an error. Sensitive detail was omitted.";
  }
  return detail;
}

/** ProblemBanner heading: existing chrome, including replay `409`. */
export function problemBannerHeading(problem: Pick<ProblemDetails, "title" | "status">): string {
  return problem.status ? `${problem.title} (${problem.status})` : problem.title;
}
