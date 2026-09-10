"use client";

import type { ReactNode } from "react";
import {
  EDITOR_LIBRARY_COLUMN_WIDTH,
  EDITOR_LIBRARY_PANEL_ID,
} from "@/lib/editor-library";

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
  runs?: ReactNode;
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
  runs,
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
            className="flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white"
            style={{ width: EDITOR_LIBRARY_COLUMN_WIDTH }}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
              <p className="text-sm font-medium text-zinc-800">Library</p>
              <button
                type="button"
                onClick={onToggleLibrary}
                aria-expanded
                aria-controls={EDITOR_LIBRARY_PANEL_ID}
                className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"
              >
                Hide
              </button>
            </div>
            <div id={EDITOR_LIBRARY_PANEL_ID} className="min-h-0 flex-1 overflow-auto">
              {library}
            </div>
          </aside>
        ) : null}
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
        {runs}
      </div>
      {overlays}
    </div>
  );
}
