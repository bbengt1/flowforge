import { shortDigest } from "@/lib/workflow";
import type { ApprovalBinding } from "@/lib/approval-types";

type ApprovalBindingSnapshotProps = {
  binding: ApprovalBinding;
  caption?: string;
};

export function ApprovalBindingSnapshot({
  binding,
  caption = "Read-only binding snapshot. A later policy, target, or version change invalidates this approval.",
}: ApprovalBindingSnapshotProps) {
  return (
    <section
      aria-labelledby="approval-binding-heading"
      className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"
    >
      <h3 id="approval-binding-heading" className="text-sm font-semibold">
        Bound fields
      </h3>
      <p className="mt-1 text-sm text-zinc-600">{caption}</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-zinc-500">Workflow version</dt>
          <dd className="break-all font-mono text-xs">{binding.workflowVersionId}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Version digest</dt>
          <dd className="break-all font-mono text-xs">
            {binding.workflowVersionDigest || "—"}
            {binding.workflowVersionDigest
              ? ` (${shortDigest(binding.workflowVersionDigest)})`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Target</dt>
          <dd className="break-all font-mono text-xs">
            {binding.targetName || binding.targetKind || "—"}
            {binding.targetId ? ` · ${binding.targetId}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Policy revision</dt>
          <dd className="break-all font-mono text-xs">
            {binding.policyRevisionId || "—"}
            {typeof binding.policyRevisionNumber === "number"
              ? ` · v${binding.policyRevisionNumber}`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Operation</dt>
          <dd className="font-mono text-xs">{binding.operation || "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Expiry</dt>
          <dd className="font-mono text-xs">{binding.expiresAt || "—"}</dd>
        </div>
        {binding.nodeId ? (
          <div>
            <dt className="text-zinc-500">Node</dt>
            <dd className="font-mono text-xs">
              {binding.nodeName || binding.nodeId}
            </dd>
          </div>
        ) : null}
        {binding.bindingFingerprint ? (
          <div>
            <dt className="text-zinc-500">Binding fingerprint</dt>
            <dd className="break-all font-mono text-xs">
              {binding.bindingFingerprint}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
