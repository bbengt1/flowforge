"use client";

import { COMPARE_REDACTION_HELP } from "@/lib/execution-contract";
import type { ExecutionCompareResult } from "@/lib/execution-replay";
import { boundRedactedDisplay } from "@/lib/execution";
import type { CompareWorkflowResult } from "@/lib/workflow-types";
import {
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PANEL_CLASS,
  FF_INBOX_TITLE_CLASS,
} from "@/lib/vault-executions-visual";

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
      className={FF_INBOX_PANEL_CLASS}
    >
      <h2 id="execution-compare-heading" className={`text-lg ${FF_INBOX_TITLE_CLASS}`}>
        Compare
      </h2>
      <p className={`mt-1 text-sm ${FF_INBOX_MUTED_CLASS}`}>{COMPARE_REDACTION_HELP}</p>

      {result ? (
        <div className="mt-4 space-y-2 text-sm">
          <p>
            {result.equal ? "Executions match" : "Executions differ"}
            {result.digestMatch ? " · version digests match" : " · version digests differ"}
          </p>
          <p className={`font-mono text-xs break-all ${FF_INBOX_MUTED_CLASS}`}>
            left {result.leftLabel} · {result.leftDigest || "—"}
          </p>
          <p className={`font-mono text-xs break-all ${FF_INBOX_MUTED_CLASS}`}>
            right {result.rightLabel} · {result.rightDigest || "—"}
          </p>
          {result.changes.length === 0 ? (
            <p className={FF_INBOX_MUTED_CLASS}>No redacted summary changes.</p>
          ) : (
            <ul className={`space-y-1 font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
              {result.changes.map((change, index) => (
                <li key={`${change.path}-${change.op}-${index}`}>
                  {change.op} {change.path || "(root)"}
                  <span className="block">
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
          <ul className={`space-y-1 font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
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
