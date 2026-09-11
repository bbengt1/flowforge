"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CREDENTIAL_VAULT_COLUMNS,
  CREDENTIAL_VAULT_KEYBOARD_HELP,
  CREDENTIAL_VAULT_OPEN_LABEL,
  credentialVaultKeyAction,
  type CredentialVaultRow,
} from "@/lib/credential-vault";

type CredentialVaultListboxProps = {
  rows: CredentialVaultRow[];
};

const VAULT_GRID =
  "grid gap-2 sm:grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,1fr)_6.5rem_minmax(7rem,0.9fr)_minmax(8rem,1fr)_8.5rem_3.75rem] sm:items-center";

export function CredentialVaultListbox({ rows }: CredentialVaultListboxProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const router = useRouter();
  const safeIndex = rows.length === 0 ? 0 : Math.min(focusIndex, rows.length - 1);

  function activate(row: CredentialVaultRow | undefined) {
    if (!row?.href) {
      return;
    }
    router.push(row.href);
  }

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">{CREDENTIAL_VAULT_KEYBOARD_HELP}</p>
      <div
        className={`mb-2 hidden min-w-[52rem] gap-3 px-3 text-xs font-medium tracking-wide text-zinc-500 uppercase sm:grid sm:grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,1fr)_6.5rem_minmax(7rem,0.9fr)_minmax(8rem,1fr)_8.5rem_3.75rem]`}
        aria-hidden="true"
      >
        {CREDENTIAL_VAULT_COLUMNS.map((column) => (
          <span key={column.id}>{column.label}</span>
        ))}
      </div>
      <ul
        role="listbox"
        aria-label="Workspace credentials"
        tabIndex={0}
        onKeyDown={(event) => {
          const next = credentialVaultKeyAction(event.key, safeIndex, rows.length);
          if (next.index !== safeIndex) {
            event.preventDefault();
            setFocusIndex(next.index);
          }
          if (next.activate) {
            event.preventDefault();
            activate(rows[next.index]);
          }
        }}
        className="min-w-0 divide-y divide-zinc-100 overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        {rows.map((row, index) => {
          const focused = index === safeIndex;
          return (
            <li
              key={row.id}
              role="option"
              aria-selected={focused}
              onClick={() => activate(row)}
              className={
                focused
                  ? "cursor-pointer bg-teal-50 px-3 py-2.5"
                  : "cursor-pointer bg-white px-3 py-2.5 hover:bg-zinc-50"
              }
            >
              <div className={VAULT_GRID}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    <Link
                      href={row.href}
                      onClick={(event) => event.stopPropagation()}
                      className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                    >
                      {row.displayName}
                    </Link>
                  </p>
                  <p className="font-mono text-[11px] break-all text-zinc-500">
                    {row.id}
                  </p>
                </div>
                <p className="text-sm text-zinc-700">{row.typeLabel}</p>
                <p
                  className={
                    row.status === "disabled"
                      ? "text-sm font-medium text-zinc-600"
                      : "text-sm font-medium text-teal-950"
                  }
                >
                  {row.statusLabel}
                </p>
                <p className="truncate text-sm text-zinc-600">{row.tagsLabel}</p>
                <p className="font-mono text-xs text-zinc-700">{row.lastTestLabel}</p>
                <p className="font-mono text-xs text-zinc-700">{row.rotatedLabel}</p>
                <p className="text-sm">
                  <Link
                    href={row.href}
                    onClick={(event) => event.stopPropagation()}
                    className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                  >
                    {CREDENTIAL_VAULT_OPEN_LABEL}
                  </Link>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
