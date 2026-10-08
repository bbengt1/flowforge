import { useId } from "react";
import { shortDigest } from "@/lib/workflow";
import type { ApprovalBinding } from "@/lib/approval-types";

type ApprovalBindingSnapshotProps = {
  binding: ApprovalBinding;
  caption?: string;
};

export function ApprovalBindingSnapshot({
  binding,
  caption = "It no longer applies if the policy, target, or workflow version changes.",
}: ApprovalBindingSnapshotProps) {
  // Detail pages and run panels can show more than one snapshot.
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-border bg-bg px-4 py-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        What this approval covers
      </h3>
      <p className="mt-1 text-sm text-fg">{caption}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-fg">Workflow version</dt>
          <dd className="break-all font-mono text-xs">{binding.workflowVersionId}</dd>
        </div>
        <div>
          <dt className="text-fg">Version digest</dt>
          <dd className="break-all font-mono text-xs">
            {binding.workflowVersionDigest || "—"}
            {binding.workflowVersionDigest
              ? ` (${shortDigest(binding.workflowVersionDigest)})`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-fg">Target</dt>
          <dd className="break-all font-mono text-xs">
            {binding.targetName || binding.targetKind || "—"}
            {binding.targetId ? ` · ${binding.targetId}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-fg">Policy revision</dt>
          <dd className="break-all font-mono text-xs">
            {binding.policyRevisionId || "—"}
            {typeof binding.policyRevisionNumber === "number"
              ? ` · v${binding.policyRevisionNumber}`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-fg">Operation</dt>
          <dd className="font-mono text-xs">{binding.operation || "—"}</dd>
        </div>
        <div>
          <dt className="text-fg">Expiry</dt>
          <dd className="font-mono text-xs">{binding.expiresAt || "—"}</dd>
        </div>
        {binding.nodeId ? (
          <div>
            <dt className="text-fg">Node</dt>
            <dd className="font-mono text-xs">
              {binding.nodeName || binding.nodeId}
            </dd>
          </div>
        ) : null}
        {binding.bindingFingerprint ? (
          <div>
            <dt className="text-fg">Binding fingerprint</dt>
            <dd className="break-all font-mono text-xs">
              {binding.bindingFingerprint}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
