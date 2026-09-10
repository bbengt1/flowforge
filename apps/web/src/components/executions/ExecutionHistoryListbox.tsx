"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import {
  IDEMPOTENCY_REPLAY_MESSAGE,
  KEYBOARD_HISTORY_HELP,
} from "@/lib/execution-contract";
import { historyKeyAction } from "@/lib/execution-replay";
import type { ExecutionListRow } from "@/lib/execution-types";

type ExecutionHistoryListboxProps = {
  rows: ExecutionListRow[];
  compact?: boolean;
};

export function ExecutionHistoryListbox({
  rows,
  compact = false,
}: ExecutionHistoryListboxProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const router = useRouter();
  const safeIndex = rows.length === 0 ? 0 : Math.min(focusIndex, rows.length - 1);
  const pad = compact ? "p-3" : "p-4";

  return (
    <div>
      <p className={compact ? "mb-2 text-xs text-zinc-500" : "mb-3 text-xs text-zinc-500"}>
        {KEYBOARD_HISTORY_HELP}
      </p>
      <ul
        role="listbox"
        aria-label="Execution history"
        tabIndex={0}
        onKeyDown={(event) => {
          const next = historyKeyAction(event.key, safeIndex, rows.length);
          if (next.index !== safeIndex) {
            event.preventDefault();
            setFocusIndex(next.index);
          }
          if (next.activate) {
            event.preventDefault();
            const href = rows[next.index]?.href;
            if (href) {
              router.push(href);
            }
          }
        }}
        className="grid gap-3 outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        {rows.map((row, index) => (
          <li
            key={row.id}
            role="option"
            aria-selected={index === safeIndex}
            className={
              row.indeterminate
                ? `rounded-xl border-2 border-amber-700 bg-amber-50 ${pad} shadow-sm`
                : index === safeIndex
                  ? `rounded-xl border border-teal-800 bg-white ${pad} shadow-sm ring-2 ring-teal-700/20`
                  : `rounded-xl border border-zinc-200 bg-white ${pad} shadow-sm`
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className={compact ? "text-sm font-semibold" : "text-base font-semibold"}>
                  <Link
                    href={row.href}
                    className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                  >
                    {row.workflowLabel}
                  </Link>
                </h3>
                <p className="mt-1 font-mono text-xs break-all text-zinc-600">{row.id}</p>
              </div>
              <ExecutionStatusBadge status={row.status} />
            </div>
            <dl className={`mt-3 grid gap-2 text-sm ${compact ? "" : "sm:grid-cols-2"}`}>
              <div>
                <dt className="text-zinc-500">Version pin</dt>
                <dd className="font-mono text-xs">{row.versionPin}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Correlation id</dt>
                <dd className="font-mono text-xs break-all">{row.correlationId}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Started</dt>
                <dd className="font-mono text-xs">{row.startedAt}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Finished</dt>
                <dd className="font-mono text-xs">{row.finishedAt}</dd>
              </div>
              <div className={compact ? "" : "sm:col-span-2"}>
                <dt className="text-zinc-500">Idempotency key</dt>
                <dd className="font-mono text-xs break-all">{row.idempotencyKey}</dd>
              </div>
            </dl>
            {row.replayed ? (
              <p className="mt-3 text-sm text-zinc-700">{IDEMPOTENCY_REPLAY_MESSAGE}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
