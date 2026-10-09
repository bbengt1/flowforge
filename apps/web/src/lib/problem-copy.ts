/**
 * Plain words for API problems in the shared ProblemBanner. The banner
 * never shows HTTP status codes, problem codes, or the request_id field
 * name; a request id appears only as "Reference: <id>".
 */

/** Contract note. Not UI copy: never render it. */
export const PROBLEM_BANNER_CONTRACT_NOTE =
  "ProblemBanner reads RFC 9457 problem+json: title, status, detail, code, request_id. A CSRF problem means the proxy refused a state-changing request without a valid X-CSRF-Token (fail-closed). Status and code are never rendered; request_id renders as Reference.";

/** A state-changing request was refused because its CSRF check failed. */
export const PROBLEM_CSRF_HEADING =
  "FlowForge couldn't confirm this request came from this page.";

export const PROBLEM_CSRF_HELP =
  "Nothing was changed. Reload the page, then try again.";

/** The session behind the request ended or is missing. */
export const PROBLEM_STALE_SESSION_HELP = "Your session has ended.";

export const PROBLEM_STALE_SESSION_LINK = "Sign in again";

export const PROBLEM_HEADING_BAD_REQUEST = "FlowForge couldn't accept that.";
export const PROBLEM_HEADING_UNAUTHENTICATED = "You're signed out.";
export const PROBLEM_HEADING_FORBIDDEN = "You don't have access to do that.";
export const PROBLEM_HEADING_NOT_FOUND = "FlowForge couldn't find that.";
export const PROBLEM_HEADING_CONFLICT = "FlowForge couldn't do that.";
export const PROBLEM_HEADING_RATE_LIMITED =
  "Too many requests. Wait a moment, then try again.";
export const PROBLEM_HEADING_UNREACHABLE =
  "FlowForge's server didn't respond. Try again.";
export const PROBLEM_HEADING_SERVER = "Something went wrong in FlowForge. Try again.";

/** Shown instead of an API detail that looks like it holds a secret. */
export const PROBLEM_SENSITIVE_DETAIL =
  "FlowForge hid the details because they might include a secret.";
