"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/shell/WorkspaceProvider";
import {
  commandHref,
  filterPaletteCommands,
  isWorkflowHomePath,
  paletteCommands,
} from "@/lib/command-palette";
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
  const { permissions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const workflowId = workflowIdFromPath(pathname);
  const executionId = executionIdFromPath(pathname);
  const commands = useMemo(
    () => paletteCommands(permissions, { workflowId, executionId }),
    [permissions, workflowId, executionId],
  );
  const visible = filterPaletteCommands(commands, query);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        setOpen((current) => !current);
        setQuery("");
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function run(id: string) {
    const command = commands.find((item) => item.id === id);
    if (!command) {
      return;
    }
    setOpen(false);
    setQuery("");
    const action = command.action;
    if (action.type === "validate") {
      dispatchWorkspaceCommand("validate");
      if (!workflowId) {
        router.push("/workflows");
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
      router.push("/workflows?create=1");
      return;
    }
    if (action.type === "import-yaml") {
      if (isWorkflowHomePath(pathname)) {
        dispatchWorkspaceCommand("import-yaml");
        return;
      }
      router.push("/workflows?import=1");
      return;
    }
    const href = commandHref(action);
    if (href) {
      router.push(href);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setQuery("");
        }}
        id="command-palette-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
      >
        Commands
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/40 px-4 pt-24"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={() => setOpen(false)}
        >
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-3 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a command…"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          onKeyDown={(event) => {
            if (event.key === "Enter" && visible[0]) {
              run(visible[0].id);
            }
          }}
        />
        <ul className="mt-2 max-h-80 overflow-auto">
          {visible.length === 0 ? (
            <li className="px-2 py-2 text-sm text-zinc-500">No commands</li>
          ) : (
            visible.map((command) => (
              <li key={command.id}>
                <button
                  type="button"
                  onClick={() => run(command.id)}
                  className="flex w-full flex-col rounded-lg px-2 py-2 text-left hover:bg-zinc-50"
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
          Esc to close · Ctrl+Shift+K
        </p>
      </div>
        </div>
      ) : null}
    </>
  );
}
