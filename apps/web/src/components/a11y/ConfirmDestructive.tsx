"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog } from "@/components/a11y/Dialog";
import {
  CONFIRM_DESTRUCTIVE_UNDO_PENDING,
  DESTRUCTIVE_UNDO_LABEL,
  armDestructiveUndo,
  confirmDestructiveConsequence,
  sanitizeDestructiveImpact,
  type DestructiveImpactItem,
  type DestructiveReversibility,
  type DestructiveUndoTicket,
} from "@/lib/confirm-destructive";
import {
  FF_OVERVIEW_DIALOG_CLASS,
  FF_OVERVIEW_GHOST_CLASS,
  FF_OVERVIEW_MUTED_CLASS,
  FF_OVERVIEW_TITLE_CLASS,
} from "@/lib/overview-visual";
import { FF_LOUD_DANGER_CLASS } from "@/lib/vault-executions-visual";

const DEFAULT_BACKDROP =
  "fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4";
const DEFAULT_PANEL = `${FF_OVERVIEW_DIALOG_CLASS} max-h-[90vh] w-full max-w-xl overflow-auto`;
const DEFAULT_CONFIRM = `${FF_LOUD_DANGER_CLASS} rounded-lg px-3 py-1.5 text-sm disabled:opacity-60`;

export type ConfirmDestructiveProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  impact: readonly DestructiveImpactItem[];
  reversibility: DestructiveReversibility;
  confirmLabel: string;
  pending?: boolean;
  pendingLabel?: string;
  canConfirm?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
  returnFocusTo?: string | null;
  backdropClassName?: string;
  panelClassName?: string;
  titleClassName?: string;
  mutedClassName?: string;
  confirmClassName?: string;
  cancelClassName?: string;
};

export function ConfirmDestructive({
  open,
  title,
  description,
  impact,
  reversibility,
  confirmLabel,
  pending = false,
  pendingLabel = "Working…",
  canConfirm = true,
  onConfirm,
  onClose,
  children,
  returnFocusTo = null,
  backdropClassName = DEFAULT_BACKDROP,
  panelClassName = DEFAULT_PANEL,
  titleClassName = FF_OVERVIEW_TITLE_CLASS,
  mutedClassName = FF_OVERVIEW_MUTED_CLASS,
  confirmClassName = DEFAULT_CONFIRM,
  cancelClassName = FF_OVERVIEW_GHOST_CLASS,
}: ConfirmDestructiveProps) {
  const headingId = useId();
  const consequence = confirmDestructiveConsequence(reversibility);
  const items = sanitizeDestructiveImpact(impact);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={headingId}
      returnFocusTo={returnFocusTo}
      className={backdropClassName}
    >
      <div
        data-confirm-destructive="dialog"
        data-confirm-destructive-undo={consequence.offersUndo ? "true" : "false"}
        className={panelClassName}
      >
        <h2 id={headingId} className={`text-lg ${titleClassName}`}>
          {title}
        </h2>
        {description ? (
          <div className={`mt-1 text-sm ${mutedClassName}`}>{description}</div>
        ) : null}
        <p className={`mt-3 text-sm font-medium ${titleClassName}`}>
          {consequence.message}
        </p>
        {items.length === 0 ? (
          <p className={`mt-3 text-sm ${mutedClassName}`}>
            Nothing is listed as affected.
          </p>
        ) : (
          <ul aria-label="What this will affect" className="mt-3 space-y-2 text-sm">
            {items.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{item.label}</span>
                {item.detail ? (
                  <span className={mutedClassName}> — {item.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {children}
        <div data-confirm-destructive="actions" className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={cancelClassName}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || !canConfirm}
            className={confirmClassName}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function DestructiveUndoBar({
  ticket,
  title,
  detail,
  onUndo,
  onCommit,
}: {
  ticket: DestructiveUndoTicket | null;
  title: string;
  detail?: string;
  onUndo: () => void;
  onCommit: () => void;
}) {
  const onUndoRef = useRef(onUndo);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onUndoRef.current = onUndo;
    onCommitRef.current = onCommit;
  }, [onUndo, onCommit]);

  useEffect(() => {
    if (!ticket) {
      return;
    }
    const delay = Math.max(0, ticket.commitAt - Date.now());
    const timer = window.setTimeout(() => {
      onCommitRef.current();
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [ticket]);

  if (!ticket) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-confirm-destructive="undo"
      className={`${FF_OVERVIEW_DIALOG_CLASS} mt-3 flex flex-wrap items-center justify-between gap-3`}
    >
      <div>
        <p className={`text-sm font-medium ${FF_OVERVIEW_TITLE_CLASS}`}>{title}</p>
        {detail ? (
          <p className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>{detail}</p>
        ) : null}
        <p className={`text-sm ${FF_OVERVIEW_MUTED_CLASS}`}>
          {CONFIRM_DESTRUCTIVE_UNDO_PENDING}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onUndoRef.current()}
        className={FF_OVERVIEW_GHOST_CLASS}
      >
        {DESTRUCTIVE_UNDO_LABEL}
      </button>
    </div>
  );
}

export function useDestructiveUndo(onCommit: (id: string) => void): {
  ticket: DestructiveUndoTicket | null;
  arm: (id: string) => void;
  undo: () => void;
  commit: () => void;
} {
  const [ticket, setTicket] = useState<DestructiveUndoTicket | null>(null);
  const ticketRef = useRef<DestructiveUndoTicket | null>(null);
  const onCommitRef = useRef(onCommit);
  const tokenRef = useRef(0);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const commit = useCallback(() => {
    const current = ticketRef.current;
    if (!current) {
      return;
    }
    ticketRef.current = null;
    setTicket(null);
    onCommitRef.current(current.id);
  }, []);

  const undo = useCallback(() => {
    ticketRef.current = null;
    setTicket(null);
  }, []);

  const arm = useCallback((id: string) => {
    tokenRef.current += 1;
    const decision = armDestructiveUndo({
      current: ticketRef.current,
      nextId: id,
      now: Date.now(),
      token: tokenRef.current,
    });
    if (decision.commitId) {
      onCommitRef.current(decision.commitId);
    }
    ticketRef.current = decision.ticket;
    setTicket(decision.ticket);
  }, []);

  return { ticket, arm, undo, commit };
}
