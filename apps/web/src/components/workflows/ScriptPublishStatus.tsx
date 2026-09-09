import {
  SCRIPT_PUBLISH_BOUNDARY_HELP,
  type ScriptArtifactStatus,
} from "@/lib/script-contract";

export function ScriptPublishStatus({
  status,
}: {
  status: ScriptArtifactStatus;
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
      <p className="mt-2 text-xs text-teal-900">{SCRIPT_PUBLISH_BOUNDARY_HELP}</p>
    </section>
  );
}
