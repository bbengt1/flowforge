"use client";

import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import type { DevIdentity } from "@/lib/identity-headers";
import { parseSpecJson, specJson } from "@/lib/ops-config";
import {
  CONNECTION_TYPES,
  POLICY_KINDS,
  RUNTIME_LANGUAGES,
  type OpsConfigKind,
  type OpsConfigSpec,
} from "@/lib/ops-config-types";

type ConfigSpecFormProps = {
  kind: OpsConfigKind;
  spec: OpsConfigSpec;
  readOnly: boolean;
  identity: DevIdentity;
  ready: boolean;
  onChange: (spec: OpsConfigSpec) => void;
};

export function ConfigSpecForm({
  kind,
  spec,
  readOnly,
  identity,
  ready,
  onChange,
}: ConfigSpecFormProps) {
  const inputClass =
    "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20 disabled:bg-zinc-50";

  function patch(partial: Partial<OpsConfigSpec>) {
    onChange({ ...spec, ...partial });
  }

  const endpoint = spec.endpoint ?? {};
  const limits = spec.limits ?? {};
  const endpointPolicy = asRecord(spec.endpointPolicy);
  const recipientPolicy = asRecord(spec.recipientPolicy);

  return (
    <div className="grid gap-3">
      {needsCredential(kind) ? (
        <CredentialRefSelect
          identity={identity}
          ready={ready}
          value={spec.credentialId ?? ""}
          disabled={readOnly}
          onChange={(credentialId) => patch({ credentialId })}
        />
      ) : null}

      {kind === "cluster_target" ? (
        <>
          <TextField
            label="API server"
            value={String(endpoint.apiServer ?? "")}
            disabled={readOnly}
            className={inputClass}
            onChange={(apiServer) =>
              patch({ endpoint: { ...endpoint, apiServer } })
            }
          />
          <TextField
            label="TLS server name"
            value={String(endpoint.tlsServerName ?? "")}
            disabled={readOnly}
            className={inputClass}
            onChange={(tlsServerName) =>
              patch({ endpoint: { ...endpoint, tlsServerName } })
            }
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(endpoint.skipTLSVerify)}
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  endpoint: { ...endpoint, skipTLSVerify: event.target.checked },
                })
              }
            />
            Skip TLS verify
          </label>
          <TextField
            label="Allowed namespaces (comma-separated)"
            value={(spec.allowedNamespaces ?? []).join(", ")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) =>
              patch({ allowedNamespaces: splitList(value) })
            }
          />
        </>
      ) : null}

      {kind === "ssh_target" ? (
        <>
          <TextField
            label="Hostname"
            value={spec.hostname ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(hostname) => patch({ hostname })}
          />
          <TextField
            label="Port"
            value={String(spec.port ?? 22)}
            disabled={readOnly}
            className={inputClass}
            onChange={(port) => patch({ port: Number(port) || 22 })}
          />
          <TextField
            label="Host key fingerprint"
            value={spec.hostKeyFingerprint ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(hostKeyFingerprint) => patch({ hostKeyFingerprint })}
          />
          <TextField
            label="Allowed addresses (comma-separated)"
            value={(spec.allowedAddresses ?? []).join(", ")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) => patch({ allowedAddresses: splitList(value) })}
          />
        </>
      ) : null}

      {kind === "command_profile" ? (
        <>
          <TextAreaField
            label="Command template"
            value={spec.template ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(template) => patch({ template })}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(spec.retrySafe)}
              disabled={readOnly}
              onChange={(event) => patch({ retrySafe: event.target.checked })}
            />
            Retry-safe (verification required)
          </label>
          <JsonField
            label="Parameter schema"
            value={spec.parameterSchema ?? {}}
            disabled={readOnly}
            className={inputClass}
            onChange={(parameterSchema) => patch({ parameterSchema })}
          />
        </>
      ) : null}

      {kind === "runtime_profile" ? (
        <>
          <label className="text-sm">
            <span className="font-medium">Language</span>
            <select
              value={spec.language ?? "python"}
              disabled={readOnly}
              onChange={(event) => patch({ language: event.target.value })}
              className={inputClass}
            >
              {RUNTIME_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Image digest"
            value={spec.imageDigest ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(imageDigest) => patch({ imageDigest })}
          />
          <TextField
            label="Dependency lock digest"
            value={spec.dependencyLockDigest ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(dependencyLockDigest) => patch({ dependencyLockDigest })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="CPU millis"
              value={String(limits.cpuMillis ?? 500)}
              disabled={readOnly}
              className={inputClass}
              onChange={(value) =>
                patch({
                  limits: { ...limits, cpuMillis: Number(value) || 500 },
                })
              }
            />
            <TextField
              label="Memory MiB"
              value={String(limits.memoryMib ?? 256)}
              disabled={readOnly}
              className={inputClass}
              onChange={(value) =>
                patch({
                  limits: { ...limits, memoryMib: Number(value) || 256 },
                })
              }
            />
            <TextField
              label="Timeout seconds"
              value={String(limits.timeoutSeconds ?? 30)}
              disabled={readOnly}
              className={inputClass}
              onChange={(value) =>
                patch({
                  limits: { ...limits, timeoutSeconds: Number(value) || 30 },
                })
              }
            />
            <TextField
              label="Processes"
              value={String(limits.processes ?? 1)}
              disabled={readOnly}
              className={inputClass}
              onChange={(value) =>
                patch({
                  limits: { ...limits, processes: Number(value) || 1 },
                })
              }
            />
          </div>
        </>
      ) : null}

      {kind === "connection" ? (
        <>
          <label className="text-sm">
            <span className="font-medium">Type</span>
            <select
              value={spec.type ?? "http"}
              disabled={readOnly}
              onChange={(event) => patch({ type: event.target.value })}
              className={inputClass}
            >
              {CONNECTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Hosts (comma-separated)"
            value={stringList(endpointPolicy.hosts).join(", ")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) =>
              patch({
                endpointPolicy: { ...endpointPolicy, hosts: splitList(value) },
              })
            }
          />
          <TextField
            label="Methods (comma-separated)"
            value={stringList(endpointPolicy.methods).join(", ")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) =>
              patch({
                endpointPolicy: { ...endpointPolicy, methods: splitList(value) },
              })
            }
          />
          <TextField
            label="Path prefixes (comma-separated)"
            value={stringList(endpointPolicy.pathPrefixes).join(", ")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) =>
              patch({
                endpointPolicy: {
                  ...endpointPolicy,
                  pathPrefixes: splitList(value),
                },
              })
            }
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={endpointPolicy.tlsRequired !== false}
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  endpointPolicy: {
                    ...endpointPolicy,
                    tlsRequired: event.target.checked,
                  },
                })
              }
            />
            TLS required
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(endpointPolicy.allowRedirects)}
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  endpointPolicy: {
                    ...endpointPolicy,
                    allowRedirects: event.target.checked,
                  },
                })
              }
            />
            Allow redirects
          </label>
        </>
      ) : null}

      {kind === "recipient_list" ? (
        <>
          <TextAreaField
            label="Emails (one per line)"
            value={stringList(recipientPolicy.emails).join("\n")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) =>
              patch({
                recipientPolicy: {
                  ...recipientPolicy,
                  emails: splitLines(value),
                },
              })
            }
          />
          <TextAreaField
            label="Domains (one per line)"
            value={stringList(recipientPolicy.domains).join("\n")}
            disabled={readOnly}
            className={inputClass}
            onChange={(value) =>
              patch({
                recipientPolicy: {
                  ...recipientPolicy,
                  domains: splitLines(value),
                },
              })
            }
          />
        </>
      ) : null}

      {kind === "message_template" ? (
        <>
          <TextField
            label="Content classification"
            value={spec.contentClassification ?? "internal"}
            disabled={readOnly}
            className={inputClass}
            onChange={(contentClassification) => patch({ contentClassification })}
          />
          <TextField
            label="Subject"
            value={spec.subject ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(subject) => patch({ subject })}
          />
          <TextAreaField
            label="Template body"
            value={spec.body ?? ""}
            disabled={readOnly}
            className={inputClass}
            onChange={(body) => patch({ body })}
          />
          <JsonField
            label="Input schema"
            value={spec.inputSchema ?? {}}
            disabled={readOnly}
            className={inputClass}
            onChange={(inputSchema) => patch({ inputSchema })}
          />
        </>
      ) : null}

      {kind === "response_schema" ? (
        <>
          <TextField
            label="Max bytes"
            value={String(spec.maxBytes ?? 16384)}
            disabled={readOnly}
            className={inputClass}
            onChange={(maxBytes) => patch({ maxBytes: Number(maxBytes) || 16384 })}
          />
          <JsonField
            label="Schema"
            value={spec.schema ?? {}}
            disabled={readOnly}
            className={inputClass}
            onChange={(schema) => patch({ schema })}
          />
        </>
      ) : null}

      {kind === "policy" ? (
        <>
          <label className="text-sm">
            <span className="font-medium">Kind</span>
            <select
              value={spec.kind ?? "kubernetes"}
              disabled={readOnly}
              onChange={(event) => patch({ kind: event.target.value })}
              className={inputClass}
            >
              {POLICY_KINDS.map((policyKind) => (
                <option key={policyKind} value={policyKind}>
                  {policyKind}
                </option>
              ))}
            </select>
          </label>
          <JsonField
            label="Policy"
            value={spec.policy ?? {}}
            disabled={readOnly}
            className={inputClass}
            onChange={(policy) => patch({ policy })}
          />
        </>
      ) : null}

      <TextField
        label="Optional policy pin (UUID)"
        value={spec.policyId ?? ""}
        disabled={readOnly}
        className={inputClass}
        onChange={(policyId) => patch({ policyId })}
      />
    </div>
  );
}

function needsCredential(kind: OpsConfigKind): boolean {
  return kind === "cluster_target" || kind === "ssh_target" || kind === "connection";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function TextField({
  label,
  value,
  disabled,
  className,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  className: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-sm">
      <span className="font-medium">{label}</span>
      <input
        value={value}
        disabled={disabled}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={className}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  disabled,
  className,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  className: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        value={value}
        disabled={disabled}
        rows={5}
        onChange={(event) => onChange(event.target.value)}
        className={`${className} font-mono`}
      />
    </label>
  );
}

function JsonField({
  label,
  value,
  disabled,
  className,
  onChange,
}: {
  label: string;
  value: Record<string, unknown>;
  disabled: boolean;
  className: string;
  onChange: (value: Record<string, unknown>) => void;
}) {
  return (
    <label className="text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        defaultValue={specJson(value)}
        disabled={disabled}
        rows={6}
        onBlur={(event) => {
          const parsed = parseSpecJson(event.target.value);
          if (parsed) {
            onChange(parsed);
          }
        }}
        className={`${className} font-mono`}
      />
    </label>
  );
}
