"use client";

import { useEffect, useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import type { DevIdentity } from "@/lib/identity-headers";
import { listOpsConfig, selectOpsConfig } from "@/lib/ops-config-client";
import type { OpsConfigKind, OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";
import { authorizedCommandProfiles, authorizedSshTargets } from "@/lib/ssh";
import { inspectorPinField } from "@/lib/editor-inspector";
import { isSshConfigurableType } from "@/lib/ssh-node-contract";

const SSH_PIN_KINDS: OpsConfigKind[] = ["ssh_target", "command_profile"];

type SshPinsPanelProps = {
  type: string;
  identity: DevIdentity;
  ready: boolean;
  values: Record<string, unknown>;
  disabled?: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
};

export function SshPinsPanel({
  type,
  identity,
  ready,
  values,
  disabled,
  onPatch,
}: SshPinsPanelProps) {
  if (!isSshConfigurableType(type)) {
    return null;
  }
  return (
    <div className="space-y-4">
      {SSH_PIN_KINDS.map((kind) => {
        const field = inspectorPinField(kind);
        return (
          <SshPinSelect
            key={kind}
            kind={kind}
            identity={identity}
            ready={ready}
            value={
              field && typeof values[field] === "string" ? String(values[field]) : ""
            }
            disabled={disabled}
            onChange={(pin) => {
              if (!field) {
                return;
              }
              onPatch({ [field]: pin?.resourceId ?? "" });
            }}
          />
        );
      })}
      <p className="text-xs text-zinc-500">
        Published SSH targets and command profiles only. Display name + version
        — never privateKey, passphrase, or host private material.
      </p>
    </div>
  );
}

type SshPinSelectProps = {
  kind: OpsConfigKind;
  identity: DevIdentity;
  ready: boolean;
  value: string;
  disabled?: boolean;
  onChange: (pin: OpsConfigPin | null) => void;
};

function SshPinSelect({
  kind,
  identity,
  ready,
  value,
  disabled,
  onChange,
}: SshPinSelectProps) {
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>();

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void listOpsConfig(identity, kind).then((result) => {
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
      const authorized =
        kind === "ssh_target"
          ? authorizedSshTargets({ items: result.items })
          : authorizedCommandProfiles({ items: result.items });
      setPins(authorized.options);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, ready, kind]);

  const selected = pins.find(
    (pin) => pin.resourceId === value || pin.versionId === value,
  );

  return (
    <AuthorizedResourceSelect
      kind={kind}
      label={
        kind === "command_profile"
          ? "Published command profile"
          : "Published SSH target"
      }
      value={selected?.versionId ?? ""}
      pins={pins}
      problem={problem}
      statusCode={statusCode}
      disabled={disabled}
      onChange={(pin) => {
        if (!pin) {
          onChange(null);
          return;
        }
        void selectOpsConfig(identity, kind, pin.resourceId, pin.versionId).then(
          (result) => {
            if (!result.ok) {
              setProblem(result.problem);
              setStatusCode(result.statusCode);
              onChange(null);
              return;
            }
            setProblem(null);
            onChange(result.pin);
          },
        );
      }}
    />
  );
}
