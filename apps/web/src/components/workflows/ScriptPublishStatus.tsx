"use client";

import { useState } from "react";
import { ConfirmDestructive } from "@/components/a11y/ConfirmDestructive";
import { Field } from "@/components/a11y/Field";
import { ProblemBanner } from "@/components/ProblemBanner";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { scriptRevokeImpact } from "@/lib/confirm-destructive";
import { revokeScriptArtifact } from "@/lib/script-ops-client";
import {
  SCRIPT_EMERGENCY_STOP_HELP,
  SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP,
  SCRIPT_OPS_AUDIT_SECRET_FREE_HELP,
  SCRIPT_REVOKE_CONFIRM_HELP,
  SCRIPT_REVOKE_FORBIDDEN_MESSAGE,
  SCRIPT_REVOKE_HELP,
  SCRIPT_REVOKED_STATUS_HELP,
  canRevokeScriptArtifact,
  isArtifactRevoked,
  parseScriptOpsCatalog,
  type ScriptOpsCatalog,
} from "@/lib/script-ops-contract";
import {
  SCRIPT_BLOB_FORBIDDEN_MESSAGE,
  SCRIPT_EXECUTE_FAIL_CLOSED_HELP,
  SCRIPT_PUBLISH_BOUNDARY_HELP,
  type ScriptArtifact,
  type ScriptArtifactStatus,
  type ScriptNodeCatalog,
  type ScriptVersionPin,
} from "@/lib/script-contract";

export function ScriptPublishStatus({
  status,
  pins,
  artifacts,
  identity,
  permissions,
  scriptCatalog,
  onArtifactChange,
}: {
  status: ScriptArtifactStatus;
  pins?: readonly ScriptVersionPin[] | null;
  artifacts?: readonly ScriptArtifact[] | null;
  identity?: DevIdentity;
  permissions?: readonly string[] | null;
  scriptCatalog?: ScriptNodeCatalog | null;
  onArtifactChange?: (artifact: ScriptArtifact) => void;
}) {
  const opsCatalog = parseScriptOpsCatalog(scriptCatalog);
  const revoked = status.kind === "revoked";

  return (
    <section
      aria-labelledby="script-publish-status"
      className={
        revoked
          ? "mt-3 rounded-xl border-2 border-rose-700 bg-rose-50 px-4 py-3"
          : "mt-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3"
      }
    >
      <h3
        id="script-publish-status"
        className={
          revoked
            ? "text-sm font-semibold text-rose-950"
            : "text-sm font-semibold text-teal-950"
        }
      >
        Script artifact
      </h3>
      <p className={revoked ? "mt-1 text-sm text-rose-950" : "mt-1 text-sm text-teal-950"}>
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
        {status.revokedAt ? (
          <span className="ml-1 text-xs">revokedAt={status.revokedAt}</span>
        ) : null}
      </p>
      <p className={revoked ? "mt-1 text-xs text-rose-950" : "mt-1 text-xs text-teal-950"}>
        {revoked ? SCRIPT_REVOKED_STATUS_HELP : status.help}
      </p>
      {pins && pins.length > 0 ? (
        <ul
          className={
            revoked
              ? "mt-2 space-y-2 font-mono text-xs text-rose-950"
              : "mt-2 space-y-2 font-mono text-xs text-teal-950"
          }
        >
          {pins.map((pin) => {
            const artifact = (artifacts ?? []).find((item) => item.id === pin.artifactId);
            return (
              <li key={`${pin.nodeId}-${pin.artifactId}`}>
                <p>
                  {pin.nodeId}
                  {pin.nodeType ? ` · ${pin.nodeType}` : ""}
                  {" · "}
                  <code className="break-all">{pin.digest}</code>
                  {" · scan="}
                  {pin.scanStatus || "—"}
                  {" · signature="}
                  {pin.signature ? "present" : "missing"}
                  {isArtifactRevoked(artifact) || pin.revokedAt ? (
                    <>
                      {" · "}
                      <strong>revoked</strong>
                      {artifact?.revokedAt || pin.revokedAt
                        ? ` ${artifact?.revokedAt ?? pin.revokedAt}`
                        : ""}
                    </>
                  ) : null}
                </p>
                {identity ? (
                  <ScriptRevokeAction
                    artifact={artifact}
                    identity={identity}
                    permissions={permissions}
                    catalog={opsCatalog}
                    onArtifactChange={onArtifactChange}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className={revoked ? "mt-2 text-xs text-rose-950" : "mt-2 text-xs text-teal-950"}>
        {SCRIPT_PUBLISH_BOUNDARY_HELP}
      </p>
      <p className={revoked ? "mt-1 text-xs text-rose-950" : "mt-1 text-xs text-teal-950"}>
        {SCRIPT_EXECUTE_FAIL_CLOSED_HELP}
      </p>
      <p className={revoked ? "mt-1 text-xs text-rose-950" : "mt-1 text-xs text-teal-950"}>
        {SCRIPT_REVOKE_HELP} {SCRIPT_EMERGENCY_STOP_HELP}
      </p>
      <p className={revoked ? "mt-1 text-xs text-rose-950" : "mt-1 text-xs text-teal-950"}>
        {SCRIPT_NO_BLIND_RETRY_AFTER_STOP_HELP} {SCRIPT_OPS_AUDIT_SECRET_FREE_HELP}
      </p>
      <p className={revoked ? "mt-1 text-xs text-rose-950" : "mt-1 text-xs text-teal-950"}>
        {SCRIPT_BLOB_FORBIDDEN_MESSAGE}
      </p>
    </section>
  );
}

function ScriptRevokeAction({
  artifact,
  identity,
  permissions,
  catalog,
  onArtifactChange,
}: {
  artifact?: ScriptArtifact;
  identity: DevIdentity;
  permissions?: readonly string[] | null;
  catalog: ScriptOpsCatalog;
  onArtifactChange?: (artifact: ScriptArtifact) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canRevoke = canRevokeScriptArtifact({
    permissions,
    artifact,
    catalog,
  });

  if (!artifact) {
    return (
      <p className="mt-1 font-sans text-xs text-teal-900">
        Inspect GET /scripts/{"{id}"} to revoke this pin.
      </p>
    );
  }
  if (isArtifactRevoked(artifact)) {
    return (
      <p className="mt-1 font-sans text-xs font-medium text-rose-950">
        Revoked. Start and publish-as-run are blocked for this digest.
      </p>
    );
  }
  if (permissions != null && !canRevoke) {
    return (
      <p className="mt-1 font-sans text-xs text-teal-900">
        {SCRIPT_REVOKE_FORBIDDEN_MESSAGE}
      </p>
    );
  }

  async function onConfirm() {
    if (!artifact || pending) {
      return;
    }
    setPending(true);
    setProblem(null);
    const result = await revokeScriptArtifact(identity, artifact.id, { reason });
    setPending(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setMessage(result.message);
    setOpen(false);
    onArtifactChange?.(result.artifact);
  }

  return (
    <div className="mt-2 font-sans">
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={open || pending}
        className="rounded-lg border border-rose-800 bg-rose-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-900 disabled:opacity-60"
      >
        Revoke artifact
      </button>
      <ConfirmDestructive
        open={open}
        title="Revoke this artifact?"
        description={`${SCRIPT_REVOKE_CONFIRM_HELP} ${SCRIPT_REVOKED_STATUS_HELP}`}
        reversibility="irreversible"
        confirmLabel="Confirm revoke"
        pending={pending}
        pendingLabel="Revoking…"
        impact={scriptRevokeImpact({
          id: artifact.id,
          digest: artifact.digest,
          language: artifact.language,
          status: artifact.status,
        })}
        onConfirm={() => void onConfirm()}
        onClose={() => setOpen(false)}
      >
        <Field
          id="script-revoke-reason"
          label="Optional secret-free reason"
          className="mt-4 block text-sm"
        >
          <input
            type="text"
            value={reason}
            maxLength={256}
            autoComplete="off"
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border px-2 py-1 font-sans text-sm"
          />
        </Field>
        {problem ? <ProblemBanner problem={problem} className="mt-2" /> : null}
      </ConfirmDestructive>
      {message ? (
        <p role="status" className="mt-2 text-xs font-medium text-rose-950">
          {message}
        </p>
      ) : null}
    </div>
  );
}
