/**
 * #630: a refused action on the run page (retry, cancel, emergency stop,
 * artifact download, compare) keeps the run page in place. Only a 403 on
 * loading the run itself replaces the page with the forbidden view.
 *
 * Refusals are told apart by HTTP status and problem code. The one
 * exception is CSRF: the server answers a CSRF mismatch with 403
 * `forbidden` and the detail "CSRF validation failed.", so it is read
 * through the shared `isCsrfProblem`, which falls back to that text.
 */

import { EXECUTION_PROBLEM_CODES } from "./execution-contract.ts";
import { MFA_REQUIRED_CODE } from "./oidc-mfa.ts";
import type { ProblemDetails } from "./problem.ts";
import { isCsrfProblem } from "./session.ts";
import { SESSION_PROBLEM_CODES } from "./session-contract.ts";

/**
 * 403 codes about the session (step-up, a forced password change), not
 * about the person's role. They keep their own banner. CSRF is matched by
 * `isCsrfProblem` below.
 */
const SESSION_GATE_CODES: ReadonlySet<string> = new Set([
  SESSION_PROBLEM_CODES.passwordChangeRequired,
  MFA_REQUIRED_CODE,
]);

function isSessionGate(problem: ProblemDetails, statusCode: number): boolean {
  if (SESSION_GATE_CODES.has(problem.code)) {
    return true;
  }
  // The body's status may be missing; the response status still counts.
  return isCsrfProblem({ ...problem, status: problem.status || statusCode });
}

export type RunActionFailure = {
  /**
   * The person's role can't take this action. The run page shows the
   * action's own plain sentence next to the control and no banner.
   */
  roleRefused: boolean;
  /**
   * Goes to the run page's load problem. Never a 403, so the page is never
   * swapped for the forbidden view by an action.
   */
  pageProblem: ProblemDetails | null;
  /**
   * A non-role 403 (session gate). Shown as a banner above the page while
   * the run stays rendered.
   */
  actionProblem: ProblemDetails | null;
};

function isForbiddenFailure(
  problem: Pick<ProblemDetails, "code" | "status">,
  statusCode: number,
): boolean {
  return (
    statusCode === 403 ||
    problem.status === 403 ||
    problem.code === EXECUTION_PROBLEM_CODES.forbidden
  );
}

/** Sort a failed run-page action by status and code. */
export function runActionFailure(
  problem: ProblemDetails,
  statusCode: number,
): RunActionFailure {
  if (!isForbiddenFailure(problem, statusCode)) {
    return { roleRefused: false, pageProblem: problem, actionProblem: null };
  }
  if (isSessionGate(problem, statusCode)) {
    return { roleRefused: false, pageProblem: null, actionProblem: problem };
  }
  return { roleRefused: true, pageProblem: null, actionProblem: null };
}
