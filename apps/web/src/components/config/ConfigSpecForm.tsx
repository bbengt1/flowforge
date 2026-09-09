"use client";

import { useEffect, useState } from "react";
import { CommandProfileForm } from "@/components/config/CommandProfileForm";
import { CredentialRefSelect } from "@/components/config/CredentialRefSelect";
import { KubernetesLeastPrivilegeNotes } from "@/components/config/KubernetesLeastPrivilegeNotes";
import { KubernetesPolicyForm } from "@/components/config/KubernetesPolicyForm";
import { PolicyRefSelect } from "@/components/config/PolicyRefSelect";
import { RuntimeProfileForm } from "@/components/config/RuntimeProfileForm";
import { SshTargetForm } from "@/components/config/SshTargetForm";
import type { DevIdentity } from "@/lib/identity-headers";
import { getKubernetesCatalog } from "@/lib/kubernetes-client";
import { isKubernetesPolicySpec } from "@/lib/kubernetes";
import {
  KUBERNETES_CREDENTIAL_TYPE,
  KUBERNETES_ROLE_TEMPLATE,
  type KubernetesEngineCatalog,
} from "@/lib/kubernetes-types";
import { parseJsonObject, specJson } from "@/lib/ops-config";
import { getOpsConfigCatalog } from "@/lib/ops-config-client";
import { getSshCatalog } from "@/lib/ssh-client";
import { kindAcceptsPolicyId } from "@/lib/ops-config-contract";
import {
  CONNECTION_TYPES,
  POLICY_KINDS,
  type OpsConfigKind,
  type OpsConfigSpec,
} from "@/lib/ops-config-types";
import { getScriptRuntimeMap } from "@/lib/script-runtime-client";
import type { ScriptRuntimeProfileMap } from "@/lib/script-runtime-contract";
import { parseSshEngineCatalog } from "@/lib/ssh";
import type { SshEngineCatalog } from "@/lib/ssh-types";

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
  const [engine, setEngine] = useState<KubernetesEngineCatalog | null>(null);
  const [sshEngine, setSshEngine] = useState<SshEngineCatalog | null>(null);
  const [runtimeMap, setRuntimeMap] = useState<ScriptRuntimeProfileMap | null>(
    null,
  );

  useEffect(() => {
    if (!ready || (kind !== "cluster_target" && kind !== "policy")) {
      return;
    }
    let cancelled = false;
    void getKubernetesCatalog(identity).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      setEngine(result.catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, kind, ready]);

  useEffect(() => {
    if (!ready || (kind !== "ssh_target" && kind !== "command_profile")) {
      return;
    }
    let cancelled = false;
    void Promise.all([getSshCatalog(identity), getOpsConfigCatalog(identity)]).then(
      ([ssh, ops]) => {
        if (cancelled) {
          return;
        }
        if (ssh.ok) {
          setSshEngine(ssh.catalog);
          return;
        }
        setSshEngine(
          ops.ok ? parseSshEngineCatalog(ops.catalog) : parseSshEngineCatalog(null),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [identity, kind, ready]);

  useEffect(() => {
    if (!ready || kind !== "runtime_profile") {
      return;
    }
    let cancelled = false;
    void getScriptRuntimeMap(identity).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      setRuntimeMap(result.map);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, kind, ready]);

  function patch(partial: Partial<OpsConfigSpec>) {
    onChange({ ...spec, ...partial });
  }

  const endpoint = spec.endpoint ?? {};
  const endpointPolicy = asRecord(spec.endpointPolicy);
  const recipientPolicy = asRecord(spec.recipientPolicy);
  const serviceAccount = spec.serviceAccount ?? {};
  const roleTemplate =
    serviceAccount.roleTemplate ||
    engine?.serviceAccount.roleTemplate ||
    KUBERNETES_ROLE_TEMPLATE;
  const catalogNotes = engine?.serviceAccount.notes
    ? [engine.serviceAccount.notes]
    : [];

  return (
    <div className="grid gap-3">
      {needsCredential(kind) && kind !== "ssh_target" ? (
        <CredentialRefSelect
          identity={identity}
          ready={ready}
          value={spec.credentialId ?? ""}
          disabled={readOnly}
          allowedTypes={
            kind === "cluster_target" ? [KUBERNETES_CREDENTIAL_TYPE] : undefined
          }
          onChange={(credentialId) => patch({ credentialId })}
        />
      ) : null}

      {kind === "cluster_target" ? (
        <>
          <KubernetesLeastPrivilegeNotes extraNotes={catalogNotes} />
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
          <PolicyRefSelect
            identity={identity}
            ready={ready}
            value={spec.policyId ?? ""}
            disabled={readOnly}
            onChange={(policyId) => patch({ policyId })}
          />
          <TextField
            label="Service account name"
            value={String(serviceAccount.name ?? "")}
            disabled={readOnly}
            className={inputClass}
            onChange={(name) =>
              patch({ serviceAccount: { ...serviceAccount, name } })
            }
          />
          <TextField
            label="Service account namespace"
            value={String(serviceAccount.namespace ?? "")}
            disabled={readOnly}
            className={inputClass}
            onChange={(namespace) =>
              patch({ serviceAccount: { ...serviceAccount, namespace } })
            }
          />
          <TextField
            label="Role template"
            value={String(roleTemplate)}
            disabled={readOnly}
            className={inputClass}
            onChange={(next) =>
              patch({
                serviceAccount: { ...serviceAccount, roleTemplate: next },
              })
            }
          />
          <p className="text-xs text-zinc-500">
            Optional operator metadata for E7.2. Default template is{" "}
            <code className="font-mono">{KUBERNETES_ROLE_TEMPLATE}</code>.
            ClusterRoles are not MVP. Paths come from GET /kubernetes/catalog.
          </p>
        </>
      ) : null}

      {kind === "ssh_target" ? (
        <SshTargetForm
          spec={spec}
          readOnly={readOnly}
          identity={identity}
          ready={ready}
          catalog={sshEngine}
          onChange={onChange}
        />
      ) : null}

      {kind === "command_profile" ? (
        <CommandProfileForm
          spec={spec}
          readOnly={readOnly}
          catalog={sshEngine}
          onChange={onChange}
        />
      ) : null}

      {kind === "runtime_profile" ? (
        <RuntimeProfileForm
          spec={spec}
          readOnly={readOnly}
          map={runtimeMap}
          onChange={onChange}
        />
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
          {isKubernetesPolicySpec(spec) ? (
            <KubernetesPolicyForm
              spec={spec}
              readOnly={readOnly}
              engine={engine}
              extraNotes={catalogNotes}
              onChange={onChange}
            />
          ) : (
            <JsonField
              label="Policy"
              value={spec.policy ?? {}}
              disabled={readOnly}
              className={inputClass}
              onChange={(policy) => patch({ policy })}
            />
          )}
        </>
      ) : null}

      {kindAcceptsPolicyId(kind) &&
      kind !== "cluster_target" &&
      kind !== "ssh_target" &&
      kind !== "command_profile" ? (
        <TextField
          label="Optional policy pin (UUID)"
          value={spec.policyId ?? ""}
          disabled={readOnly}
          className={inputClass}
          onChange={(policyId) => patch({ policyId })}
        />
      ) : null}
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
          const parsed = parseJsonObject(event.target.value);
          if (parsed) {
            onChange(parsed);
          }
        }}
        className={`${className} font-mono`}
      />
    </label>
  );
}
