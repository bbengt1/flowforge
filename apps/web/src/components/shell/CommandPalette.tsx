"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { maybeEmbedDeepLink } from "@/lib/embed-tenancy-contract";
import { dispatchWorkspaceCommand } from "@/lib/workspace-commands";

function workflowIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/workflows\/([^/]+)$/);
  return match?.[1] && match[1] !== "new" ? match[1] : undefined;
}

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

  const workflowId = workflowIdFromPath(pathname);
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
      dispatchWorkspaceCommand("validate");
      if (!workflowId) {
        router.push(maybeEmbedDeepLink("/workflows", embed));
      }
      return;
    }
    if (action.type === "publish") {
      dispatchWorkspaceCommand("publish");
      return;
    }
    if (action.type === "run-published") {
      dispatchWorkspaceCommand("run-published");
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
        className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
      >
        Commands
      </button>
      {open ? (
        <div
          id="command-palette-dialog"
          className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/40 px-4 pt-24"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={() => closePalette()}
        >
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-3 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <label className="block">
          <span className="sr-only">{PALETTE_INPUT_LABEL}</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            placeholder="Type a command…"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
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
        </label>
        <ul
          id={PALETTE_RESULTS_ID}
          role="listbox"
          aria-label="Commands"
          className="mt-2 max-h-80 overflow-auto"
        >
          {visible.length === 0 ? (
            <li className="px-2 py-2 text-sm text-zinc-500">No commands</li>
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
                      ? "flex w-full flex-col rounded-lg bg-zinc-100 px-2 py-2 text-left"
                      : "flex w-full flex-col rounded-lg px-2 py-2 text-left hover:bg-zinc-50"
                  }
                >
                  <span className="text-sm font-medium text-zinc-900">
                    {command.label}
                  </span>
                  <span className="text-xs text-zinc-500">{command.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="mt-2 px-1 text-[11px] text-zinc-500">
          {PALETTE_SHORTCUT_HELP}
        </p>
      </div>
        </div>
      ) : null}
    </>
  );
}
