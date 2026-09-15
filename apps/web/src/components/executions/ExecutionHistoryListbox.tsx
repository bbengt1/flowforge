"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
import { ExecutionStatusBadge } from "@/components/executions/ExecutionStatusBadge";
import { isExecutionAwaitingApproval } from "@/lib/approval";
import { PeakEndEnding } from "@/components/chrome/PeakEndEnding";
import {
  peakEndKind,
  peakEndOverlayRowShowsEnding,
} from "@/lib/peak-end-operate-endings";
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
import {
  FF_INBOX_LINK_CLASS,
  FF_INBOX_LIST_CLASS,
  FF_INBOX_MUTED_CLASS,
  FF_INBOX_ROW_CLASS,
  FF_INBOX_ROW_FOCUSED_CLASS,
  FF_INBOX_ROW_INDETERMINATE_CLASS,
  FF_INBOX_ROW_WAITING_CLASS,
  FF_INBOX_TITLE_CLASS,
  FF_VAULT_UUID_CLASS,
} from "@/lib/vault-executions-visual";

type ExecutionHistoryListboxProps = {
  rows: ExecutionListRow[];
  compact?: boolean;
  layout?: "cards" | "inbox" | "overlay";
  selectedId?: string;
  keyboardHelp?: string;
  onActivate?: (row: ExecutionListRow) => void;
  operateActions?: (row: ExecutionListRow) => ReactNode;
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
  operateActions,
}: ExecutionHistoryListboxProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const router = useRouter();
  const safeIndex = rows.length === 0 ? 0 : Math.min(focusIndex, rows.length - 1);
  const inbox = layout === "inbox";
  const overlay = layout === "overlay";
  const pad = overlay ? "p-2.5" : compact ? "p-3" : inbox ? "px-3 py-2.5" : "p-4";
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
      <p className={compact ? `mb-2 text-xs ${FF_INBOX_MUTED_CLASS}` : `mb-3 text-xs ${FF_INBOX_MUTED_CLASS}`}>
        {help}
      </p>
      {inbox ? (
        <div
          className={`mb-2 hidden min-w-[52rem] gap-3 px-3 text-xs font-medium tracking-wide uppercase ${FF_INBOX_MUTED_CLASS} sm:grid sm:grid-cols-[7.5rem_minmax(11rem,1.5fr)_7.5rem_9.25rem_5.25rem_minmax(6.5rem,0.8fr)_3.75rem]`}
          aria-hidden="true"
        >
          {EXECUTION_INBOX_COLUMNS.map((column) => (
            <span key={column.id}>{column.label}</span>
          ))}
        </div>
      ) : null}
      <ul
        role="listbox"
        aria-label={
          inbox ? "Workspace executions" : overlay ? "Workflow runs" : "Execution history"
        }
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
            ? `min-w-0 divide-y divide-white/10 overflow-x-auto ${FF_INBOX_LIST_CLASS} outline-none`
            : "grid gap-3 outline-none"
        }
      >
        {rows.map((row, index) => {
          const focused = selectedId ? row.id === selectedId : index === safeIndex;
          const started = executionInboxTimeLabel(row.startedAt);
          const duration = executionInboxDurationLabel(row.startedAt, row.finishedAt);
          const waiting = isExecutionAwaitingApproval(row.status);
          const ending = peakEndKind(row.status, waiting);
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
                    ? `${pad} ${FF_INBOX_ROW_INDETERMINATE_CLASS}`
                    : waiting
                      ? `${pad} ${FF_INBOX_ROW_WAITING_CLASS}`
                      : focused
                        ? `${pad} ${FF_INBOX_ROW_FOCUSED_CLASS}`
                        : `${pad} ${FF_INBOX_ROW_CLASS}`
                  : row.indeterminate
                    ? `rounded-xl ${FF_INBOX_ROW_INDETERMINATE_CLASS} ${pad}`
                    : waiting
                      ? `rounded-xl ${FF_INBOX_ROW_WAITING_CLASS} ${pad}`
                    : row.id === selectedId
                      ? `rounded-xl ${FF_INBOX_ROW_FOCUSED_CLASS} ${pad}`
                      : index === safeIndex
                        ? `rounded-xl ${FF_INBOX_ROW_FOCUSED_CLASS} ${pad}`
                        : `rounded-xl ${FF_INBOX_ROW_CLASS} ${pad}`
              }
            >
              {overlay ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-[11px]">{row.versionPin}</p>
                      <p className={`mt-1 font-mono text-[11px] ${FF_INBOX_MUTED_CLASS}`}>
                        {started} · {duration}
                      </p>
                      <p className={`mt-1 ${FF_VAULT_UUID_CLASS}`}>
                        {row.id}
                      </p>
                    </div>
                    <ExecutionStatusBadge status={row.status} />
                  </div>
                  {peakEndOverlayRowShowsEnding(ending, {
                    focused,
                    selected: Boolean(selectedId) && row.id === selectedId,
                  }) ? (
                    <PeakEndEnding
                      kind={ending}
                      surface="overlay"
                      className="mt-2"
                    />
                  ) : null}
                  {row.replayed ? (
                    <p className={`mt-1 text-[11px] ${FF_INBOX_MUTED_CLASS}`}>Replayed</p>
                  ) : null}
                  <p className="mt-2 text-xs">
                    <Link
                      href={row.href}
                      onClick={(event) => event.stopPropagation()}
                      className={`font-medium ${FF_INBOX_LINK_CLASS}`}
                    >
                      {EXECUTION_INBOX_OPEN_LABEL}
                    </Link>
                    <span className={FF_INBOX_MUTED_CLASS}> — /executions/{"{id}"}</span>
                  </p>
                  {operateActions ? (
                    <div className="mt-2">{operateActions(row)}</div>
                  ) : null}
                </>
              ) : inbox ? (
                <>
                <div className={INBOX_GRID}>
                  <div>
                    <ExecutionStatusBadge status={row.status} />
                  </div>
                  <div className="min-w-0">
                    <p className={`truncate text-sm ${FF_INBOX_TITLE_CLASS}`}>
                      <Link
                        href={row.href}
                        onClick={(event) => event.stopPropagation()}
                        className={FF_INBOX_LINK_CLASS}
                      >
                        {row.workflowLabel}
                      </Link>
                    </p>
                    <p className={FF_VAULT_UUID_CLASS}>
                      {row.id}
                    </p>
                    {row.indeterminate || waiting || ending === "success" || ending === "failed" ? (
                      <PeakEndEnding
                        kind={ending}
                        surface="inbox"
                        className="mt-1"
                      />
                    ) : null}
                    {row.replayed ? (
                      <p className={`mt-1 text-xs ${FF_INBOX_MUTED_CLASS}`}>Replayed</p>
                    ) : null}
                  </div>
                  <p className="font-mono text-xs">{row.versionPin}</p>
                  <p className="font-mono text-xs" title={row.startedAt}>
                    {started}
                  </p>
                  <p className="font-mono text-xs">{duration}</p>
                  <p className={`font-mono text-xs break-all ${FF_INBOX_MUTED_CLASS}`}>
                    {row.correlationId}
                  </p>
                  <p className="text-sm">
                    <Link
                      href={row.href}
                      onClick={(event) => event.stopPropagation()}
                      className={`font-medium ${FF_INBOX_LINK_CLASS}`}
                    >
                      {EXECUTION_INBOX_OPEN_LABEL}
                    </Link>
                  </p>
                </div>
                {operateActions ? (
                  <div className="mt-2">{operateActions(row)}</div>
                ) : null}
                </>
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
                            className={`text-left ${FF_INBOX_LINK_CLASS}`}
                          >
                            {row.workflowLabel}
                          </button>
                        ) : (
                          <Link
                            href={row.href}
                            className={FF_INBOX_LINK_CLASS}
                          >
                            {row.workflowLabel}
                          </Link>
                        )}
                      </h3>
                      <p className={`mt-1 ${FF_VAULT_UUID_CLASS}`}>{row.id}</p>
                    </div>
                    <ExecutionStatusBadge status={row.status} />
                  </div>
                  <dl className={`mt-3 grid gap-2 text-sm ${compact ? "" : "sm:grid-cols-2"}`}>
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Version pin</dt>
                      <dd className="font-mono text-xs">{row.versionPin}</dd>
                    </div>
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Correlation id</dt>
                      <dd className="font-mono text-xs break-all">{row.correlationId}</dd>
                    </div>
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Started</dt>
                      <dd className="font-mono text-xs">{row.startedAt}</dd>
                    </div>
                    <div>
                      <dt className={FF_INBOX_MUTED_CLASS}>Finished</dt>
                      <dd className="font-mono text-xs">{row.finishedAt}</dd>
                    </div>
                    <div className={compact ? "" : "sm:col-span-2"}>
                      <dt className={FF_INBOX_MUTED_CLASS}>Idempotency key</dt>
                      <dd className="font-mono text-xs break-all">{row.idempotencyKey}</dd>
                    </div>
                  </dl>
                  {row.replayed ? (
                    <p className="mt-3 text-sm">{IDEMPOTENCY_REPLAY_MESSAGE}</p>
                  ) : null}
                  {onActivate ? (
                    <p className="mt-3 text-xs">
                      <Link
                        href={row.href}
                        onClick={(event) => event.stopPropagation()}
                        className={`font-medium ${FF_INBOX_LINK_CLASS}`}
                      >
                        Open execution
                      </Link>
                      <span className={FF_INBOX_MUTED_CLASS}> — workspace replay</span>
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
