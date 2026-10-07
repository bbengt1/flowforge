import { problemFieldErrors, type ProblemDetails } from "@/lib/problem";
import { approverPublishFieldErrors } from "@/lib/approval-approvers";

/**
 * Publish errors on a flow.approval step's with.approvers, placed by
 * errors[].path under the approver field label. Renders nothing for
 * any other problem.
 */
export function ApproverPublishErrors({ problem }: { problem: ProblemDetails | null }) {
  const items = approverPublishFieldErrors({ errors: problemFieldErrors(problem) });
  if (items.length === 0) {
    return null;
  }
  return (
    <ul data-approver-publish-errors="" className="space-y-2 text-sm">
      {items.map((item, index) => (
        <li
          key={`${item.path}-${index}`}
          data-approver-publish-error={item.field}
          className="rounded-lg border border-border px-3 py-2"
        >
          <p className="font-medium">{item.label}</p>
          <p className="mt-1">{item.message}</p>
          <p className="mt-1 break-all font-mono text-xs text-fg">{item.path}</p>
        </li>
      ))}
    </ul>
  );
}
