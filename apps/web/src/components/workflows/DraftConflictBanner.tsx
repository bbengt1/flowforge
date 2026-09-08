"use client";

import type { WorkflowDraft } from "@/lib/workflow-types";
import { ProblemBanner } from "@/components/ProblemBanner";
import type { ProblemDetails } from "@/lib/problem";

type DraftConflictBannerProps = {
  problem: ProblemDetails | null;
  serverDraft: WorkflowDraft | null;
  onReload: () => void;
};

export function DraftConflictBanner({
  problem,
  serverDraft,
  onReload,
}: DraftConflictBannerProps) {
  if (!serverDraft && !problem) {
    return null;
  }

  return (
    <div
      role="alert"
      className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <p className="font-medium">Draft revision conflict (409)</p>
      <p>
        Another save updated this draft. Reload the server YAML to continue —
        the editor is not overwritten until you confirm.
      </p>
      {serverDraft ? (
        <p className="font-mono text-xs text-amber-900/80">
          server revision {serverDraft.revision} · {serverDraft.digest}
        </p>
      ) : null}
      {problem ? <ProblemBanner problem={problem} className="border-amber-200 bg-amber-100/70 px-3 py-2" /> : null}
      <button
        type="button"
        onClick={onReload}
        className="rounded-lg border border-amber-800 bg-white px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-100"
      >
        Reload server draft
      </button>
    </div>
  );
}
