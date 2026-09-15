import {
  SCRIPT_IO_HANDLE_HELP,
  SCRIPT_IO_INDETERMINATE_HELP,
  SCRIPT_IO_NO_BLIND_RETRY_HELP,
  SCRIPT_IO_VALIDATION_HELP,
  isScriptIoStep,
  parseScriptIoResult,
  type ScriptIoParsedResult,
} from "@/lib/script-io-contract";
import { boundRedactedDisplay } from "@/lib/execution";
import {
  FF_INBOX_DANGER_CLASS,
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_PANEL_CLASS,
  FF_INBOX_TITLE_CLASS,
  FF_LOUD_DANGER_CLASS,
  FF_LOUD_INDETERMINATE_CLASS,
} from "@/lib/vault-executions-visual";

type ScriptIoResultPanelProps = {
  steps?: readonly {
    id?: string;
    nodeId?: string;
    nodeType?: string;
    status?: string;
    output?: unknown;
    input?: unknown;
    error?: unknown;
  }[];
};

export function ScriptIoResultPanel({ steps = [] }: ScriptIoResultPanelProps) {
  const results = steps
    .filter((step) => isScriptIoStep(step))
    .map((step) => ({
      step,
      parsed: parseScriptIoResult(step.output, step.error, step.input),
    }))
    .filter((item): item is { step: (typeof steps)[number]; parsed: ScriptIoParsedResult } =>
      Boolean(item.parsed),
    );
  if (results.length === 0) {
    return null;
  }
  return (
    <section className={FF_INBOX_PANEL_CLASS}>
      <h2 className={`text-lg ${FF_INBOX_TITLE_CLASS}`}>Script I/O result</h2>
      <p className={`mt-1 text-sm ${FF_INBOX_MUTED_CLASS}`}>
        Redacted typed outputs from existing{" "}
        <code className="font-mono text-xs">GET /executions/{"{id}"}</code>{" "}
        steps.         {SCRIPT_IO_VALIDATION_HELP} {SCRIPT_IO_HANDLE_HELP}{" "}
        {SCRIPT_IO_NO_BLIND_RETRY_HELP} Closed retry is HTTP 409{" "}
        <code className="font-mono text-xs">retry-denied</code>.
      </p>
      <ul className="mt-4 grid gap-3">
        {results.map(({ step, parsed }) => (
          <li
            key={step.id || `${step.nodeId}-${step.nodeType}`}
            className={
              parsed.errorCode === "indeterminate"
                ? `rounded-xl p-4 ${FF_LOUD_INDETERMINATE_CLASS}`
                : parsed.validationErrors.length > 0
                  ? `rounded-xl p-4 ${FF_LOUD_DANGER_CLASS}`
                  : FF_INBOX_PANEL_CLASS
            }
          >
            <p className="font-medium">
              {step.nodeId || step.nodeType || "script"}
            </p>
            <p className={`font-mono text-xs ${FF_INBOX_MUTED_CLASS}`}>
              {step.nodeType || "script"}
              {parsed.exitCode != null ? ` · exit ${parsed.exitCode}` : ""}
              {parsed.correlationId ? ` · ${parsed.correlationId}` : ""}
            </p>
            {parsed.errorCode === "indeterminate" ? (
              <p className="mt-2 text-sm font-medium">
                {SCRIPT_IO_INDETERMINATE_HELP}
              </p>
            ) : null}
            {parsed.validationErrors.length > 0 ? (
              <ul className={`mt-2 space-y-1 text-sm ${FF_INBOX_DANGER_CLASS}`}>
                {parsed.validationErrors.map((error) => (
                  <li key={`${error.code}-${error.path}-${error.message}`}>
                    <span className="font-mono text-xs">{error.code}</span>
                    {error.path ? ` · ${error.path}` : ""} — {error.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {parsed.output !== undefined ? (
              <RedactedBlock label="Redacted output" value={parsed.output} />
            ) : null}
            {parsed.input !== undefined ? (
              <RedactedBlock label="Redacted input" value={parsed.input} />
            ) : null}
            {parsed.stdout ? (
              <RedactedBlock label="Redacted stdout" value={parsed.stdout} />
            ) : null}
            {parsed.retry ? (
              <p className={`mt-2 text-xs ${FF_INBOX_MUTED_CLASS}`}>
                result.retry.allowed={String(parsed.retry.allowed)} · maxAttempts=
                {parsed.retry.maxAttempts} · executed=
                {parsed.retry.executedAttempts}
                {parsed.retry.verificationOutcome
                  ? ` · ${parsed.retry.verificationOutcome}`
                  : ""}
                . {parsed.retry.allowed ? "" : SCRIPT_IO_NO_BLIND_RETRY_HELP}
              </p>
            ) : (
              <p className={`mt-2 text-xs ${FF_INBOX_MUTED_CLASS}`}>
                {SCRIPT_IO_NO_BLIND_RETRY_HELP}
              </p>
            )}
            {parsed.strippedHandleKeys.length > 0 ? (
              <p className={`mt-2 text-xs ${FF_INBOX_MUTED_CLASS}`}>
                Stripped scoped handle fields: {parsed.strippedHandleKeys.join(", ")}.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RedactedBlock({ label, value }: { label: string; value: unknown }) {
  const display = boundRedactedDisplay(value);
  return (
    <div className="mt-3">
      <p className={`text-xs font-medium ${FF_INBOX_MUTED_CLASS}`}>{label}</p>
      <pre className={`mt-1 overflow-auto rounded-lg p-3 font-mono text-xs ${FF_INBOX_PANEL_CLASS}`}>
        {display.text}
      </pre>
      {display.truncated ? (
        <p className={`mt-1 text-xs ${FF_INBOX_MUTED_CLASS}`}>
          Output truncated at {display.maxBytes} characters.
        </p>
      ) : null}
    </div>
  );
}
