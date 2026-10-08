import { RequestReference } from "@/components/RequestReference";
import { problemBannerHeading, safeProblemDetail, type ProblemDetails } from "@/lib/problem";
import {
  PROBLEM_CSRF_HEADING,
  PROBLEM_CSRF_HELP,
  PROBLEM_STALE_SESSION_HELP,
  PROBLEM_STALE_SESSION_LINK,
} from "@/lib/problem-copy";
import { isCsrfProblem, isStaleSessionProblem } from "@/lib/session";
import { FF_SETTINGS_LINK_CLASS, FF_SETTINGS_SKIP_CLASS } from "@/lib/settings-wizard-visual";

type ProblemBannerProps = {
  problem: ProblemDetails;
  className?: string;
  /**
   * A plain sentence a surface already has for this failure, such as the
   * Start panel's bad-input or conflict sentence. It replaces the API's
   * heading and detail.
   */
  message?: string | null;
};

export function ProblemBanner({ problem, className, message }: ProblemBannerProps) {
  const csrf = isCsrfProblem(problem);
  return (
    <div
      role="alert"
      className={
        className ??
        `${FF_SETTINGS_SKIP_CLASS} px-4 py-3 text-sm`
      }
    >
      {message ? (
        <p className="font-medium">{message}</p>
      ) : csrf ? (
        <>
          <p className="font-medium">{PROBLEM_CSRF_HEADING}</p>
          <p className="mt-1">{PROBLEM_CSRF_HELP}</p>
        </>
      ) : (
        <>
          <p className="font-medium">{problemBannerHeading(problem)}</p>
          <p className="mt-1">{safeProblemDetail(problem.detail)}</p>
        </>
      )}
      {!message && isStaleSessionProblem(problem) ? (
        <p className="mt-2">
          {PROBLEM_STALE_SESSION_HELP}{" "}
          <a className={FF_SETTINGS_LINK_CLASS} href="#session">
            {PROBLEM_STALE_SESSION_LINK}
          </a>
          .
        </p>
      ) : null}
      <RequestReference id={problem.request_id} className="mt-3 text-xs opacity-80" />
    </div>
  );
}
