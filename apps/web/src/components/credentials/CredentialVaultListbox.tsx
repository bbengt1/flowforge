"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CREDENTIAL_VAULT_COLUMNS,
  CREDENTIAL_VAULT_KEYBOARD_HELP,
  CREDENTIAL_VAULT_OPEN_LABEL,
  credentialVaultKeyAction,
  type CredentialVaultRow,
} from "@/lib/credential-vault";
import {
  FF_VAULT_LINK_CLASS,
  FF_VAULT_LIST_CLASS,
  FF_VAULT_MUTED_CLASS,
  FF_VAULT_ROW_CLASS,
  FF_VAULT_ROW_FOCUSED_CLASS,
  FF_VAULT_TITLE_CLASS,
  FF_VAULT_UUID_CLASS,
} from "@/lib/vault-executions-visual";

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
      <p className={`mb-3 text-xs ${FF_VAULT_MUTED_CLASS}`}>{CREDENTIAL_VAULT_KEYBOARD_HELP}</p>
      <div
        className={`mb-2 hidden min-w-[52rem] gap-3 px-3 text-xs font-medium tracking-wide uppercase ${FF_VAULT_MUTED_CLASS} sm:grid sm:grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,1fr)_6.5rem_minmax(7rem,0.9fr)_minmax(8rem,1fr)_8.5rem_3.75rem]`}
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
        className={`min-w-0 divide-y divide-border overflow-x-auto ${FF_VAULT_LIST_CLASS} outline-none`}
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
                  ? `${FF_VAULT_ROW_FOCUSED_CLASS} px-3 py-2.5`
                  : `${FF_VAULT_ROW_CLASS} px-3 py-2.5`
              }
            >
              <div className={VAULT_GRID}>
                <div className="min-w-0">
                  <p className={`truncate text-sm ${FF_VAULT_TITLE_CLASS}`}>
                    <span className={FF_VAULT_LINK_CLASS}>{row.displayName}</span>
                  </p>
                  <p className={FF_VAULT_UUID_CLASS}>
                    {row.id}
                  </p>
                </div>
                <p className="text-sm">{row.typeLabel}</p>
                <p
                  className={
                    row.status === "disabled"
                      ? `text-sm font-medium ${FF_VAULT_MUTED_CLASS}`
                      : "text-sm font-medium"
                  }
                >
                  {row.statusLabel}
                </p>
                <p className={`truncate text-sm ${FF_VAULT_MUTED_CLASS}`}>{row.tagsLabel}</p>
                <p className="font-mono text-xs">{row.lastTestLabel}</p>
                <p className="font-mono text-xs">{row.rotatedLabel}</p>
                <p className="text-sm">
                  <span className={`font-medium ${FF_VAULT_LINK_CLASS}`}>
                    {CREDENTIAL_VAULT_OPEN_LABEL}
                  </span>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
