"use client";

import { COMPARE_REDACTION_HELP } from "@/lib/execution-contract";
import type { ExecutionCompareResult } from "@/lib/execution-replay";
import { boundRedactedDisplay } from "@/lib/execution";
import type { CompareWorkflowResult } from "@/lib/workflow-types";

type ExecutionCompareProps = {
  result: ExecutionCompareResult | null;
  versionCompare?: CompareWorkflowResult | null;
};

export function ExecutionCompare({
  result,
  versionCompare,
}: ExecutionCompareProps) {
  if (!result && !versionCompare) {
    return null;
  }

  return (
    <section
      aria-labelledby="execution-compare-heading"
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <h2 id="execution-compare-heading" className="text-lg font-semibold">
        Compare
      </h2>
      <p className="mt-1 text-sm text-zinc-600">{COMPARE_REDACTION_HELP}</p>

      {result ? (
        <div className="mt-4 space-y-2 text-sm">
          <p>
            {result.equal ? "Executions match" : "Executions differ"}
            {result.digestMatch ? " · version digests match" : " · version digests differ"}
          </p>
          <p className="font-mono text-xs break-all text-zinc-500">
            left {result.leftLabel} · {result.leftDigest || "—"}
          </p>
          <p className="font-mono text-xs break-all text-zinc-500">
            right {result.rightLabel} · {result.rightDigest || "—"}
          </p>
          {result.changes.length === 0 ? (
            <p className="text-zinc-600">No redacted summary changes.</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-zinc-700">
              {result.changes.map((change, index) => (
                <li key={`${change.path}-${change.op}-${index}`}>
                  {change.op} {change.path || "(root)"}
                  <span className="block text-zinc-500">
                    {boundRedactedDisplay(change.left).text} →{" "}
                    {boundRedactedDisplay(change.right).text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {versionCompare ? (
        <div className="mt-4 space-y-2 text-sm">
          <p>
            YAML {versionCompare.equal ? "equal" : "different"}
            {versionCompare.digestMatch ? " · digests match" : " · digests differ"}
          </p>
          <ul className="space-y-1 font-mono text-xs text-zinc-700">
            {versionCompare.changes.map((change, index) => (
              <li key={`${change.path}-${change.op}-${index}`}>
                {change.op} {change.path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
