"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/a11y/Dialog";
import { Field } from "@/components/a11y/Field";
import { useEmbedMode } from "@/components/embed/EmbedMode";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import {
  commandHref,
  filterPaletteCommands,
  isWorkflowHomePath,
  PALETTE_INPUT_LABEL,
  PALETTE_RESULTS_ID,
  PALETTE_SHORTCUT_HELP,
  paletteCommands,
  paletteHighlightIndex,
} from "@/lib/command-palette";
import { editorWorkflowIdFromPath } from "@/lib/editor-chrome";
import { maybeEmbedDeepLink } from "@/lib/embed-tenancy-contract";
import { dispatchWorkspaceCommand } from "@/lib/workspace-commands";

function executionIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/executions\/([^/]+)$/);
  return match?.[1];
}

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const embed = useEmbedMode();
  const { permissions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const workflowId = editorWorkflowIdFromPath(pathname);
  const executionId = executionIdFromPath(pathname);
  const commands = useMemo(
    () => paletteCommands(permissions, { workflowId, executionId }),
    [permissions, workflowId, executionId],
  );
  const visible = filterPaletteCommands(commands, query);
  const highlighted = visible[highlight] ?? visible[0];

  function closePalette() {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        setOpen((current) => {
          if (current) {
            setQuery("");
            setHighlight(0);
            return false;
          }
          return true;
        });
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        closePalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function run(id: string) {
    const command = commands.find((item) => item.id === id);
    if (!command) {
      return;
    }
    setOpen(false);
    setQuery("");
    setHighlight(0);
    const action = command.action;
    if (action.type === "validate") {
      if (workflowId) {
        dispatchWorkspaceCommand("validate", { workflowId });
      } else {
        router.push(maybeEmbedDeepLink("/workflows", embed));
      }
      return;
    }
    if (action.type === "normalize") {
      if (workflowId) {
        dispatchWorkspaceCommand("normalize", { workflowId });
      }
      return;
    }
    if (action.type === "publish") {
      if (workflowId) {
        dispatchWorkspaceCommand("publish", { workflowId });
      }
      return;
    }
    if (action.type === "test-run") {
      if (workflowId) {
        dispatchWorkspaceCommand("test-run", { workflowId });
      }
      return;
    }
    if (action.type === "run-published") {
      if (workflowId) {
        dispatchWorkspaceCommand("run-published", { workflowId });
      }
      return;
    }
    if (action.type === "new-workflow") {
      if (isWorkflowHomePath(pathname)) {
        dispatchWorkspaceCommand("new-workflow");
        return;
      }
      router.push(maybeEmbedDeepLink("/workflows?create=1", embed));
      return;
    }
    if (action.type === "import-yaml") {
      if (isWorkflowHomePath(pathname)) {
        dispatchWorkspaceCommand("import-yaml");
        return;
      }
      router.push(maybeEmbedDeepLink("/workflows?import=1", embed));
      return;
    }
    const href = commandHref(action);
    if (href) {
      router.push(maybeEmbedDeepLink(href, embed));
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen(true);
          setQuery("");
          setHighlight(0);
        }}
        id="command-palette-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="command-palette-dialog"
        className="ff-shell-control shrink-0 px-3 py-1.5 text-sm font-medium"
      >
        Commands
      </button>
      {open ? (
        <Dialog
          id="command-palette-dialog"
          className="ff-shell-scrim fixed inset-0 z-50 flex items-start justify-center px-4 pt-24"
          label="Command palette"
          onClose={closePalette}
          returnFocusTo="command-palette-trigger"
          restoreFocus="target"
          onClick={() => closePalette()}
        >
      <div
        className="ff-shell-panel w-full max-w-lg p-3 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <Field
          id="command-palette-filter"
          label={PALETTE_INPUT_LABEL}
          className="block"
          labelClassName="sr-only"
        >
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            placeholder="Type a command…"
            className="ff-shell-control w-full px-3 py-2 text-sm"
            role="combobox"
            aria-expanded
            aria-controls={PALETTE_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              highlighted ? `command-${highlighted.id}` : undefined
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
                event.preventDefault();
                setHighlight((current) =>
                  paletteHighlightIndex(current, event.key, visible.length),
                );
                return;
              }
              if (event.key === "Enter" && highlighted) {
                event.preventDefault();
                run(highlighted.id);
              }
            }}
          />
        </Field>
        <ul
          id={PALETTE_RESULTS_ID}
          role="listbox"
          aria-label="Commands"
          className="mt-2 max-h-80 overflow-auto"
        >
          {visible.length === 0 ? (
            <li className="ff-shell-muted px-2 py-2 text-sm">No commands</li>
          ) : (
            visible.map((command, index) => (
              <li key={command.id} role="presentation">
                <button
                  type="button"
                  id={`command-${command.id}`}
                  role="option"
                  aria-selected={index === highlight}
                  onClick={() => run(command.id)}
                  className={
                    index === highlight
                      ? "ff-nav-item ff-nav-item-active flex w-full flex-col px-2 py-2 text-left"
                      : "ff-nav-item flex w-full flex-col px-2 py-2 text-left"
                  }
                >
                  <span className="text-sm font-medium">
                    {command.label}
                  </span>
                  <span
                    className={
                      index === highlight
                        ? "text-xs text-[var(--ff-accent-foreground)]"
                        : "ff-shell-muted text-xs"
                    }
                  >
                    {command.hint}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="ff-shell-muted mt-2 px-1 text-[11px]">
          {PALETTE_SHORTCUT_HELP}
        </p>
      </div>
        </Dialog>
      ) : null}
    </>
  );
}
