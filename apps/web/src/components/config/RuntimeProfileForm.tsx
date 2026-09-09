"use client";

import { ScriptIsolationNotes } from "@/components/config/ScriptIsolationNotes";
import type { OpsConfigSpec } from "@/lib/ops-config-types";
import {
  SCRIPT_RUNTIME_DIGEST_HELP,
  SCRIPT_RUNTIME_EGRESS_HELP,
  SCRIPT_RUNTIME_LANGUAGES,
  SCRIPT_RUNTIME_LIMIT_BOUNDS,
  SCRIPT_RUNTIME_NO_IMAGE_HELP,
  SCRIPT_RUNTIME_NO_INSTALL_HELP,
  SCRIPT_RUNTIME_PROFILE_REQUIRED_HELP,
  deniedEgressHost,
  isPinnedImageDigest,
  runtimeProfilePublishGap,
  type ScriptRuntimeLimitKey,
  type ScriptRuntimeProfileMap,
} from "@/lib/script-runtime-contract";

type RuntimeProfileFormProps = {
  spec: OpsConfigSpec;
  readOnly: boolean;
  map?: ScriptRuntimeProfileMap | null;
  extraNotes?: readonly string[];
  onChange: (spec: OpsConfigSpec) => void;
};

const LIMIT_FIELDS: {
  key: ScriptRuntimeLimitKey;
  label: string;
}[] = [
  { key: "cpuMillis", label: "CPU millis" },
  { key: "memoryMib", label: "Memory MiB" },
  { key: "timeoutSeconds", label: "Timeout seconds" },
  { key: "processes", label: "Processes" },
];

type EgressDestination = NonNullable<
  NonNullable<OpsConfigSpec["egress"]>["destinations"]
>[number];

export function RuntimeProfileForm({
  spec,
  readOnly,
  map,
  extraNotes,
  onChange,
}: RuntimeProfileFormProps) {
  const inputClass =
    "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:bg-zinc-50";
  const limits = spec.limits ?? {};
  const destinations = spec.egress?.destinations ?? [];
  const gap = runtimeProfilePublishGap(spec, map);
  const imagePinned = isPinnedImageDigest(spec.imageDigest);
  const lockPinned = isPinnedImageDigest(spec.dependencyLockDigest);
  const showEgress = map?.egressExposed !== false;

  function patch(partial: Partial<OpsConfigSpec>) {
    onChange({ ...spec, ...partial });
  }

  function setDestinations(next: EgressDestination[]) {
    if (next.length === 0) {
      const { egress: _drop, ...rest } = spec;
      void _drop;
      onChange(rest);
      return;
    }
    patch({
      egress: {
        destinations: next,
        dnsConstrained: true,
      },
    });
  }

  return (
    <div className="grid gap-4">
      <ScriptIsolationNotes map={map} extraNotes={extraNotes} />
      <p className="text-xs text-zinc-500">{SCRIPT_RUNTIME_PROFILE_REQUIRED_HELP}</p>

      <label className="text-sm">
        <span className="font-medium">Language</span>
        <select
          value={spec.language ?? "python"}
          disabled={readOnly}
          onChange={(event) => patch({ language: event.target.value })}
          className={inputClass}
        >
          {SCRIPT_RUNTIME_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-zinc-500">
          python or go only. Script nodes list published profiles that match
          this language.
        </span>
      </label>

      <label className="text-sm">
        <span className="font-medium">Image digest</span>
        <input
          value={spec.imageDigest ?? ""}
          disabled={readOnly}
          autoComplete="off"
          spellCheck={false}
          placeholder="sha256:…"
          onChange={(event) => patch({ imageDigest: event.target.value })}
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          {SCRIPT_RUNTIME_DIGEST_HELP} {SCRIPT_RUNTIME_NO_IMAGE_HELP}
        </span>
        {spec.imageDigest && !imagePinned ? (
          <span role="status" className="mt-1 block text-sm text-amber-900">
            Image digest is not sha256:&lt;64 hex&gt;. Tags and names are rejected.
          </span>
        ) : null}
      </label>

      <label className="text-sm">
        <span className="font-medium">Dependency lock digest</span>
        <input
          value={spec.dependencyLockDigest ?? ""}
          disabled={readOnly}
          autoComplete="off"
          spellCheck={false}
          placeholder="sha256:…"
          onChange={(event) => patch({ dependencyLockDigest: event.target.value })}
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Pin the approved lockfile digest. {SCRIPT_RUNTIME_NO_INSTALL_HELP}
        </span>
        {spec.dependencyLockDigest && !lockPinned ? (
          <span role="status" className="mt-1 block text-sm text-amber-900">
            Dependency lock digest is not sha256:&lt;64 hex&gt;.
          </span>
        ) : null}
      </label>

      <fieldset className="grid gap-3 rounded-xl border border-zinc-200 px-4 py-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">Resource limits</legend>
        {LIMIT_FIELDS.map((field) => {
          const bounds = SCRIPT_RUNTIME_LIMIT_BOUNDS[field.key];
          return (
            <label key={field.key} className="text-sm">
              <span className="font-medium">{field.label}</span>
              <input
                type="number"
                min={bounds.min}
                max={bounds.max}
                value={String(limits[field.key] ?? bounds.fallback)}
                disabled={readOnly}
                onChange={(event) =>
                  patch({
                    limits: {
                      ...limits,
                      [field.key]: Number(event.target.value) || bounds.fallback,
                    },
                  })
                }
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-zinc-500">
                {bounds.min}–{bounds.max}
              </span>
            </label>
          );
        })}
      </fieldset>

      {showEgress ? (
        <fieldset className="grid gap-3 rounded-xl border border-zinc-200 px-4 py-3">
          <legend className="px-1 text-sm font-medium">Egress allowlist</legend>
          <p className="text-xs text-zinc-500">{SCRIPT_RUNTIME_EGRESS_HELP}</p>
          <p className="text-xs text-zinc-500">
            dnsConstrained is required and always true. There is no toggle for
            package install, Docker socket, metadata, or unconstrained DNS.
          </p>
          {destinations.length === 0 ? (
            <p className="text-sm text-zinc-600">
              No destinations — default-deny egress.
            </p>
          ) : null}
          {destinations.map((row, index) => (
            <div
              key={`${row.host ?? ""}-${index}`}
              className="grid gap-2 sm:grid-cols-[1fr_7rem_6rem_auto]"
            >
              <label className="text-sm">
                <span className="font-medium">Host</span>
                <input
                  value={row.host ?? ""}
                  disabled={readOnly}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    const next = [...destinations];
                    next[index] = { ...row, host: event.target.value };
                    setDestinations(next);
                  }}
                  className={`${inputClass} font-mono`}
                />
              </label>
              <label className="text-sm">
                <span className="font-medium">Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={String(row.port ?? 443)}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = [...destinations];
                    next[index] = {
                      ...row,
                      port: Number(event.target.value) || 443,
                    };
                    setDestinations(next);
                  }}
                  className={inputClass}
                />
              </label>
              <label className="text-sm">
                <span className="font-medium">Protocol</span>
                <select
                  value={row.protocol === "udp" ? "udp" : "tcp"}
                  disabled={readOnly}
                  onChange={(event) => {
                    const next = [...destinations];
                    next[index] = { ...row, protocol: event.target.value };
                    setDestinations(next);
                  }}
                  className={inputClass}
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
              </label>
              <button
                type="button"
                disabled={readOnly}
                onClick={() =>
                  setDestinations(destinations.filter((_, i) => i !== index))
                }
                className="self-end rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:opacity-60"
              >
                Remove
              </button>
              {deniedEgressHost(row.host) ? (
                <p className="sm:col-span-4 text-sm text-amber-900">
                  {row.host} is denied (metadata, loopback, Docker socket, or *).
                </p>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            disabled={readOnly || destinations.length >= 32}
            onClick={() =>
              setDestinations([
                ...destinations,
                { host: "", port: 443, protocol: "tcp" },
              ])
            }
            className="w-fit rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            Add destination
          </button>
        </fieldset>
      ) : (
        <p className="text-xs text-zinc-500">{SCRIPT_RUNTIME_EGRESS_HELP}</p>
      )}

      {gap ? (
        <p role="status" className="text-sm text-amber-900">
          {gap}
        </p>
      ) : null}
    </div>
  );
}
