"use client";

import { listCredentials } from "@/lib/credential-client";
import type { CredentialRecord } from "@/lib/credential-types";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { useEffect, useState } from "react";

type CredentialRefSelectProps = {
  identity: DevIdentity;
  ready: boolean;
  value: string;
  disabled?: boolean;
  onChange: (credentialId: string, displayName: string) => void;
};

export function CredentialRefSelect({
  identity,
  ready,
  value,
  disabled,
  onChange,
}: CredentialRefSelectProps) {
  const [items, setItems] = useState<CredentialRecord[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void listCredentials(identity).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setProblem(result.problem);
        setItems([]);
        return;
      }
      setProblem(null);
      setItems(result.items);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, identity]);

  return (
    <label className="block text-sm">
      <span className="font-medium">Vault credential</span>
      <select
        value={value}
        disabled={disabled || Boolean(problem)}
        onChange={(event) => {
          const next = items.find((item) => item.id === event.target.value);
          onChange(next?.id ?? "", next?.displayName ?? "");
        }}
        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-50"
      >
        <option value="">Select by display name</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.displayName} ({item.type})
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-zinc-500">
        E4.1 vault metadata only. Secrets are never listed or stored here.
      </span>
      {problem ? (
        <span className="mt-1 block text-sm text-amber-900">
          {problem.title}: credential list failed closed.
        </span>
      ) : null}
    </label>
  );
}
