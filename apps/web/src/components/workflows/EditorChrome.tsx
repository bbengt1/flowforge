"use client";

import type { ReactNode } from "react";

type EditorChromeProps = {
  identityGate?: ReactNode;
  topBar: ReactNode;
  banners?: ReactNode;
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  library: ReactNode;
  canvas: ReactNode;
  yaml: ReactNode;
  inspector: ReactNode;
  overlays?: ReactNode;
};

export function EditorChrome({
  identityGate,
  topBar,
  banners,
  libraryOpen,
  onToggleLibrary,
  library,
  canvas,
  yaml,
  inspector,
  overlays,
}: EditorChromeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      {identityGate}
      {topBar}
      {banners ? (
        <div className="shrink-0 space-y-2 border-b border-zinc-200 px-3 py-2">
          {banners}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {libraryOpen ? (
          <aside
            aria-label="Action library"
            className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
              <p className="text-sm font-medium text-zinc-800">Library</p>
              <button
                type="button"
                onClick={onToggleLibrary}
                aria-expanded
                aria-controls="editor-library-panel"
                className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"
              >
                Hide
              </button>
            </div>
            <div id="editor-library-panel" className="min-h-0 flex-1 overflow-auto">
              {library}
            </div>
          </aside>
        ) : (
          <aside
            aria-label="Action library"
            className="flex w-10 shrink-0 flex-col items-center border-r border-zinc-200 bg-white py-2"
          >
            <button
              type="button"
              onClick={onToggleLibrary}
              aria-expanded={false}
              aria-controls="editor-library-panel"
              aria-label="Open action library"
              title="Open action library"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-teal-800 bg-teal-800 text-lg font-semibold leading-none text-white hover:bg-teal-900"
            >
              +
            </button>
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{canvas}</div>
          {yaml}
        </div>
        <aside
          aria-label="Inspector"
          className="flex w-80 shrink-0 flex-col overflow-auto border-l border-zinc-200 bg-white"
        >
          {inspector}
        </aside>
      </div>
      {overlays}
    </div>
  );
}
