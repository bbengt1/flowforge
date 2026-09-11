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
  EDITOR_LIBRARY_SATELLITE_ID,
  EDITOR_LIBRARY_SATELLITE_WIDTH,
} from "@/lib/editor-library";
import {
  EDITOR_NDV_COLUMN_WIDTH,
  EDITOR_NDV_SATELLITE_ID,
  EDITOR_NDV_SATELLITE_LABEL,
  EDITOR_NDV_SATELLITE_WIDTH,
} from "@/lib/editor-ndv";

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
            data-editor-library="drawer"
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
        ) : (
          <aside
            aria-label="Action library"
            data-editor-library="satellite"
            className="flex w-full shrink-0 items-center justify-center border-zinc-200 bg-white max-md:!w-full max-md:border-b md:flex-col md:border-r"
            style={{ width: EDITOR_LIBRARY_SATELLITE_WIDTH }}
          >
            <button
              type="button"
              id={EDITOR_LIBRARY_SATELLITE_ID}
              onClick={onToggleLibrary}
              aria-expanded={false}
              aria-controls={EDITOR_LIBRARY_PANEL_ID}
              className="rounded-md px-2 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50 md:[writing-mode:vertical-rl] md:rotate-180 md:px-1 md:py-3"
            >
              Library
            </button>
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{canvas}</div>
          {yaml}
        </div>
        {inspectorOpen ? (
          <aside
            id={EDITOR_INSPECTOR_PANEL_ID}
            aria-label="Inspector"
            data-editor-inspector="drawer"
            className="order-first flex max-h-[46%] w-full shrink-0 flex-col overflow-auto border-zinc-200 bg-white max-md:!w-full max-md:border-b md:order-none md:max-h-none md:border-l"
            style={{ width: EDITOR_NDV_COLUMN_WIDTH }}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
              <p className="text-sm font-medium text-zinc-800">
                {EDITOR_NDV_SATELLITE_LABEL}
              </p>
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
        ) : (
          <aside
            aria-label="Inspector"
            data-editor-inspector="satellite"
            className="order-first flex w-full shrink-0 items-center justify-center border-zinc-200 bg-white max-md:!w-full max-md:border-b md:order-none md:flex-col md:border-l"
            style={{ width: EDITOR_NDV_SATELLITE_WIDTH }}
          >
            <button
              type="button"
              id={EDITOR_NDV_SATELLITE_ID}
              onClick={onToggleInspector}
              aria-expanded={false}
              aria-controls={EDITOR_DRAWER_PANEL_IDS.inspector}
              className="rounded-md px-2 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50 md:[writing-mode:vertical-rl] md:px-1 md:py-3"
            >
              {EDITOR_NDV_SATELLITE_LABEL}
            </button>
          </aside>
        )}
        {runs}
      </div>
      {overlays}
    </div>
  );
}
