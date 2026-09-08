import { safeProblemDetail, type ProblemDetails } from "@/lib/problem";
import { isCsrfProblem, isStaleSessionProblem } from "@/lib/session";

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
        "rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
      }
    >
      <p className="font-medium">
        {problem.title}
        {problem.status ? ` (${problem.status})` : null}
      </p>
      <p className="mt-1">{safeProblemDetail(problem.detail)}</p>
      {isStaleSessionProblem(problem) ? (
        <p className="mt-2">
          Stale or missing session.{" "}
          <a className="underline" href="#session">
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
      <dl className="mt-3 grid gap-1 font-mono text-xs text-amber-900/80 sm:grid-cols-2">
        <div>
          <dt className="inline text-amber-800/70">code </dt>
          <dd className="inline">{problem.code}</dd>
        </div>
        <div>
          <dt className="inline text-amber-800/70">request_id </dt>
          <dd className="inline break-all">{problem.request_id}</dd>
        </div>
      </dl>
    </div>
  );
}
