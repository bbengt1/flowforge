"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  captureSatelliteOverlayTrigger,
  restoreSatelliteOverlayFocus,
  satelliteOverlayAfterEscape,
  satelliteOverlayTriggerId,
} from "@/lib/rewrite-satellite-a11y";

type EditorStartDialogProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function EditorStartDialog({
  open,
  onClose,
  children,
}: EditorStartDialogProps) {
  const overlayTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      overlayTrigger.current = null;
      return;
    }
    overlayTrigger.current =
      overlayTrigger.current ?? captureSatelliteOverlayTrigger();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      const next = satelliteOverlayAfterEscape();
      onClose();
      if (next.restoreFocus) {
        restoreSatelliteOverlayFocus(
          overlayTrigger.current ??
            satelliteOverlayTriggerId("start-published"),
        );
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="editor-start-heading"
      className="fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-zinc-900/40 p-4"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-[var(--background)] p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="editor-start-heading" className="text-base font-semibold">
            Start published
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm hover:bg-zinc-50"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
