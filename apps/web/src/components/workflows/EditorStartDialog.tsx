"use client";

import type { ReactNode } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import { satelliteOverlayTriggerId } from "@/lib/rewrite-satellite-a11y";

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
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="editor-start-heading"
      returnFocusTo={satelliteOverlayTriggerId("start-published")}
      className="fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-[color-mix(in_srgb,var(--ff-canvas)_40%,transparent)] p-4"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-[var(--background)] p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="editor-start-heading" className="text-base font-semibold">
            Start published
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm hover:bg-fg/10"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </Dialog>
  );
}
