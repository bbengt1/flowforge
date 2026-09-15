import { problemBannerHeading, safeProblemDetail, type ProblemDetails } from "@/lib/problem";
import { isCsrfProblem, isStaleSessionProblem } from "@/lib/session";
import { FF_SETTINGS_LINK_CLASS, FF_SETTINGS_SKIP_CLASS } from "@/lib/settings-wizard-visual";

type ProblemBannerProps = {
  problem: ProblemDetails;
  className?: string;
};

export function ProblemBanner({ problem, className }: ProblemBannerProps) {
  return (
    <div
      role="alert"
      className={
        className ??
        `${FF_SETTINGS_SKIP_CLASS} px-4 py-3 text-sm`
      }
    >
      <p className="font-medium">{problemBannerHeading(problem)}</p>
      <p className="mt-1">{safeProblemDetail(problem.detail)}</p>
      {isStaleSessionProblem(problem) ? (
        <p className="mt-2">
          Stale or missing session.{" "}
          <a className={FF_SETTINGS_LINK_CLASS} href="#session">
            Re-establish the cookie session
          </a>
          .
        </p>
      ) : null}
      {isCsrfProblem(problem) ? (
        <p className="mt-2">
          CSRF fail-closed. The state-changing request was rejected.
        </p>
      ) : null}
      <dl className="mt-3 grid gap-1 font-mono text-xs sm:grid-cols-2">
        <div>
          <dt className="inline opacity-70">code </dt>
          <dd className="inline">{problem.code}</dd>
        </div>
        <div>
          <dt className="inline opacity-70">request_id </dt>
          <dd className="inline break-all">{problem.request_id}</dd>
        </div>
      </dl>
    </div>
  );
}
