"use client";

import { listCredentials } from "@/lib/credential-client";
import type { CredentialRecord, CredentialType } from "@/lib/credential-types";
import type { DevIdentity } from "@/lib/identity-headers";
import type { ProblemDetails } from "@/lib/problem";
import { useEffect, useState } from "react";

type CredentialRefSelectProps = {
  identity: DevIdentity;
  ready: boolean;
  value: string;
  disabled?: boolean;
  allowedTypes?: readonly CredentialType[];
  refreshNonce?: number;
  pendingItem?: Pick<CredentialRecord, "id" | "displayName" | "type"> | null;
  onChange: (credentialId: string, displayName: string) => void;
};

export function CredentialRefSelect({
  identity,
  ready,
  value,
  disabled,
  allowedTypes,
  refreshNonce = 0,
  pendingItem = null,
  onChange,
}: CredentialRefSelectProps) {
  const [items, setItems] = useState<CredentialRecord[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);

  const allowedKey = (allowedTypes ?? []).join(",");

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    const allowed = new Set(allowedKey ? allowedKey.split(",") : []);
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
      setItems(
        result.items.filter((item) => {
          if (item.status && item.status !== "active") {
            return false;
          }
          if (allowed.size > 0 && !allowed.has(item.type)) {
            return false;
          }
          return Boolean(item.id && item.displayName);
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ready, identity, allowedKey, refreshNonce]);

  const visibleItems =
    pendingItem && !items.some((item) => item.id === pendingItem.id)
      ? [
          ...items,
          {
            ...pendingItem,
            status: "active" as const,
            tags: [],
            metadata: {},
            fingerprint: "",
            encryptionVersion: 0,
            keyReference: "",
            lastTestStatus: "untested" as const,
            useCount: 0,
            permittedActions: [],
          },
        ]
      : items;

  return (
    <label className="block text-sm">
      <span className="font-medium">Vault credential</span>
      <select
        value={value}
        disabled={disabled || Boolean(problem) || visibleItems.length === 0}
        onChange={(event) => {
          const next = visibleItems.find((item) => item.id === event.target.value);
          onChange(next?.id ?? "", next?.displayName ?? "");
        }}
        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-50"
      >
        <option value="">
          {problem
            ? "No authorized credentials"
            : visibleItems.length === 0
              ? "No matching vault credentials"
              : "Select by display name"}
        </option>
        {visibleItems.map((item) => (
          <option key={item.id} value={item.id}>
            {item.displayName} ({item.type})
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-zinc-500">
        {allowedTypes?.includes("kubernetes")
          ? "Workspace type=kubernetes vault credentials only. Kubeconfig is never listed or pasted."
          : allowedTypes?.includes("ssh_private_key")
            ? "Workspace SSH vault credentials only (type=ssh_private_key). Keys, passwords, and host private material are never listed or pasted."
            : "E4.1 vault metadata only — display name and id. Kubeconfig and plaintext are never listed or stored here."}
      </span>
      {problem ? (
        <span className="mt-1 block text-sm text-amber-900">
          {problem.title}: credential list failed closed.
        </span>
      ) : null}
    </label>
  );
}
