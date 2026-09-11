"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import {
  EXECUTION_INBOX_COLUMNS,
  EXECUTION_INBOX_KEYBOARD_HELP,
  EXECUTION_INBOX_OPEN_LABEL,
  executionInboxDurationLabel,
  executionInboxTimeLabel,
} from "@/lib/execution-inbox";
import {
  IDEMPOTENCY_REPLAY_MESSAGE,
  INDETERMINATE_STATUS_HELP,
  KEYBOARD_HISTORY_HELP,
} from "@/lib/execution-contract";
import { historyKeyAction } from "@/lib/execution-replay";
import type { ExecutionListRow } from "@/lib/execution-types";

type ExecutionHistoryListboxProps = {
  rows: ExecutionListRow[];
  compact?: boolean;
  layout?: "cards" | "inbox";
  selectedId?: string;
  keyboardHelp?: string;
  onActivate?: (row: ExecutionListRow) => void;
};

const INBOX_GRID =
  "grid gap-2 sm:grid-cols-[7.5rem_minmax(11rem,1.5fr)_7.5rem_9.25rem_5.25rem_minmax(6.5rem,0.8fr)_3.75rem] sm:items-center";

export function ExecutionHistoryListbox({
  rows,
  compact = false,
  layout = "cards",
  selectedId,
  keyboardHelp,
  onActivate,
}: ExecutionHistoryListboxProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const router = useRouter();
  const safeIndex = rows.length === 0 ? 0 : Math.min(focusIndex, rows.length - 1);
  const inbox = layout === "inbox";
  const pad = compact ? "p-3" : inbox ? "px-3 py-2.5" : "p-4";
  const help =
    keyboardHelp ?? (inbox ? EXECUTION_INBOX_KEYBOARD_HELP : KEYBOARD_HISTORY_HELP);

  function activate(row: ExecutionListRow | undefined) {
    if (!row) {
      return;
    }
    if (onActivate) {
      onActivate(row);
    } else if (row.href) {
      router.push(row.href);
    }
  }

  return (
    <div>
      <p className={compact ? "mb-2 text-xs text-zinc-500" : "mb-3 text-xs text-zinc-500"}>
        {help}
      </p>
      {inbox ? (
        <div
          className={`mb-2 hidden min-w-[52rem] gap-3 px-3 text-xs font-medium tracking-wide text-zinc-500 uppercase sm:grid sm:grid-cols-[7.5rem_minmax(11rem,1.5fr)_7.5rem_9.25rem_5.25rem_minmax(6.5rem,0.8fr)_3.75rem]`}
          aria-hidden="true"
        >
          {EXECUTION_INBOX_COLUMNS.map((column) => (
            <span key={column.id}>{column.label}</span>
          ))}
        </div>
      ) : null}
      <ul
        role="listbox"
        aria-label={inbox ? "Workspace executions" : "Execution history"}
        tabIndex={0}
        onKeyDown={(event) => {
          const next = historyKeyAction(event.key, safeIndex, rows.length);
          if (next.index !== safeIndex) {
            event.preventDefault();
            setFocusIndex(next.index);
          }
          if (next.activate) {
            event.preventDefault();
            activate(rows[next.index]);
          }
        }}
        className={
          inbox
            ? "min-w-0 divide-y divide-zinc-100 overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
            : "grid gap-3 outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
        }
      >
        {rows.map((row, index) => {
          const focused = selectedId ? row.id === selectedId : index === safeIndex;
          const started = executionInboxTimeLabel(row.startedAt);
          const duration = executionInboxDurationLabel(row.startedAt, row.finishedAt);
          return (
            <li
              key={row.id}
              role="option"
              aria-selected={focused}
              onClick={() => activate(row)}
              title={row.indeterminate ? INDETERMINATE_STATUS_HELP : undefined}
              className={
                inbox
                  ? row.indeterminate
                    ? `${pad} cursor-pointer border-l-4 border-amber-700 bg-amber-50`
                    : focused
                      ? `${pad} cursor-pointer bg-teal-50`
                      : `${pad} cursor-pointer bg-white hover:bg-zinc-50`
                  : row.indeterminate
                    ? `rounded-xl border-2 border-amber-700 bg-amber-50 ${pad} shadow-sm`
                    : row.id === selectedId
                      ? `rounded-xl border border-teal-800 bg-teal-50 ${pad} shadow-sm ring-2 ring-teal-700/20`
                      : index === safeIndex
                        ? `rounded-xl border border-teal-800 bg-white ${pad} shadow-sm ring-2 ring-teal-700/20`
                        : `rounded-xl border border-zinc-200 bg-white ${pad} shadow-sm`
              }
            >
              {inbox ? (
                <div className={INBOX_GRID}>
                  <div>
                    <ExecutionStatusBadge status={row.status} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      <Link
                        href={row.href}
                        onClick={(event) => event.stopPropagation()}
                        className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                      >
                        {row.workflowLabel}
                      </Link>
                    </p>
                    <p className="font-mono text-[11px] break-all text-zinc-500">
                      {row.id}
                    </p>
                    {row.indeterminate ? (
                      <p className="mt-1 text-xs font-medium text-amber-950">
                        Indeterminate — do not assume the action did not run.
                      </p>
                    ) : null}
                    {row.replayed ? (
                      <p className="mt-1 text-xs text-zinc-600">Replayed</p>
                    ) : null}
                  </div>
                  <p className="font-mono text-xs text-zinc-700">{row.versionPin}</p>
                  <p className="font-mono text-xs text-zinc-700" title={row.startedAt}>
                    {started}
                  </p>
                  <p className="font-mono text-xs text-zinc-700">{duration}</p>
                  <p className="font-mono text-xs break-all text-zinc-600">
                    {row.correlationId}
                  </p>
                  <p className="text-sm">
                    <Link
                      href={row.href}
                      onClick={(event) => event.stopPropagation()}
                      className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                    >
                      {EXECUTION_INBOX_OPEN_LABEL}
                    </Link>
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className={compact ? "text-sm font-semibold" : "text-base font-semibold"}>
                        {onActivate ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onActivate(row);
                            }}
                            className="text-left underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                          >
                            {row.workflowLabel}
                          </button>
                        ) : (
                          <Link
                            href={row.href}
                            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
                          >
                            {row.workflowLabel}
                          </Link>
                        )}
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
                  {onActivate ? (
                    <p className="mt-3 text-xs">
                      <Link
                        href={row.href}
                        onClick={(event) => event.stopPropagation()}
                        className="font-medium text-teal-800 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-700"
                      >
                        Open execution
                      </Link>
                      <span className="text-zinc-500"> — workspace replay</span>
                    </p>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
