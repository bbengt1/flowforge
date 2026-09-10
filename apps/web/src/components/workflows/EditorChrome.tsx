"use client";

import type { ReactNode } from "react";
import {
  EDITOR_DRAWER_PANEL_IDS,
  EDITOR_INSPECTOR_PANEL_ID,
  EDITOR_SELECTION_STATUS_ID,
} from "@/lib/e12-accessibility-contract";
import {
  EDITOR_LIBRARY_COLUMN_WIDTH,
  EDITOR_LIBRARY_PANEL_ID,
} from "@/lib/editor-library";

type EditorChromeProps = {
  identityGate?: ReactNode;
  topBar: ReactNode;
  banners?: ReactNode;
  libraryOpen: boolean;
  inspectorOpen: boolean;
  selectionAnnouncement?: string;
  onToggleLibrary: () => void;
  onToggleInspector: () => void;
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
  inspectorOpen,
  selectionAnnouncement = "",
  onToggleLibrary,
  onToggleInspector,
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
      <p
        id={EDITOR_SELECTION_STATUS_ID}
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {selectionAnnouncement}
      </p>
      {banners ? (
        <div className="shrink-0 space-y-2 border-b border-zinc-200 px-3 py-2">
          {banners}
        </div>
      ) : null}
      <div
        data-editor-breakpoint="inspector-first"
        className="flex min-h-0 flex-1 flex-col md:flex-row"
      >
        {libraryOpen ? (
          <aside
            aria-label="Action library"
            className="flex w-full shrink-0 flex-col overflow-hidden border-zinc-200 bg-white max-md:!w-full max-md:border-b md:border-r"
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
        {inspectorOpen ? (
          <aside
            id={EDITOR_INSPECTOR_PANEL_ID}
            aria-label="Inspector"
            className="order-first flex max-h-[46%] w-full shrink-0 flex-col overflow-auto border-zinc-200 bg-white max-md:border-b md:order-none md:max-h-none md:w-80 md:border-l"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 md:hidden">
              <p className="text-sm font-medium text-zinc-800">Inspector</p>
              <button
                type="button"
                onClick={onToggleInspector}
                aria-expanded
                aria-controls={EDITOR_DRAWER_PANEL_IDS.inspector}
                className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50"
              >
                Hide
              </button>
            </div>
            {inspector}
          </aside>
        ) : null}
        {runs}
      </div>
      {overlays}
    </div>
  );
}
