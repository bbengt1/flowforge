"use client";

import { useEffect, useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import { ScriptIsolationNotes } from "@/components/config/ScriptIsolationNotes";
import { ScriptIoFields } from "@/components/workflows/ScriptIoFields";
import { ScriptRetryFields } from "@/components/workflows/ScriptRetryFields";
import { ScriptPublishStatus } from "@/components/workflows/ScriptPublishStatus";
import type { DevIdentity } from "@/lib/identity-headers";
import { selectOpsConfig } from "@/lib/ops-config-client";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import {
  SCRIPT_DRAFT_NOT_EXECUTABLE_HELP,
  SCRIPT_EXECUTE_FAIL_CLOSED_HELP,
  SCRIPT_NODE_POLICY_NOTES,
  SCRIPT_PUBLISH_BOUNDARY_HELP,
  defaultScriptEntrypoint,
  isScriptConfigurableType,
  runtimeProfileLanguage,
  scriptArtifactStatus,
  scriptNodeWithFields,
  validateScriptNodeConfig,
  type ScriptArtifact,
  type ScriptNodeCatalog,
  type ScriptVersionPin,
} from "@/lib/script-contract";
import {
  isDedicatedScriptIoWithField,
  parseScriptIoCatalog,
} from "@/lib/script-io-contract";
import { loadPublishedScriptRuntimeProfiles } from "@/lib/script-runtime-client";
import {
  SCRIPT_RUNTIME_LANGUAGE_FILTER_HELP,
  runtimeProfileMapFromCatalog,
  runtimeProfileSelectorLabel,
} from "@/lib/script-runtime-contract";
import type { YamlWorkflowNode } from "@/lib/workflow-yaml-nodes";

type ScriptAuthoringPanelProps = {
  node: YamlWorkflowNode;
  identity: DevIdentity;
  ready: boolean;
  dirty?: boolean;
  hasPublishedVersion?: boolean;
  scriptCatalog?: ScriptNodeCatalog | null;
  scriptArtifacts?: readonly ScriptVersionPin[] | null;
  artifacts?: readonly ScriptArtifact[] | null;
  permissions?: readonly string[] | null;
  onArtifactChange?: (artifact: ScriptArtifact) => void;
  onPatchNodeWith?: (id: string, patch: Record<string, unknown>) => void;
};

export function ScriptAuthoringPanel({
  node,
  identity,
  ready,
  dirty,
  hasPublishedVersion,
  scriptCatalog,
  scriptArtifacts,
  artifacts,
  permissions,
  onArtifactChange,
  onPatchNodeWith,
}: ScriptAuthoringPanelProps) {
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>();

  useEffect(() => {
    if (!ready || !isScriptConfigurableType(node.type)) {
      return;
    }
    let cancelled = false;
    void loadPublishedScriptRuntimeProfiles(identity, node.type).then((result) => {
      if (cancelled) {
        return;
      }
      setStatusCode(result.statusCode);
      if (!result.ok) {
        setProblem(result.problem);
        setPins([]);
        return;
      }
      setProblem(null);
      setPins(result.items);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, node.type, ready]);

  if (!isScriptConfigurableType(node.type)) {
    return null;
  }

  const selected = pins.find(
    (pin) =>
      pin.resourceId === node.with.runtimeProfileId ||
      pin.versionId === node.with.runtimeProfileId,
  );
  const selectorClosed =
    statusCode !== undefined && (pins.length === 0 || Boolean(problem));
  const errors = validateScriptNodeConfig(node.type, node.with, {
    profileSelectorClosed: selectorClosed,
    profileLanguage: runtimeProfileLanguage(selected?.spec),
    scriptCatalog,
  });
  const fields = scriptNodeWithFields(node.type, scriptCatalog).filter(
    (field) =>
      field.name !== "runtimeProfileId" &&
      !isDedicatedScriptIoWithField(field.name),
  );
  const ioCatalog = parseScriptIoCatalog(scriptCatalog);
  const nodePins = (scriptArtifacts ?? []).filter(
    (pin) => pin.nodeId === node.id || !pin.nodeId,
  );
  const status = scriptArtifactStatus({
    dirty,
    hasPublishedVersion,
    scriptArtifacts: nodePins.length ? nodePins : scriptArtifacts,
    artifacts,
  });

  function patch(name: string, value: unknown) {
    onPatchNodeWith?.(node.id, { [name]: value });
  }

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Script source</h2>
      <p className="mt-1 text-sm text-zinc-600">
        {SCRIPT_PUBLISH_BOUNDARY_HELP} {SCRIPT_DRAFT_NOT_EXECUTABLE_HELP}{" "}
        {SCRIPT_EXECUTE_FAIL_CLOSED_HELP} {SCRIPT_RUNTIME_LANGUAGE_FILTER_HELP}
      </p>
      <div className="mt-3">
        <ScriptIsolationNotes map={runtimeProfileMapFromCatalog(scriptCatalog)} />
      </div>
      <div className="mt-3">
        <AuthorizedResourceSelect
          kind="runtime_profile"
          label="Published runtime profile"
          value={selected?.versionId ?? ""}
          pins={pins}
          problem={problem}
          statusCode={statusCode}
          disabled={!onPatchNodeWith}
          optionLabel={runtimeProfileSelectorLabel}
          onChange={(pin) => {
            if (!pin) {
              patch("runtimeProfileId", "");
              return;
            }
            void selectOpsConfig(
              identity,
              "runtime_profile",
              pin.resourceId,
              pin.versionId,
            ).then(() => {
              patch("runtimeProfileId", pin.resourceId);
            });
          }}
        />
      </div>
      {fields.map((field) => {
        const value = node.with[field.name];
        const text =
          field.controlHint === "object-lines" && value && typeof value === "object"
            ? Object.entries(value as Record<string, unknown>)
                .map(([key, nested]) => `${key}=${String(nested)}`)
                .join("\n")
            : value == null
              ? ""
              : String(value);
        if (
          field.controlHint === "textarea" ||
          field.controlHint === "object-lines" ||
          field.controlHint === "json"
        ) {
          return (
            <label key={field.name} className="mt-3 block text-sm">
              <span className="font-medium">{field.label}</span>
              <textarea
                value={text}
                disabled={!onPatchNodeWith}
                rows={field.name === "source" ? 12 : 4}
                onChange={(event) => {
                  if (field.controlHint === "object-lines") {
                    const next: Record<string, string> = {};
                    for (const line of event.target.value.split("\n")) {
                      const cut = line.indexOf("=");
                      if (cut <= 0) {
                        continue;
                      }
                      next[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
                    }
                    patch(field.name, next);
                    return;
                  }
                  patch(field.name, event.target.value);
                }}
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm disabled:bg-zinc-50"
              />
              <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
            </label>
          );
        }
        return (
          <label key={field.name} className="mt-3 block text-sm">
            <span className="font-medium">{field.label}</span>
            <input
              type={field.controlHint === "number" ? "number" : "text"}
              value={
                text ||
                (field.name === "entrypoint" ? defaultScriptEntrypoint(node.type) : "")
              }
              disabled={!onPatchNodeWith}
              onChange={(event) =>
                patch(
                  field.name,
                  field.controlHint === "number"
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
            />
            <span className="mt-1 block text-xs text-zinc-500">{field.description}</span>
          </label>
        );
      })}
      <div className="mt-4">
        <ScriptIoFields
          inputSchema={node.with.inputSchema}
          outputSchema={node.with.outputSchema}
          catalog={ioCatalog}
          disabled={!onPatchNodeWith}
          onChange={(patchValue) => {
            onPatchNodeWith?.(node.id, patchValue);
          }}
        />
      </div>
      <div className="mt-4">
        <ScriptRetryFields
          retrySafe={node.with.retrySafe}
          idempotencyKey={node.with.idempotencyKey}
          verification={node.with.verification}
          retryPolicy={node.with.retryPolicy}
          catalog={ioCatalog}
          disabled={!onPatchNodeWith}
          onChange={(patchValue) => {
            onPatchNodeWith?.(node.id, {
              retrySafe: patchValue.retrySafe === true ? true : undefined,
              idempotencyKey: patchValue.idempotencyKey || undefined,
              verification: patchValue.verification,
              retryPolicy: patchValue.retryPolicy ?? { maxAttempts: 0 },
            });
          }}
        />
      </div>
      {errors.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-rose-900">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <details className="mt-3 rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-teal-950">
          Publish vs draft save
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-teal-950">
          {SCRIPT_NODE_POLICY_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
      <ScriptPublishStatus
        status={status}
        pins={nodePins}
        artifacts={artifacts}
        identity={identity}
        permissions={permissions}
        scriptCatalog={scriptCatalog}
        onArtifactChange={onArtifactChange}
      />
    </section>
  );
}
