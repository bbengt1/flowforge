"use client";

import { useEffect, useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import type { DevIdentity } from "@/lib/identity-headers";
import {
  listClusterTargets,
  selectClusterTarget,
} from "@/lib/kubernetes-client";
import { authorizedClusterTargets } from "@/lib/kubernetes";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";

type KubernetesTargetSelectProps = {
  identity: DevIdentity;
  ready: boolean;
  value: string;
  disabled?: boolean;
  onChange: (pin: OpsConfigPin | null) => void;
};

export function KubernetesTargetSelect({
  identity,
  ready,
  value,
  disabled,
  onChange,
}: KubernetesTargetSelectProps) {
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>();

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void listClusterTargets(identity).then((result) => {
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
      setPins(authorizedClusterTargets({ items: result.items }).options);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, ready]);

  const selected = pins.find(
    (pin) => pin.resourceId === value || pin.versionId === value,
  );

  return (
    <AuthorizedResourceSelect
      kind="cluster_target"
      label="Authorized cluster target"
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
        void selectClusterTarget(identity, pin.resourceId, pin.versionId).then(
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
