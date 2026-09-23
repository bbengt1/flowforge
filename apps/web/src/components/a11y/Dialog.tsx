"use client";

import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  dialogChildShouldBeInert,
  dialogEscapeCloses,
  dialogStackIsTop,
  dialogStackPop,
  dialogStackPush,
  dialogTabTargetIndex,
  isDialogTabStop,
} from "@/lib/a11y-dialog";
import { restoreSatelliteOverlayFocus } from "@/lib/rewrite-satellite-a11y";

export type DialogProps = {
  open?: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  id?: string;
  labelledBy?: string;
  label?: string;
  /** Fallback element id when the opener was not focused at open time. */
  returnFocusTo?: string | null;
  /**
   * `opener` restores the control that opened the dialog.
   * `target` always restores `returnFocusTo` (command palette → Commands).
   */
  restoreFocus?: "opener" | "target";
  onClick?: MouseEventHandler<HTMLDivElement>;
};

function useIsClient(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function focusableDialogElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)].filter(
    (element) => {
      const disabled =
        "disabled" in element &&
        Boolean((element as HTMLButtonElement).disabled);
      const hidden =
        element.hasAttribute("hidden") ||
        element.getAttribute("aria-hidden") === "true";
      const inert = element.closest("[inert]") !== null;
      const style = window.getComputedStyle(element);
      const visuallyHidden =
        style.display === "none" || style.visibility === "hidden";
      return isDialogTabStop({
        disabled,
        tabIndex: element.tabIndex,
        hidden: hidden || visuallyHidden,
        inert,
        ariaHidden: false,
      });
    },
  );
}

function inertBackground(dialog: HTMLElement): Element[] {
  const inerted: Element[] = [];
  for (const child of Array.from(document.body.children)) {
    const containsDialog = child === dialog || child.contains(dialog);
    if (
      !dialogChildShouldBeInert({
        tagName: child.tagName,
        containsDialog,
        alreadyInert: child.hasAttribute("inert"),
      })
    ) {
      continue;
    }
    child.setAttribute("inert", "");
    inerted.push(child);
  }
  return inerted;
}

export function Dialog({
  open = true,
  onClose,
  children,
  className,
  id,
  labelledBy,
  label,
  returnFocusTo = null,
  restoreFocus = "opener",
  onClick,
}: DialogProps) {
  const mounted = useIsClient();
  const reactId = useId();
  const token = useRef<symbol>(Symbol("flowforge-dialog"));
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef(returnFocusTo);
  const restoreModeRef = useRef(restoreFocus);

  useEffect(() => {
    onCloseRef.current = onClose;
    returnFocusRef.current = returnFocusTo;
    restoreModeRef.current = restoreFocus;
  }, [onClose, restoreFocus, returnFocusTo]);

  useEffect(() => {
    if (!open || !mounted) {
      return;
    }
    const dialogNode = dialogRef.current;
    if (!dialogNode) {
      return;
    }
    const dialog: HTMLElement = dialogNode;
    const dialogToken = token.current;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !dialog.contains(active)) {
      openerRef.current = active;
    }
    dialogStackPush(dialogToken);
    const inerted = inertBackground(dialog);
    if (!dialog.contains(document.activeElement)) {
      const items = focusableDialogElements(dialog);
      (items[0] ?? dialog).focus();
    }

    function onKey(event: KeyboardEvent) {
      const isTop = dialogStackIsTop(dialogToken);
      if (
        dialogEscapeCloses({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          isTop,
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !isTop) {
        return;
      }
      const items = focusableDialogElements(dialog);
      const activeElement = document.activeElement;
      const index =
        activeElement instanceof HTMLElement ? items.indexOf(activeElement) : -1;
      const next = dialogTabTargetIndex(items.length, index, event.shiftKey);
      if (next === null) {
        return;
      }
      event.preventDefault();
      if (next < 0) {
        dialog.focus();
        return;
      }
      items[next]?.focus();
    }

    function onFocusIn(event: FocusEvent) {
      if (!dialogStackIsTop(dialogToken)) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && dialog.contains(target)) {
        return;
      }
      const items = focusableDialogElements(dialog);
      (items[0] ?? dialog).focus();
    }

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      for (const element of inerted) {
        element.removeAttribute("inert");
      }
      dialogStackPop(dialogToken);
      const target =
        restoreModeRef.current === "target"
          ? returnFocusRef.current ?? openerRef.current
          : openerRef.current ?? returnFocusRef.current ?? null;
      openerRef.current = null;
      restoreSatelliteOverlayFocus(target);
    };
  }, [mounted, open]);

  if (!open || !mounted) {
    return null;
  }

  return createPortal(
    <div
      ref={dialogRef}
      id={id ?? reactId}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      tabIndex={-1}
      data-a11y-backdrop="inert"
      className={className}
      onClick={onClick}
    >
      {children}
    </div>,
    document.body,
  );
}
