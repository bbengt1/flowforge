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

  return (
    <div className="grid gap-3">
      {needsCredential(kind) ? (
        <CredentialRefSelect
          identity={identity}
          ready={ready}
          value={spec.credentialId ?? ""}
          disabled={readOnly}
          onChange={(credentialId, credentialDisplayName) =>
            patch({ credentialId, credentialDisplayName })
          }
        />
      ) : null}

      {kind === "cluster_target" ? (
        <>
          <TextField
            label="API server host"
            value={String(spec.endpointMetadata?.apiServerHost ?? "")}
            disabled={readOnly}
            className={inputClass}
            onChange={(apiServerHost) =>
              patch({
                endpointMetadata: {
                  ...spec.endpointMetadata,
                  apiServerHost,
                },
              })
            }
          />
          <TextField
            label="API server port"
            value={String(spec.endpointMetadata?.apiServerPort ?? "")}
            disabled={readOnly}
            className={inputClass}
            onChange={(port) =>
              patch({
                endpointMetadata: {
                  ...spec.endpointMetadata,
                  apiServerPort: Number(port) || 6443,
                },
              })
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
        </>
      ) : null}

      {kind === "connection" ? (
        <>
          <label className="text-sm">
            <span className="font-medium">Connection type</span>
            <select
              value={spec.connectionType ?? "http"}
              disabled={readOnly}
              onChange={(event) => patch({ connectionType: event.target.value })}
              className={inputClass}
            >
              {CONNECTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <JsonField
            label="Endpoint policy"
            value={spec.endpointPolicy ?? {}}
            disabled={readOnly}
            className={inputClass}
            onChange={(endpointPolicy) => patch({ endpointPolicy })}
          />
        </>
      ) : null}

      {kind === "recipient_list" ? (
        <JsonField
          label="Recipient policy"
          value={spec.recipientPolicy ?? {}}
          disabled={readOnly}
          className={inputClass}
          onChange={(recipientPolicy) => patch({ recipientPolicy })}
        />
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
            <span className="font-medium">Policy kind</span>
            <select
              value={spec.policyKind ?? "kubernetes"}
              disabled={readOnly}
              onChange={(event) => patch({ policyKind: event.target.value })}
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
            label="Policy JSON"
            value={spec.policyJson ?? {}}
            disabled={readOnly}
            className={inputClass}
            onChange={(policyJson) => patch({ policyJson })}
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
