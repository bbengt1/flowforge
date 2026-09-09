"use client";

import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import { SshSafetyNotes } from "@/components/config/SshSafetyNotes";
import type { DevIdentity } from "@/lib/identity-headers";
import type { OpsConfigSpec } from "@/lib/ops-config-types";
import {
  SSH_DENIED_FEATURES,
  SSH_KEY_ONLY_HELP,
  SSH_NOT_A_TERMINAL_HELP,
  SSH_SECRET_FREE_HELP,
} from "@/lib/ssh-contract";
import { sshCredentialTypes } from "@/lib/ssh";
import type { SshEngineCatalog } from "@/lib/ssh-types";

type SshTargetFormProps = {
  spec: OpsConfigSpec;
  readOnly: boolean;
  identity: DevIdentity;
  ready: boolean;
  catalog?: SshEngineCatalog | null;
  extraNotes?: readonly string[];
  onChange: (spec: OpsConfigSpec) => void;
};

export function SshTargetForm({
  spec,
  readOnly,
  identity,
  ready,
  catalog,
  extraNotes,
  onChange,
}: SshTargetFormProps) {
  const inputClass =
    "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:bg-zinc-50";
  const defaultPort = catalog?.defaultPort ?? 22;
  const allowedTypes = sshCredentialTypes(catalog ?? undefined);

  function patch(partial: Partial<OpsConfigSpec>) {
    onChange({ ...spec, ...partial });
  }

  return (
    <div className="grid gap-4">
      <SshSafetyNotes catalog={catalog} extraNotes={extraNotes} />

      <CredentialRefSelect
        identity={identity}
        ready={ready}
        value={spec.credentialId ?? ""}
        disabled={readOnly}
        allowedTypes={allowedTypes}
        onChange={(credentialId) => patch({ credentialId })}
      />
      <p className="text-xs text-zinc-500">{SSH_SECRET_FREE_HELP}</p>
      <p className="text-xs text-zinc-500">{SSH_KEY_ONLY_HELP}</p>
      <p className="text-xs text-zinc-500">{SSH_NOT_A_TERMINAL_HELP}</p>

      <label className="text-sm">
        <span className="font-medium">Hostname</span>
        <input
          value={spec.hostname ?? ""}
          disabled={readOnly}
          autoComplete="off"
          onChange={(event) => patch({ hostname: event.target.value })}
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Resolved through an approved resolver. Every address must be allowlisted.
        </span>
      </label>

      <label className="text-sm">
        <span className="font-medium">Known-host fingerprint</span>
        <input
          value={spec.hostKeyFingerprint ?? ""}
          disabled={readOnly}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => patch({ hostKeyFingerprint: event.target.value })}
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Verified fingerprint only. Host-key auto-accept is denied.
        </span>
      </label>

      <details className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-zinc-800">
          Host and port allowlist
        </summary>
        <div className="mt-3 grid gap-3">
          <label className="text-sm">
            <span className="font-medium">Port</span>
            <input
              value={String(spec.port ?? defaultPort)}
              disabled={readOnly}
              inputMode="numeric"
              autoComplete="off"
              onChange={(event) =>
                patch({ port: Number(event.target.value) || defaultPort })
              }
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Default {defaultPort}. Port forwarding is denied.
            </span>
          </label>
          <label className="text-sm">
            <span className="font-medium">Allowed addresses</span>
            <input
              value={(spec.allowedAddresses ?? []).join(", ")}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) =>
                patch({ allowedAddresses: splitList(event.target.value) })
              }
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-zinc-500">
              Comma-separated allowlist. Present empty lists fail closed.
            </span>
          </label>
          <label className="text-sm">
            <span className="font-medium">Optional policy pin (UUID)</span>
            <input
              value={spec.policyId ?? ""}
              disabled={readOnly}
              autoComplete="off"
              onChange={(event) => patch({ policyId: event.target.value })}
              className={inputClass}
            />
          </label>
        </div>
      </details>

      <DeniedFeatureList />
    </div>
  );
}

function DeniedFeatureList() {
  return (
    <p className="text-xs text-zinc-500">
      Denied in MVP (no toggles): {SSH_DENIED_FEATURES.join(", ")}.
    </p>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
