import {
  APPROVERS_HEADING,
  APPROVERS_HELP,
  APPROVERS_NONE,
  approvalApproverSets,
  type ApprovalApprovers,
} from "@/lib/approval-approvers";

type ApprovalApproversListProps = {
  approvers?: ApprovalApprovers;
};

/**
 * Named approvers on a targeted gate: people and groups by display name,
 * with the UUID when a name is missing. Group members are never listed.
 * Untargeted gates render nothing.
 */
export function ApprovalApproversList({ approvers }: ApprovalApproversListProps) {
  const sets = approvalApproverSets(approvers);
  if (sets.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="approval-approvers-heading"
      data-approval-approvers=""
      className="space-y-2 rounded-xl border border-border bg-bg px-4 py-3"
    >
      <h3 id="approval-approvers-heading" className="text-sm font-semibold">
        {APPROVERS_HEADING}
      </h3>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {sets.map((set) => (
          <div key={set.kind} data-approval-approvers-set={set.kind}>
            <dt className="text-fg">{set.label}</dt>
            <dd>
              {set.items.length === 0 ? (
                <span className="text-fg/80">{APPROVERS_NONE}</span>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {set.items.map((item) => (
                    <li key={item.id} className="break-all">
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-fg">{APPROVERS_HELP}</p>
    </section>
  );
}
