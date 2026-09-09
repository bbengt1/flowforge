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
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Script I/O result</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Redacted typed outputs from existing{" "}
        <code className="font-mono text-xs">GET /executions/{"{id}"}</code>{" "}
        steps. {SCRIPT_IO_VALIDATION_HELP} {SCRIPT_IO_HANDLE_HELP}{" "}
        {SCRIPT_IO_NO_BLIND_RETRY_HELP}
      </p>
      <ul className="mt-4 grid gap-3">
        {results.map(({ step, parsed }) => (
          <li
            key={step.id || `${step.nodeId}-${step.nodeType}`}
            className={
              parsed.errorCode === "indeterminate"
                ? "rounded-xl border-2 border-amber-700 bg-amber-50 p-4"
                : parsed.validationErrors.length > 0
                  ? "rounded-xl border-2 border-rose-700 bg-rose-50 p-4"
                  : "rounded-xl border border-zinc-200 p-4"
            }
          >
            <p className="font-medium">
              {step.nodeId || step.nodeType || "script"}
            </p>
            <p className="font-mono text-xs text-zinc-600">
              {step.nodeType || "script"}
              {parsed.exitCode != null ? ` · exit ${parsed.exitCode}` : ""}
              {parsed.correlationId ? ` · ${parsed.correlationId}` : ""}
            </p>
            {parsed.errorCode === "indeterminate" ? (
              <p className="mt-2 text-sm font-medium text-amber-950">
                {SCRIPT_IO_INDETERMINATE_HELP}
              </p>
            ) : null}
            {parsed.validationErrors.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-rose-950">
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
              <p className="mt-2 text-xs text-zinc-700">
                result.retry.allowed={String(parsed.retry.allowed)} · maxAttempts=
                {parsed.retry.maxAttempts} · executed=
                {parsed.retry.executedAttempts}
                {parsed.retry.verificationOutcome
                  ? ` · ${parsed.retry.verificationOutcome}`
                  : ""}
                . {parsed.retry.allowed ? "" : SCRIPT_IO_NO_BLIND_RETRY_HELP}
              </p>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">
                {SCRIPT_IO_NO_BLIND_RETRY_HELP}
              </p>
            )}
            {parsed.strippedHandleKeys.length > 0 ? (
              <p className="mt-2 text-xs text-zinc-500">
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
      <p className="text-xs font-medium text-zinc-600">{label}</p>
      <pre className="mt-1 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
        {display.text}
      </pre>
      {display.truncated ? (
        <p className="mt-1 text-xs text-zinc-500">
          Output truncated at {display.maxBytes} characters.
        </p>
      ) : null}
    </div>
  );
}
