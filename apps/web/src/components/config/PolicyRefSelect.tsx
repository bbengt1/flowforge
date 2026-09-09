"use client";

import { useEffect, useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import type { DevIdentity } from "@/lib/identity-headers";
import {
  listKubernetesPolicies,
  selectKubernetesPolicy,
} from "@/lib/kubernetes-client";
import { authorizedKubernetesPolicies } from "@/lib/kubernetes";
import type { OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";

type PolicyRefSelectProps = {
  identity: DevIdentity;
  ready: boolean;
  value: string;
  disabled?: boolean;
  onChange: (policyId: string, pin: OpsConfigPin | null) => void;
};

export function PolicyRefSelect({
  identity,
  ready,
  value,
  disabled,
  onChange,
}: PolicyRefSelectProps) {
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>();

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void listKubernetesPolicies(identity).then((result) => {
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
      setPins(authorizedKubernetesPolicies({ items: result.items }).options);
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
      kind="policy"
      label="Kubernetes policy pin"
      value={selected?.versionId ?? ""}
      pins={pins}
      problem={problem}
      statusCode={statusCode}
      disabled={disabled}
      onChange={(pin) => {
        if (!pin) {
          onChange("", null);
          return;
        }
        void selectKubernetesPolicy(identity, pin.resourceId, pin.versionId).then(
          (result) => {
            if (!result.ok) {
              setProblem(result.problem);
              setStatusCode(result.statusCode);
              onChange("", null);
              return;
            }
            setProblem(null);
            onChange(result.pin.resourceId, result.pin);
          },
        );
      }}
    />
  );
}
