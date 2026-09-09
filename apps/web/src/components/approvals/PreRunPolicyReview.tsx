import Link from "next/link";
import { ApprovalBindingSnapshot } from "@/components/approvals/ApprovalBindingSnapshot";
import { ApprovalValidityBanner } from "@/components/approvals/ApprovalValidityBanner";
import {
  canDispatchFromEvaluation,
  policyDecisionLabel,
} from "@/lib/approval";
import type { PolicyEvaluation } from "@/lib/approval-types";
import type { ProblemDetails } from "@/lib/problem";
import { ProblemBanner } from "@/components/ProblemBanner";

type PreRunPolicyReviewProps = {
  evaluation: PolicyEvaluation | null;
  pending: boolean;
  problem: ProblemDetails | null;
};

export function PreRunPolicyReview({
  evaluation,
  pending,
  problem,
}: PreRunPolicyReviewProps) {
  return (
    <section
      aria-labelledby="pre-run-policy-heading"
      className="rounded-xl border border-zinc-200 bg-white px-4 py-3"
    >
      <h3 id="pre-run-policy-heading" className="text-sm font-semibold">
        Pre-run policy review
      </h3>
      <p className="mt-1 text-sm text-zinc-600">
        Policy is evaluated on the server before dispatch. A stale local
        &quot;approved&quot; flag never starts a run.{" "}
        <code className="font-mono text-xs">dispatchAllowed</code> is
        authoritative.
      </p>
      {pending ? (
        <p className="mt-3 text-sm text-zinc-600">Evaluating policy…</p>
      ) : null}
      {problem ? <ProblemBanner problem={problem} className="mt-3" /> : null}
      {evaluation ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm">
            Decision:{" "}
            <span className="font-medium">
              {policyDecisionLabel(evaluation.decision)}
            </span>
            {evaluation.operation ? (
              <span className="font-mono text-xs text-zinc-600">
                {" "}
                · {evaluation.operation}
              </span>
            ) : null}
          </p>
          {canDispatchFromEvaluation(evaluation) ? (
            <p className="text-sm text-zinc-600">
              Server evaluation allows dispatch of this published version.
            </p>
          ) : (
            <p className="text-sm text-zinc-600">
              Run stays blocked until the server returns{" "}
              <code className="font-mono text-xs">dispatchAllowed</code>.
            </p>
          )}
          {evaluation.denied.map((item, index) => (
            <p
              key={`${item.nodeId}-${item.operation}-${index}`}
              className="text-sm text-rose-900"
            >
              Denied {item.operation || "operation"}
              {item.nodeId ? ` (${item.nodeId})` : ""}: {item.reason || "policy deny"}
            </p>
          ))}
          {evaluation.requirements.map((requirement, index) => (
            <p
              key={`${requirement.nodeId}-${requirement.operation}-${index}`}
              className="text-sm text-zinc-700"
            >
              Requires approval for{" "}
              <code className="font-mono text-xs">{requirement.operation}</code>
              {requirement.approverRole
                ? ` · role ${requirement.approverRole}`
                : ""}
              {requirement.reason ? ` — ${requirement.reason}` : ""}
            </p>
          ))}
          {evaluation.approvals.map((item) => (
            <div key={item.id} className="space-y-2">
              <ApprovalValidityBanner approval={item} />
              <ApprovalBindingSnapshot binding={item.binding} />
              <p className="text-sm">
                <Link
                  href={`/approvals/${item.id}`}
                  className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                >
                  Open approval {item.id}
                </Link>
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
