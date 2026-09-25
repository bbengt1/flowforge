"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FF_EDITOR_DANGER_CLASS, FF_EDITOR_GHOST_CLASS } from "@/lib/editor-visual";
import { FF_EXPLORER_MENU_ITEM_CLASS } from "@/lib/explorer-context-menu";
import { FF_OVERVIEW_MENU_CLASS } from "@/lib/overview-visual";
import { DELETE_WORKFLOW_LABEL } from "@/lib/workflow-delete";

export const EDITOR_WORKFLOW_OVERFLOW_ID = "editor-workflow-overflow";

type EditorWorkflowOverflowProps = {
  disabled?: boolean;
  onDelete: () => void;
};

/**
 * Capability-gated overflow beside the top-bar groups.
 * Save and Publish stay in the authoring group.
 */
export function EditorWorkflowOverflow({
  disabled = false,
  onDelete,
}: EditorWorkflowOverflowProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    itemRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      data-editor-workflow="overflow"
      className="relative shrink-0"
    >
      <button
        ref={buttonRef}
        id={EDITOR_WORKFLOW_OVERFLOW_ID}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="More actions"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`${FF_EDITOR_GHOST_CLASS} px-2 py-1 text-sm disabled:opacity-60`}
      >
        More actions
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="More actions"
          className={`absolute end-0 z-20 mt-1 min-w-44 p-1 shadow-lg ${FF_OVERVIEW_MENU_CLASS}`}
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            data-workflow-delete="overflow"
            className={`${FF_EXPLORER_MENU_ITEM_CLASS} ${FF_EDITOR_DANGER_CLASS}`}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            {DELETE_WORKFLOW_LABEL}
          </button>
        </div>
      ) : null}
    </div>
  );
}
