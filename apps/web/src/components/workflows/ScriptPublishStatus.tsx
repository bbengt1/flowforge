import {
  SCRIPT_BLOB_FORBIDDEN_MESSAGE,
  SCRIPT_EXECUTE_FAIL_CLOSED_HELP,
  SCRIPT_PUBLISH_BOUNDARY_HELP,
  type ScriptArtifactStatus,
  type ScriptVersionPin,
} from "@/lib/script-contract";

export function ScriptPublishStatus({
  status,
  pins,
}: {
  status: ScriptArtifactStatus;
  pins?: readonly ScriptVersionPin[] | null;
}) {
  return (
    <section
      aria-labelledby="script-publish-status"
      className="mt-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3"
    >
      <h3 id="script-publish-status" className="text-sm font-semibold text-teal-950">
        Script artifact
      </h3>
      <p className="mt-1 text-sm text-teal-950">
        <span className="font-medium">{status.label}</span>
        {status.digest ? (
          <>
            {" "}
            <code className="break-all font-mono text-xs">{status.digest}</code>
          </>
        ) : null}
        {status.scanStatus ? (
          <span className="ml-1 text-xs">scan={status.scanStatus}</span>
        ) : null}
      </p>
      <p className="mt-1 text-xs text-teal-900">{status.help}</p>
      {pins && pins.length > 0 ? (
        <ul className="mt-2 space-y-1 font-mono text-xs text-teal-950">
          {pins.map((pin) => (
            <li key={`${pin.nodeId}-${pin.artifactId}`}>
              {pin.nodeId}
              {pin.nodeType ? ` · ${pin.nodeType}` : ""}
              {" · "}
              <code className="break-all">{pin.digest}</code>
              {" · scan="}
              {pin.scanStatus || "—"}
              {" · signature="}
              {pin.signature ? "present" : "missing"}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-teal-900">{SCRIPT_PUBLISH_BOUNDARY_HELP}</p>
      <p className="mt-1 text-xs text-teal-900">{SCRIPT_EXECUTE_FAIL_CLOSED_HELP}</p>
      <p className="mt-1 text-xs text-teal-800">{SCRIPT_BLOB_FORBIDDEN_MESSAGE}</p>
    </section>
  );
}
